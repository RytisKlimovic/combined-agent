"use strict";

import {
  buildRequest,
  buildContextBlock,
  composeUserText,
  runChat,
  FIELDS_LABEL,
  LANGUAGES,
  languageName,
  modelsUrl,
} from "./llm.js";
import { grabPageContext, grabFullDocument, getActiveTab } from "./context.js";
import { grabPdfText, loadPdf, extractText, renderPage } from "./pdftext.js";
import { isScanned, ocrPages } from "./lib/ocr.js";
import { officeKind, officeText } from "./lib/office.js";
import { googleExportUrl, sharepointDownloadUrl, fetchDocument } from "./lib/cloud.js";
import { pickPresets, deriveSignals } from "./presets.js";
import { addEntry, getRecent, search as searchHistory, deleteEntry, clearAll } from "./db.js";
import { renderMarkdown, stripMarkdown } from "./md.js";
import {
  DEFAULTS,
  ENDPOINTS,
  isClinicalUrl,
  isLocalEndpoint,
  getSettings,
  saveSettings as persistSettings,
  resetSettings,
} from "./lib/settings.js";
import { runAgent } from "./lib/agent.js";

// Loaded as classic scripts in sidepanel.html (same files the content script uses).
const { Dictation } = globalThis.SCRIBE_DICT;

const $ = (id) => document.getElementById(id);
const els = {
  lang: $("lang"),
  withText: $("withText"),
  wholeDoc: $("wholeDoc"),
  gear: $("gear"),
  settings: $("settings"),
  newBtn: $("newBtn"),
  msgs: $("msgs"),
  empty: $("empty"),
  input: $("input"),
  send: $("send"),
  chips: $("chips"),
  dot: $("dot"),
  meta: $("meta"),
  thumbBar: $("thumbBar"),
  thumbImg: $("thumbImg"),
  thumbNote: $("thumbNote"),
  watchEvery: $("watchEvery"),
  watchPrompt: $("watchPrompt"),
  watchOnlyDone: $("watchOnlyDone"),
  watchToggle: $("watchToggle"),
  watchStatus: $("watchStatus"),
  histSearch: $("histSearch"),
  histList: $("histList"),
  histClear: $("histClear"),
  histCount: $("histCount"),
  tabWatch: $("tabWatch"),
  connBanner: $("connBanner"),
  connReason: $("connReason"),
  connSetup: $("connSetup"),
  mic: $("mic"),
  doc: $("doc"),
  docFile: $("docFile"),
  drop: $("drop"),
  ocrPagesLimit: $("ocrPages"),
  llmEndpoint: $("llmEndpoint"),
  llmModel: $("llmModel"),
  llmKey: $("llmKey"),
  asrEndpoint: $("asrEndpoint"),
  backendTest: $("backendTest"),
  backendReset: $("backendReset"),
  backendStatus: $("backendStatus"),
  backendWarn: $("backendWarn"),
  openFormsInTab: $("openFormsInTab"),
  agentMode: $("agentMode"),
  histNote: $("histNote"),
  mfConn: $("mfConn"),
  mfAsr: $("mfAsr"),
  mfPage: $("mfPage"),
  mfTest: $("mfTest"),
  mfFields: $("mfFields"),
  mfDictateAll: $("mfDictateAll"),
  metricsOn: $("metricsOn"),
  metricsCount: $("metricsCount"),
  metricsSync: $("metricsSync"),
  metricsFlush: $("metricsFlush"),
  metricsExport: $("metricsExport"),
  metricsClear: $("metricsClear"),
};

// ---- metrics --------------------------------------------------------------
//
// The panel does NOT write metrics directly: everything goes through the
// service worker, the only place with sanitize() and storage (see
// lib/metrics.js). Here we only send an event and drive the user's toggle.

function sendMetric(event, data) {
  chrome.runtime.sendMessage({ type: "METRIC", event, data }).catch(() => {});
}

/** The error CATEGORY. Message text never goes into metrics. */
function chatErrorKind(err) {
  const msg = err?.message || String(err ?? "");
  if (/Failed to fetch|NetworkError/i.test(msg)) return "network";
  if (/\b(401|403)\b/.test(msg)) return "auth";
  if (/\b404\b/.test(msg)) return "notfound";
  if (/JSON|parse/i.test(msg)) return "parse";
  return "other";
}

// The model server, configured in Settings and stored in chrome.storage.local
// (see lib/settings.js). Mirrored here so the many buildRequest call sites stay
// synchronous; `loadBackend()` is the only writer.
const backend = {
  format: "openai",
  base: DEFAULTS.vllmEndpoint,
  model: DEFAULTS.model,
  apikey: DEFAULTS.apiKey,
};

/** The three values ocr.js and the agent need, in the shape they expect. */
const llmConfig = () => ({ endpoint: backend.base, model: backend.model, apikey: backend.apikey });

async function loadBackend() {
  const s = await getSettings();
  backend.base = s.vllmEndpoint;
  backend.model = s.model;
  backend.apikey = s.apiKey;
  serverReachable = false; // a new server has to prove itself
  return s;
}

/**
 * Reachability check against the OpenAI-compatible `/models` endpoint. Cached
 * after the first success so normal sends cost one request, not two.
 *
 * Several providers do not implement `/models`, so only a transport failure or
 * an explicit 401/403 counts as "cannot use this server". Any other status
 * means the server answered, and the real send will surface its own error with
 * far better detail than a pre-flight ever could.
 */
let serverReachable = false;
async function ensureModel() {
  if (serverReachable) return backend.model;
  if (!backend.base) throw new Error("No model endpoint configured.");

  const res = await fetch(modelsUrl(backend.base), {
    headers: backend.apikey ? { Authorization: `Bearer ${backend.apikey}` } : {},
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`The model server rejected the API key (HTTP ${res.status}).`);
  }
  serverReachable = true;
  return backend.model;
}

// Current capture + running conversation. `convo` holds neutral turns
// ({ role, text, image? }); the screenshot rides only on the first user turn.
// `nextPreset` is set right before a preset-driven send so the reply can offer
// the right Copy/Download actions.
// `view` mirrors `convo` with the texts as SHOWN (the model turns carry the page
// context block, which nobody wants to read back) — it's what a restored panel
// re-renders. `abort` cancels the in-flight request.
// The active page's form fields, shared by the Form view and the chat's
// "Insert into field". Kept current whichever view is open — the chat option
// used to be decided once, when the answer was written, and stayed missing if
// the form finished loading a moment later.
let medFields = [];

const state = {
  shot: null,
  convo: [],
  view: [],
  busy: false,
  nextPreset: null,
  lang: "en",
  abort: null,
  agent: true, // agent mode (tools) — on by default; toggled in Settings
};

// ---- views (Chat / History / Watch / Settings) ----------------------------

const viewTabs = Array.from(document.querySelectorAll(".viewtab, .icontab"));
const viewSections = Array.from(document.querySelectorAll(".view"));

function activateView(name) {
  for (const s of viewSections) s.classList.toggle("is-active", s.dataset.view === name);
  for (const t of viewTabs) {
    const on = t.dataset.view === name;
    t.classList.toggle("is-active", on);
    if (t.hasAttribute("role")) t.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (name === "history") {
    refreshHistory();
    els.histSearch.focus();
  } else if (name === "chat") {
    els.input.focus();
  } else if (name === "form") {
    refreshFormView();
  } else if (name === "settings") {
    refreshMetricsView();
  }
}

viewTabs.forEach((t) => t.addEventListener("click", () => activateView(t.dataset.view)));

// ---- connection + context state -------------------------------------------

// The banner shows only when the configured model server can't be reached. It
// carries the reason, because with a user-supplied endpoint "unavailable" could
// mean a typo, a stopped server or a rejected key — three different fixes.
async function checkConnection() {
  try {
    await ensureModel();
    els.connBanner.classList.remove("show");
    return true;
  } catch (err) {
    els.connReason.textContent = err?.message || "Check the endpoint in Settings ⚙.";
    els.connBanner.classList.add("show");
    return false;
  }
}

els.connSetup.addEventListener("click", () => checkConnection());

// ---- settings -------------------------------------------------------------
//
// The context is always complete: "whole page" + "page text". Those two hidden
// inputs stay permanently on (the controls were removed from the UI) and the
// rest of the logic reads them unchanged.
//
// Two groups of settings, stored in the same place but read differently. The
// UI-only ones (language, page limit, toggles) are read straight from
// chrome.storage here. The model-server ones go through lib/settings.js,
// because the service worker reads those too and there must be exactly one
// definition of what "configured" means.

function applySettings(s) {
  state.lang = LANGUAGES[s.lang] ? s.lang : "en";
  els.lang.value = state.lang;
  els.withText.checked = true;
  els.wholeDoc.checked = true;
  if (s.ocrPages) els.ocrPagesLimit.value = s.ocrPages;
  els.openFormsInTab.checked = s.openFormsInTab !== false; // default true
  state.agent = s.agentMode !== false; // default true
  els.agentMode.checked = state.agent;
}

function loadSettings() {
  chrome.storage.local.get(["lang", "ocrPages", "openFormsInTab", "agentMode"], applySettings);
}

function saveSettings() {
  chrome.storage.local.set({
    lang: els.lang.value,
    ocrPages: pageLimit(),
    openFormsInTab: els.openFormsInTab.checked,
    agentMode: els.agentMode.checked,
  });
}

// ---- the model server -----------------------------------------------------

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "—");
  }
};

function setBackendStatus(text, kind = "unknown") {
  els.backendStatus.querySelector(".dot").dataset.state = kind;
  els.backendStatus.querySelector(".status-text").textContent = text;
}

/**
 * A cloud endpoint means page content — which in a clinical deployment is
 * patient data — leaves this machine. Shown, not blocked: the choice is the
 * user's, but it must be a choice rather than an accident.
 */
function refreshBackendWarning() {
  const url = els.llmEndpoint.value.trim() || DEFAULTS.vllmEndpoint;
  els.backendWarn.hidden = isLocalEndpoint(url);
}

/** Fills the form from storage and points `backend` at the same values. */
async function loadBackendSettings() {
  const s = await loadBackend();
  els.llmEndpoint.value = s.vllmEndpoint;
  els.llmModel.value = s.model;
  els.llmKey.value = s.apiKey;
  els.asrEndpoint.value = s.asrEndpoint;
  refreshBackendWarning();
  setBackendStatus("Not tested yet.");
}

/** Persists the form, re-points `backend`, and re-runs the connection check. */
async function saveBackendSettings() {
  await persistSettings({
    vllmEndpoint: els.llmEndpoint.value,
    model: els.llmModel.value,
    apiKey: els.llmKey.value,
    asrEndpoint: els.asrEndpoint.value,
  });
  await loadBackend();
  refreshBackendWarning();
  // A new server invalidates the cached capture-time answer, and the banner
  // must not keep complaining about the previous one.
  checkConnection();
}

async function testBackend() {
  els.backendTest.disabled = true;
  setBackendStatus("Testing…", "unknown");
  await saveBackendSettings();

  const res = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }).catch(() => null);
  els.backendTest.disabled = false;

  if (!res) return setBackendStatus("The extension did not answer. Try reloading it.", "bad");

  if (res.ok) {
    const models = res.models ?? [];
    const named = models.includes(backend.model);
    // A server that lists its models AND does not list this one is the single
    // most common misconfiguration, and the error it would otherwise produce
    // (a 404 from deep inside a stream) says nothing useful.
    if (models.length && !named) {
      return setBackendStatus(
        `Connected to ${hostOf(backend.base)}, but "${backend.model}" is not in its model list. ` +
          `Available: ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}`,
        "warn"
      );
    }
    const note = models.length
      ? `${models.length} model(s) available`
      : res.error || "the server does not list models";
    return setBackendStatus(`Connected to ${hostOf(backend.base)} · ${note}`, "ok");
  }

  setBackendStatus(res.error || "Could not reach the model server.", "bad");
}

els.backendTest.addEventListener("click", testBackend);

// `change` rather than `input`: saving on every keystroke would re-point the
// backend at half-typed URLs.
for (const el of [els.llmEndpoint, els.llmModel, els.llmKey, els.asrEndpoint]) {
  el.addEventListener("change", () => {
    saveBackendSettings();
    setBackendStatus("Changed — press Test connection.", "unknown");
  });
}
els.llmEndpoint.addEventListener("input", refreshBackendWarning);

els.backendReset.addEventListener("click", async () => {
  await resetSettings();
  await loadBackendSettings();
  checkConnection();
});

els.ocrPagesLimit.addEventListener("change", saveSettings);
els.openFormsInTab.addEventListener("change", saveSettings);
els.agentMode.addEventListener("change", () => {
  state.agent = els.agentMode.checked;
  saveSettings();
});

els.lang.addEventListener("change", () => {
  state.lang = LANGUAGES[els.lang.value] ? els.lang.value : "en";
  saveSettings();
  refreshChipsForActiveTab();
});

// ---- capture --------------------------------------------------------------

function captureTab(windowId) {
  return new Promise((resolve, reject) => {
    // Higher quality so small table/grid text stays legible to the vision model.
    chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 92 }, (dataUrl) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!dataUrl) return reject(new Error("Capture returned nothing."));
      resolve(dataUrl);
    });
  });
}

// Try a list of candidate URLs (the tab itself, then any embedded PDFs) and
// return the first that yields text.
//
// A PDF gives up its text one of two ways: the text layer, or — when there is
// none, i.e. it is a scan — the vision model reading rendered pages. Both come
// off the SAME parsed document, so a scan is not downloaded twice.
// Reading a scan costs a minute of the doctor's time and a request per page.
// Every follow-up question re-reads the page context, so without this the same
// document would be transcribed again and again. Keyed by URL, few entries,
// dropped on "＋ New" — that is the way to force a fresh read (e.g. after Stop).
const scanCache = new Map(); // url → PDF text (text layer or OCR)
const docCache = new Map(); // url → cloud document context

function remember(cache, key, value) {
  cache.set(key, value);
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  return value;
}

const cacheScan = (url, value) => remember(scanCache, url, value);
const cacheDoc = (url, value) => remember(docCache, url, value);

async function firstPdfText(urls, maxChars) {
  for (const u of urls) {
    if (!u) continue;
    if (scanCache.has(u)) return scanCache.get(u);

    let pdf = null;
    try {
      pdf = await loadPdf(u);
      if (!pdf) continue;

      const layer = await extractText(pdf, { maxChars });
      if (!isScanned(layer)) {
        if (layer.text) return { ...layer, scanned: false };
        continue;
      }

      const scan = await readScannedPdf(pdf, { source: "tab" });
      if (!scan.text) continue;
      return cacheScan(u, {
        text: scan.text,
        chars: scan.text.length,
        pages: scan.pages,
        total: scan.total,
        aborted: scan.aborted,
        thumb: scan.thumb,
        scanned: true,
      });
    } catch (_) {
      /* not a PDF, blocked, or unreadable — try the next candidate */
    } finally {
      pdf?.destroy?.();
    }
  }
  return null;
}

// ---- cloud documents ------------------------------------------------------

// Google Docs / Sheets / Slides and Office for the web keep the document in a
// canvas or a virtualised grid; `grabFullDocument` comes back nearly empty. The
// fix is to fetch the real file with the user's own session (see lib/cloud.js)
// and read it like any other attachment.

const CLOUD_LABEL = {
  gdoc: "Google document",
  gsheet: "Google spreadsheet",
  gslides: "Google presentation",
  docx: "Word",
  xlsx: "Excel",
  pptx: "PowerPoint",
  pdf: "PDF",
};

/** Fetched bytes → text, without touching the conversation state. */
async function readCloudBytes({ buffer, name, type = "", kind }) {
  // Google Docs exports plain text; everything else arrives as a real file.
  if (kind === "gdoc") return { text: new TextDecoder().decode(buffer), kind, note: "" };

  // A SharePoint library holds PDFs too — including scanned ones.
  if (type.includes("pdf") || /\.pdf$/i.test(name)) {
    const pdf = await loadPdf(buffer);
    if (!pdf) throw new Error("Could not open the PDF file.");
    try {
      const layer = await extractText(pdf, { maxChars: 100000 });
      if (!isScanned(layer)) return { text: layer.text, kind: "pdf", note: `${layer.pages} pages` };
      const scan = await readScannedPdf(pdf, { source: "tab" });
      return { text: scan.text, kind: "pdf", note: `${scan.pages} pages` };
    } finally {
      pdf.destroy?.();
    }
  }

  const parsed = await officeText(buffer, { name, type });
  return { text: parsed.text, kind: kind || parsed.kind, note: parsed.note };
}

/**
 * @returns {Promise<{contextBlock, note, signals, noStore}|null>} null when the
 *   tab is not a cloud document (or the file could not be fetched)
 */
async function grabCloudDocument(tab) {
  const google = googleExportUrl(tab.url);
  const office = google ? null : sharepointDownloadUrl(tab.url);
  const target = google || office;
  if (!target) return null;

  if (docCache.has(target.url)) return docCache.get(target.url);

  const status = progressBubble();
  status.say(`Downloading the document… (${CLOUD_LABEL[google?.kind] || "Office"})`);
  const t0 = performance.now();

  try {
    const fetched = await fetchDocument(target.url, { signal: state.abort?.signal });
    const { text, kind, note } = await readCloudBytes({
      ...fetched,
      name: fetched.name || target.name,
      kind: google?.kind,
    });
    if (!text.trim()) throw new Error("No text found in the document.");

    sendMetric("doc.read", {
      kind,
      source: "tab",
      chars: text.length,
      ms: Math.round(performance.now() - t0),
      ok: true,
    });

    return cacheDoc(target.url, {
      contextBlock: buildContextBlock(
        { url: tab.url, title: tab.title || target.name, text },
        { maxText: 100000, textLabel: `Full document text (${CLOUD_LABEL[kind] || kind}):` },
      ),
      note: `${CLOUD_LABEL[kind] || kind}${note ? ` · ${note}` : ""} · ${text.length.toLocaleString()} chars`,
      fields: "",
      // A cloud document can hold patient data just like a clinical page.
      noStore: true,
      signals: deriveSignals({ url: tab.url }, { wholeDoc: true }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;

    sendMetric("doc.read", { kind: google?.kind || "docx", source: "tab", ok: false });

    // Best effort by design: SharePoint's download path is tenant-specific and
    // Google needs the right account signed in. Say what to do instead of
    // silently answering from a screenshot of a canvas.
    addBubble(
      "error",
      `Could not fetch the document (${err?.message || err}). ` +
        "Download a copy and drop it in via 📄 — or ask about what is visible on screen instead."
    );
    // Remembered as a failure too: without this, every follow-up question would
    // retry the same download and add the same error again.
    return cacheDoc(target.url, null);
  } finally {
    status.remove();
  }
}

/** Note + label for a PDF, whichever way its text was obtained. */
function pdfNote(pdf) {
  return pdf.scanned
    ? scanNote({ pages: pdf.pages, total: pdf.total, chars: pdf.chars, aborted: pdf.aborted })
    : `PDF text · ${pdf.chars.toLocaleString()} chars`;
}

// ---- UI helpers -----------------------------------------------------------

function addBubble(role, text) {
  els.empty.style.display = "none";
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  els.msgs.appendChild(el);
  scrollBottom();
  return el;
}

function scrollBottom() {
  els.msgs.scrollTop = els.msgs.scrollHeight;
}

// Replace a bubble's streamed plain text with rendered Markdown.
function renderInto(el, text) {
  el.classList.add("md");
  el.innerHTML = renderMarkdown(text);
}

// While a request runs, Send turns into Stop — there is no other way to cut a
// long stream short.
function busy(on) {
  state.busy = on;
  els.send.textContent = on ? "Stop" : "Send";
  els.send.classList.toggle("stop", on);
  els.mic.disabled = on;
  els.doc.disabled = on;
  els.dot.classList.toggle("live", on);
}

// A Word or Excel file has nothing to show — then the note stands on its own
// instead of a broken image frame.
function showThumb(dataUrl, note) {
  els.thumbImg.hidden = !dataUrl;
  if (dataUrl) els.thumbImg.src = dataUrl;
  els.thumbNote.textContent = note;
  els.thumbBar.classList.add("show");
}

// Clinical pages (the host EHR, or a demo form) may hold patient data, so
// nothing from them is written to disk or to session storage — the badge says so.
function markClinical(url) {
  els.histNote.hidden = !isClinicalUrl(url);
}

function resetConversation() {
  state.shot = null;
  state.convo = [];
  state.view = [];
  // A new conversation re-reads the document (that is also how a Stop halfway
  // through OCR is retried).
  scanCache.clear();
  docCache.clear();
  els.msgs.innerHTML = "";
  els.msgs.appendChild(els.empty);
  els.empty.style.display = "";
  els.thumbBar.classList.remove("show");
  els.histNote.hidden = true;
  els.meta.textContent = "";
  clearSession();
  els.input.focus();
}

els.newBtn.addEventListener("click", () => {
  if (state.busy) return;
  resetConversation();
  refreshChipsForActiveTab();
});

// ---- presets (context-aware chips) ----------------------------------------

function renderChips(signals) {
  // Presets are English; only the Translate target follows the answer language.
  const presets = pickPresets(signals, languageName(state.lang));
  els.chips.innerHTML = "";
  for (const p of presets) {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.title = p.prompt;
    b.addEventListener("click", () => {
      if (state.busy) return;
      state.nextPreset = p;
      els.input.value = p.prompt;
      send();
    });
    els.chips.appendChild(b);
  }
}

// Peek the active tab (no screenshot) so the chips reflect the page before the
// first capture. Cheap: just runs the context script.
async function refreshChipsForActiveTab() {
  try {
    const tab = await getActiveTab();
    if (!state.shot) markClinical(tab?.url || "");
    const ctx = tab ? await grabPageContext(tab.id, { maxChars: 3000 }) : null;
    // Whole-page mode skips the page peek, so hand it the URL directly —
    // otherwise a medical form would never be recognised as one.
    renderChips(
      deriveSignals(ctx ?? { url: tab?.url || "" }, { wholeDoc: els.wholeDoc.checked })
    );
  } catch (_) {
    renderChips(deriveSignals(null, { wholeDoc: els.wholeDoc.checked }));
  }
}

// The panel outlives the page it was opened on: chips must follow the tab you
// are actually looking at, not the one that was open when it launched.
let chipsTimer = null;
function scheduleChipsRefresh() {
  // An attached document owns the conversation — its chips must not be replaced
  // by whatever tab the doctor happens to click through meanwhile.
  if (state.busy || state.shot?.pinned) return;
  clearTimeout(chipsTimer);
  chipsTimer = setTimeout(() => refreshChipsForActiveTab(), 200);
}

// ---- Copy / Download of structured output ---------------------------------

// Models often wrap CSV/tables in ``` fences — strip them for clean output.
function stripFences(text) {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : text;
}

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  btn.classList.add("done");
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove("done");
  }, 1200);
}

function downloadText(text, ext) {
  const mime = ext === "csv" ? "text/csv" : "text/plain";
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `capture-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Copy is offered on every reply; Download only when a structured preset asked.
function addActions(bubbleEl, getText, preset) {
  const row = document.createElement("div");
  row.className = "actions";

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    const text = preset?.copy ? stripFences(getText()) : getText();
    try {
      await navigator.clipboard.writeText(text);
      flash(copyBtn, "Copied");
    } catch (_) {
      flash(copyBtn, "Failed");
    }
  });
  row.appendChild(copyBtn);

  if (preset?.download) {
    const dlBtn = document.createElement("button");
    dlBtn.textContent = `Download .${preset.download}`;
    dlBtn.addEventListener("click", () => {
      downloadText(stripFences(getText()), preset.download);
      flash(dlBtn, "Saved");
    });
    row.appendChild(dlBtn);
  }

  attachInsertAction(row, getText, bubbleEl);
  bubbleEl.appendChild(row);
}

// Chat answer → medical form. The list of fields is shared with the Form view
// and refreshed live, so an answer written before the form loaded still gets
// the option the moment the fields appear. The text goes into the SAME review
// overlay a generated draft uses — never straight into the form.
// A form field wants the sentence, not the essay: an answer usually carries a
// preamble, the reasoning and only then the text worth keeping. The model that
// wrote it pulls that part back out; markdown is stripped either way.
const EXTRACT_PROMPT =
  "You are preparing text to paste into a form field. Below is an assistant " +
  "answer. Output ONLY the exact text that belongs in the field named below — " +
  "nothing else.\n" +
  "- No preamble, no explanation, no commentary, no markdown, no quotes around it.\n" +
  "- Keep the original language and wording. Do NOT add, invent or infer anything.\n" +
  "- If the answer offers a corrected or final version, output that version only.\n" +
  "- If the answer contains nothing suitable for the field, output the answer's " +
  "core statement in one plain sentence.";

async function extractForField(answer, label) {
  const req = buildRequest({
    format: backend.format,
    base: backend.base,
    model: backend.model,
    apikey: backend.apikey,
    // No system prompt: it would pin a reply language and a screen-assistant
    // persona, and this call must return the source text untouched.
    system: "",
    messages: [
      { role: "user", text: `${EXTRACT_PROMPT}\n\nField: "${label}"\n\nAnswer:\n"""\n${answer}\n"""` },
    ],
    stream: false,
  });
  return stripMarkdown(stripFences(await runChat(req)));
}

/** Text the user highlighted inside this very bubble, if any. */
function selectionInside(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? sel.toString().trim() : "";
}

// row → what that bubble holds, so the widget can be rebuilt when the page's
// field list changes.
const insertHosts = new WeakMap();

function attachInsertAction(row, getText, bubbleEl) {
  row.dataset.insertHost = "1";
  insertHosts.set(row, { getText, bubbleEl });
  renderInsertAction(row);
}

/** Rebuild every answer's field list — cheap, and they all show the same page. */
function refreshInsertActions() {
  document.querySelectorAll(".actions[data-insert-host]").forEach(renderInsertAction);
}

function renderInsertAction(row) {
  const host = insertHosts.get(row);
  if (!host) return;

  row.querySelector(".insert-wrap")?.remove();
  if (!medFields.length) return;

  const { getText, bubbleEl } = host;
  const fields = medFields;

  const wrap = document.createElement("span");
  wrap.className = "insert-wrap";

  const btn = document.createElement("button");
  btn.textContent = "Insert into field ▾";
  btn.title = "Only the relevant part of the answer is inserted. Highlight text to insert exactly that instead.";

  const menu = document.createElement("div");
  menu.className = "insert-menu";
  menu.hidden = true;

  for (const f of fields) {
    const item = document.createElement("button");
    item.textContent = f.label;
    if (f.critical) item.classList.add("is-critical");
    item.addEventListener("click", async () => {
      menu.hidden = true;
      const label = btn.textContent;
      btn.disabled = true;

      // A highlighted piece of the answer is an explicit choice — take it as is.
      let text = selectionInside(bubbleEl);
      if (text) {
        text = stripMarkdown(text);
      } else {
        btn.textContent = "Preparing…";
        try {
          text = await extractForField(getText(), f.label);
        } catch (_) {
          text = stripMarkdown(getText()); // model unreachable — send it all
        }
      }

      btn.textContent = label;
      btn.disabled = false;
      const tab = await getActiveTab(); // resolved now, not when the bubble was built
      const res = tab?.id ? await askTab(tab.id, { type: "INSERT_TEXT", fieldKey: f.key, text }) : null;
      flash(btn, res?.ok ? "To review →" : "Failed");
    });
    menu.appendChild(item);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeInsertMenus();
    if (open) placeInsertMenu(btn, menu);
  });
  wrap.append(btn, menu);
  row.appendChild(wrap);
}

// Pin the list to the button in viewport coordinates, on whichever side has
// room, and cap it to that room — a 16-field form used to overflow the panel
// and get clipped by the message list.
function placeInsertMenu(btn, menu) {
  const gap = 4;
  const margin = 8;
  menu.hidden = false;

  const r = btn.getBoundingClientRect();
  const above = r.top - margin - gap;
  const below = window.innerHeight - r.bottom - margin - gap;
  const openUp = above > below;

  menu.style.maxHeight = `${Math.max(96, Math.min(300, openUp ? above : below))}px`;

  const width = Math.min(260, window.innerWidth - 2 * margin);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(margin, Math.min(r.left, window.innerWidth - width - margin))}px`;

  if (openUp) {
    menu.style.top = "auto";
    menu.style.bottom = `${window.innerHeight - r.top + gap}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${r.bottom + gap}px`;
  }
}

function closeInsertMenus() {
  document.querySelectorAll(".insert-menu").forEach((m) => (m.hidden = true));
}
// Click anywhere else closes an open field list. So does scrolling or resizing:
// the list is pinned to viewport coordinates and would otherwise drift.
document.addEventListener("click", closeInsertMenus);
els.msgs.addEventListener("scroll", closeInsertMenus);
window.addEventListener("resize", closeInsertMenus);

// A failed request keeps its prompt: one click puts it back and re-sends.
function addRetry(bubbleEl, prompt, preset) {
  const row = document.createElement("div");
  row.className = "actions";
  const btn = document.createElement("button");
  btn.textContent = "Try again";
  btn.addEventListener("click", () => {
    if (state.busy) return;
    bubbleEl.remove();
    els.input.value = prompt;
    state.nextPreset = preset || null;
    send();
  });
  row.appendChild(btn);
  bubbleEl.appendChild(row);
}

// ---- scanned documents ----------------------------------------------------

// A scanned PDF has no text layer, so the pages are rendered to images and the
// vision model transcribes them one by one. That takes real time, so the
// progress is a live bubble in the conversation and Stop cancels it — whatever
// was already read stays usable.

function pageLimit() {
  const n = parseInt(els.ocrPagesLimit.value, 10);
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : 20));
}

function progressBubble() {
  const el = addBubble("assistant", "");
  el.classList.add("busy");
  return {
    say: (text) => {
      el.textContent = text;
      scrollBottom();
    },
    remove: () => el.remove(),
  };
}

/**
 * Read a scanned PDF: render pages → model → text.
 *
 * @param {object} pdf — pdf.js document (caller owns it)
 * @param {object} opts
 * @param {"tab"|"file"} opts.source — metrics only
 * @returns {Promise<{text: string, pages: number, total: number, aborted: boolean, thumb: string}>}
 */
async function readScannedPdf(pdf, { source }) {
  const total = pdf.numPages;
  const count = Math.min(total, pageLimit());
  const progress = progressBubble();
  const startedAt = performance.now();

  progress.say(`Reading the document · 0/${count} pages…`);

  let thumb = "";
  let result;
  try {
    result = await ocrPages({
      count,
      getImage: async (i) => {
        const image = await renderPage(pdf, i + 1);
        if (i === 0) thumb = image; // first page doubles as the conversation's thumbnail
        return image;
      },
      onProgress: (done) => progress.say(`Reading the document · ${done}/${count} pages…`),
      signal: state.abort?.signal,
      concurrency: 2,
      llm: llmConfig(),
    });
  } finally {
    progress.remove(); // never leave a dangling "reading…" bubble behind
  }

  sendMetric("doc.ocr", {
    pages: result.pages,
    ms: Math.round(performance.now() - startedAt),
    chars: result.text.length,
    aborted: result.aborted,
    source,
  });

  return { ...result, total, thumb };
}

/** `scanned PDF · 12 pages · 18,420 chars` (or `20 of 47 pages` at the limit). */
function scanNote({ pages, total, chars, aborted }) {
  const of = pages < total ? ` ${pages} of ${total} pages` : ` ${pages} pages`;
  return `scanned PDF ·${of} · ${chars.toLocaleString()} chars${aborted ? " · cancelled" : ""}`;
}

// ---- attaching a document from disk ---------------------------------------

// Reading the file here, in the panel, sidesteps "Allow access to file URLs" —
// the setting that otherwise blocks file:// PDFs — and needs no permission at
// all. The attached document becomes the conversation's subject until "＋ New".

/** Same ceiling a rendered PDF page gets: legible, but not a wall of tokens. */
async function downscaleForOcr(dataUrl, maxPx = 1600) {
  try {
    const img = await loadImage(dataUrl);
    const longest = Math.max(img.width, img.height);
    if (!longest || longest <= maxPx) return dataUrl;

    const scale = maxPx / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch (_) {
    return dataUrl; // unreadable dimensions — let the model try the original
  }
}

function bytesToDataUrl(buffer, type) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Could not read the file."));
    fr.readAsDataURL(new Blob([buffer], { type }));
  });
}

/**
 * Turn a document's bytes into the conversation's subject: PDF (text layer or
 * OCR), Office file, or a photo of a page. One entry point for all three ways a
 * document can arrive — picked from disk, dropped on the panel, or fetched from
 * a link / cloud storage.
 *
 * @param {{name: string, type?: string, buffer: ArrayBuffer, source: "file"|"link"|"tab"}} doc
 */
async function attachBytes({ name, type = "", buffer, source }) {
  const isPdf = type.includes("pdf") || /\.pdf$/i.test(name);
  const office = officeKind(name, type);
  const isImage = type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);

  if (!isPdf && !office && !isImage) {
    throw new Error(`Unsupported format: ${name}. PDF, Word, Excel, PowerPoint or an image will work.`);
  }

  const t0 = performance.now();
  let text = "";
  let note = "";
  let image = "";
  let kind = office || (isPdf ? "pdf" : "image");

  if (isPdf) {
    const pdf = await loadPdf(buffer);
    if (!pdf) throw new Error("Could not open the PDF file.");
    try {
      const layer = await extractText(pdf, { maxChars: 100000 });
      if (isScanned(layer)) {
        const scan = await readScannedPdf(pdf, { source });
        text = scan.text;
        image = scan.thumb;
        note = scanNote({ pages: scan.pages, total: scan.total, chars: text.length, aborted: scan.aborted });
      } else {
        text = layer.text;
        image = await renderPage(pdf, 1).catch(() => "");
        note = `PDF · ${layer.pages} pages · ${layer.chars.toLocaleString()} chars`;
      }
    } finally {
      pdf.destroy?.();
    }
  } else if (office) {
    const parsed = await officeText(buffer, { name, type });
    text = parsed.text;
    const label = CLOUD_LABEL[parsed.kind] || parsed.kind;
    // `note` states how many rows/sheets actually made it in — without it a
    // truncation would be invisible.
    note = `${label} · ${parsed.note} · ${text.length.toLocaleString()} chars`;
    if (!text.trim()) throw new Error(`No text found in the ${label} document.`);
  } else {
    // A photographed / scanned single page: the model reads the image itself.
    // Phone photos are 4000 px wide — cap them like a rendered PDF page.
    image = await downscaleForOcr(await bytesToDataUrl(buffer, type || "image/jpeg"));
    const scan = await ocrPages({
      count: 1,
      getImage: async () => image,
      signal: state.abort?.signal,
      llm: llmConfig(),
    });
    text = scan.text;
    note = `scanned image · ${text.length.toLocaleString()} chars${scan.aborted ? " · cancelled" : ""}`;
    sendMetric("doc.ocr", {
      pages: scan.pages,
      ms: Math.round(performance.now() - t0),
      chars: text.length,
      aborted: scan.aborted,
      source,
    });
  }

  if (!text.trim() && !image) throw new Error("No text found in the document.");

  sendMetric("doc.read", {
    kind,
    source,
    chars: text.length,
    ms: Math.round(performance.now() - t0),
    ok: true,
  });

  state.shot = {
    dataUrl: image,
    contextBlock: buildContextBlock(
      { title: name, text },
      {
        maxText: 100000,
        textLabel: "Text read from the attached document (OCR — may contain reading errors):",
      }
    ),
    note,
    meta: { url: "", title: name },
    // Attached by hand or fetched: not tied to a tab, and patient documents
    // never go to disk.
    pinned: true,
    noStore: true,
  };

  showThumb(image, note);
  els.histNote.hidden = false;
  renderChips(deriveSignals(null, { wholeDoc: true }));
  addBubble("watch", `📄 ${name} — ${note}`);
  els.input.focus();
}

/** Wrap `attachBytes` with the shared UI states so every caller behaves alike. */
async function runAttach(work) {
  if (state.busy) return;
  resetConversation();
  busy(true);
  state.abort = new AbortController(); // Stop cancels reading / downloading
  try {
    await work();
  } catch (err) {
    if (err?.name !== "AbortError") addBubble("error", err?.message || String(err));
  } finally {
    state.abort = null;
    busy(false);
  }
}

function attachDocument(file) {
  if (!file) return;
  return runAttach(async () =>
    attachBytes({ name: file.name, type: file.type, buffer: await file.arrayBuffer(), source: "file" })
  );
}

/** A link the user right-clicked: fetch it with their session, then read it. */
function attachFromUrl(url, source = "link") {
  return runAttach(async () => {
    const status = progressBubble();
    status.say("Downloading the document…");
    let doc;
    try {
      doc = await fetchDocument(url, { signal: state.abort.signal });
    } finally {
      status.remove();
    }
    await attachBytes({ ...doc, source });
  });
}

els.doc.addEventListener("click", () => els.docFile.click());
els.docFile.addEventListener("change", () => {
  const file = els.docFile.files?.[0];
  els.docFile.value = ""; // same file twice in a row must still fire
  attachDocument(file);
});

// Drag & drop anywhere on the panel.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  dragDepth++;
  els.drop.classList.add("show");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.drop.classList.remove("show");
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove("show");
  attachDocument(e.dataTransfer?.files?.[0]);
});

// ---- page context ---------------------------------------------------------

// Read the tab's text as it is RIGHT NOW, honouring the Viewport / Whole page
// and "page text" controls. Returns the block that travels with the question,
// a short note for the UI, and the preset signals (first turn only uses those).
async function grabContext(tab) {
  if (!tab) return { contextBlock: "", note: "image only", signals: null };

  // Cloud editors render into a <canvas>, so there is no page text to read —
  // the file itself has to be fetched. Tried before anything else.
  const cloud = await grabCloudDocument(tab);
  if (cloud) return cloud;

  if (els.wholeDoc.checked) {
    let doc = await grabFullDocument(tab.id);
    if (!doc || !doc.text || doc.text.length < 200) {
      // Thin/blocked HTML — the tab may BE a PDF, or the page may EMBED one
      // (<embed>/<object>/<iframe>). Parse the tab URL first, then embeds.
      const pdf = await firstPdfText([tab.url, ...(doc?.pdfUrls || [])], 100000);
      if (pdf) {
        doc = {
          url: tab.url,
          title: tab.title || "",
          text: pdf.text,
          chars: pdf.chars,
          pdf: true,
          note: pdfNote(pdf),
          thumb: pdf.thumb || "",
          scanned: !!pdf.scanned,
        };
      }
    }
    if (doc && doc.text) {
      return {
        contextBlock: buildContextBlock(
          { url: doc.url, title: doc.title, text: doc.text, fields: doc.fields },
          {
            maxText: 100000,
            textLabel: doc.scanned
              ? "Text read from the scanned document (OCR — may contain reading errors):"
              : doc.pdf
              ? "Full PDF text:"
              : "Full document text:",
          }
        ),
        note: doc.note || `${doc.pdf ? "PDF" : "whole document"} · ${doc.chars.toLocaleString()} chars`,
        fields: doc.fields || "",
        thumb: doc.thumb || "",
        signals: deriveSignals({ url: doc.url }, { wholeDoc: true }),
      };
    }
    return { contextBlock: "", note: "whole document unavailable — image only", signals: null };
  }

  if (!els.withText.checked) return { contextBlock: "", note: "image only", signals: null };

  const ctx = await grabPageContext(tab.id);
  if (ctx && (ctx.text || ctx.selection || ctx.url)) {
    // Page loaded, but if it's mostly an embedded PDF, pull that instead.
    let pdf = null;
    if ((!ctx.text || ctx.text.length < 200) && ctx.pdfUrls?.length) {
      pdf = await firstPdfText(ctx.pdfUrls, 12000);
    }
    if (pdf) {
      return {
        contextBlock: buildContextBlock(
          { url: tab.url, title: tab.title || "", selection: ctx.selection, text: pdf.text, fields: ctx.fields },
          {
            maxText: 100000,
            textLabel: pdf.scanned
              ? "Text read from the scanned document (OCR — may contain reading errors):"
              : "PDF text:",
          }
        ),
        note: pdfNote(pdf),
        fields: ctx.fields || "",
        thumb: pdf.thumb || "",
        signals: deriveSignals({ text: pdf.text }),
      };
    }
    const contextBlock = buildContextBlock(ctx);
    return {
      contextBlock,
      note: contextBlock ? (ctx.selection ? "image + selection + text" : "image + text") : "image only",
      fields: ctx.fields || "",
      signals: deriveSignals(ctx),
    };
  }

  // Fully blocked (Chrome PDF viewer) — parse the tab URL as a PDF. This is the
  // usual path for a scanned document opened straight in a tab.
  const pdf = await firstPdfText([tab.url], 12000);
  if (pdf) {
    return {
      contextBlock: buildContextBlock(
        { url: tab.url, title: tab.title || "", text: pdf.text },
        {
          maxText: 100000,
          textLabel: pdf.scanned
            ? "Text read from the scanned document (OCR — may contain reading errors):"
            : "PDF text:",
        }
      ),
      note: pdfNote(pdf),
      thumb: pdf.thumb || "",
      signals: deriveSignals({ text: pdf.text }),
    };
  }
  return { contextBlock: "", note: "image only", signals: null };
}

// Tells the model which version of the page to believe.
const STALE_NOTE =
  "[The page has CHANGED since the screenshot above. What follows is its current " +
  "text — trust it over the screenshot and over any earlier page context in this conversation.]";

const MOVED_NOTE =
  "[The user has moved to a DIFFERENT page. A new screenshot and its text follow — " +
  "answer about THIS page. Everything earlier in this conversation refers to the previous page.]";

/**
 * Bring the conversation up to date with what the user is looking at NOW.
 *
 *  - different page (navigated or switched tabs) → fresh screenshot + context;
 *  - same page, text changed → resend the text;
 *  - same page, only typed-in values changed (the common case on a form) →
 *    resend just those, not the whole document again;
 *  - nothing changed → nothing is sent.
 *
 * @returns {Promise<{block: string, image?: string, moved: boolean}|null>}
 */
async function refreshContext() {
  if (!state.shot) return null;
  // A document the user attached by hand is not tied to any tab — following the
  // tab here would silently swap it out from under the next question.
  if (state.shot.pinned) return null;

  const tab = await getActiveTab();
  if (!tab) return null;

  const moved = tab.url !== state.shot.meta?.url;
  const { contextBlock, note, fields, signals } = await grabContext(tab);

  if (moved) {
    // The panel follows the tab: a new page gets its own shot, and the thumb /
    // chips / history badge follow it so the UI shows what is actually in play.
    let dataUrl = "";
    try {
      dataUrl = await captureTab(tab.windowId);
    } catch (_) {
      /* restricted page — carry on with text only */
    }
    if (!dataUrl && !contextBlock) return null;

    state.shot = {
      dataUrl: dataUrl || state.shot.dataUrl,
      contextBlock,
      note,
      meta: { url: tab.url || "", title: tab.title || "" },
    };
    if (dataUrl) showThumb(dataUrl, note);
    markClinical(tab.url || "");
    // Walking into a clinical page mid-conversation: drop what was already
    // parked in session storage instead of leaving a stale copy behind.
    if (isClinicalUrl(tab.url)) clearSession();
    if (signals) renderChips(signals);
    return { block: contextBlock, image: dataUrl || undefined, moved: true };
  }

  if (!contextBlock || contextBlock === state.shot.contextBlock) return null;

  const pageOnly = (block) => String(block).split(FIELDS_LABEL)[0];
  const valuesOnly = pageOnly(contextBlock) === pageOnly(state.shot.contextBlock);

  state.shot.contextBlock = contextBlock;
  return { block: valuesOnly ? buildContextBlock({ fields }) : contextBlock, moved: false };
}

// ---- agent (tool use) -----------------------------------------------------

// The agent lets the model gather more sources and propose form actions on its
// own — read a linked document, list/fill fields — each action confirmed by the
// clinician through the existing review overlay. Tools reuse what the panel
// already does; the loop itself lives in lib/agent.js and is model-agnostic.

const AGENT_PERSONA =
  "You are Scribe Agent, an assistant for a clinician working in the browser. You " +
  "help with clinical forms and documents. Be concise and precise. The final " +
  "decision is always the clinician's.";

// One model turn for the agent loop, wired to the fixed backend. Streams tokens
// out (the loop decides whether they are shown — only the final answer is).
async function agentCallModel({ messages, system, signal, onToken }) {
  const req = buildRequest({
    format: backend.format,
    base: backend.base,
    model: backend.model,
    apikey: backend.apikey,
    messages,
    stream: true,
    system,
    lang: state.lang,
  });
  return runChat(req, { signal, onToken });
}

/** Read a document by URL: fetch with the user's session, then parse to text. */
async function documentToText(url) {
  const fetched = await fetchDocument(url, { signal: state.abort?.signal });
  const { text, note } = await readCloudBytes({ ...fetched, name: fetched.name || url });
  if (!text.trim()) throw new Error("No text found in the document.");
  return `Document "${fetched.name || url}"${note ? ` (${note})` : ""}:\n${text}`;
}

/** Find a form field by label (exact, then fuzzy). */
async function findFieldByLabel(label) {
  const tab = await getActiveTab();
  const fields = tab?.id ? await askTab(tab.id, { type: "SCAN_FIELDS" }) : [];
  const want = String(label ?? "").toLowerCase().trim();
  const match =
    fields.find((f) => f.label.toLowerCase() === want) ||
    fields.find((f) => f.label.toLowerCase().includes(want)) ||
    null;
  return { tab, fields, match };
}

/** The tool registry (Phase 1: page/document reading + field actions). */
function agentTools() {
  return [
    {
      name: "read_current_page",
      description: "Reads the current page or form — the field values and the text.",
      run: async () => {
        const tab = await getActiveTab();
        const { contextBlock } = await grabContext(tab);
        return contextBlock || "(no text found on the page)";
      },
    },
    {
      name: "list_form_fields",
      description: "Lists the fields of the current form that can be written to.",
      run: async () => {
        const { fields } = await findFieldByLabel("");
        if (!fields.length) return "No form fields found.";
        return fields.map((f) => `- ${f.label}${String(f.filled ? " (filled)" : "")}`).join("\n");
      },
    },
    {
      name: "read_document",
      description: "Reads a document from a link (PDF, Word, Excel, Google, SharePoint).",
      args: '{"url": "<link>"}',
      run: async ({ url }) => {
        if (!url) return "No link (url) was given.";
        return documentToText(url);
      },
    },
    {
      name: "fill_fields",
      description:
        "Proposes text for one OR MORE form fields. ALWAYS pass every field in a " +
        "SINGLE call — they open in one review, where the clinician ticks and confirms.",
      args: '{"fields": [{"field": "<field label>", "text": "<text>"}, ...]}',
      run: async ({ fields }) => {
        const list = Array.isArray(fields) ? fields.filter((f) => f && f.field && f.text) : [];
        if (!list.length) return "At least one {field, text} pair is required.";
        const tab = await getActiveTab();
        if (!tab?.id) return "There is no active page.";
        const res = await askTab(tab.id, { type: "PROPOSE_FIELDS", proposals: list });
        if (!res?.ok) return "Could not open the review overlay on the page.";
        const parts = [`${res.matched} field(s) proposed — awaiting the clinician\u2019s confirmation in the review.`];
        if (res.unmatched?.length) parts.push(`Fields not found: ${res.unmatched.join(", ")}.`);
        return parts.join(" ");
      },
    },
  ];
}

// A step shown inline while the agent works — a compact line the clinician can
// glance at to see what the assistant is doing on their behalf.
const STEP_LABEL = {
  read_current_page: "Reading the page",
  list_form_fields: "Inspecting the form fields",
  read_document: "Reading the document",
  fill_fields: "Proposing field text",
};

function addStepBubble() {
  els.empty.style.display = "none";
  const el = document.createElement("div");
  el.className = "msg step";
  els.msgs.appendChild(el);
  scrollBottom();
  return el;
}

// ---- send -----------------------------------------------------------------

async function send() {
  if (state.busy) return;
  // Sending while the mic is live: finish the dictation first so the last words
  // make it into the prompt instead of being cut off.
  if (mic.on) await toggleMic();

  const prompt = els.input.value.trim();
  if (!prompt) return;

  let model;
  try {
    model = await ensureModel();
  } catch (err) {
    checkConnection();
    // The specific message matters now that the endpoint is user-configurable:
    // "rejected the API key" and "cannot be reached" need different fixes.
    addBubble("error", err?.message || "Can't reach the model server.");
    return;
  }

  const preset = state.nextPreset;
  state.nextPreset = null;

  busy(true);
  // Created before the capture so Stop works during it too — an already-aborted
  // signal makes runChat bail immediately.
  state.abort = new AbortController();
  const t0 = performance.now();
  let assistantEl = null;
  let full = "";
  let refreshed = ""; // "" | "text" | "page"
  try {
    // The first turn carries the screenshot + page context; later turns are
    // follow-ups against the same shot. A shot may already be primed by the
    // right-click menu, in which case we don't recapture.
    const firstTurn = state.convo.length === 0;
    if (firstTurn) {
      if (!state.shot) {
        const tab = await getActiveTab();
        const dataUrl = await captureTab(tab?.windowId);
        const { contextBlock, note, signals, thumb, noStore } = await grabContext(tab);
        if (signals) renderChips(signals);
        // A rendered PDF page beats a screenshot of the PDF viewer around it.
        const image = thumb || dataUrl;
        state.shot = {
          dataUrl: image,
          contextBlock,
          note,
          meta: { url: tab?.url || "", title: tab?.title || "" },
          noStore: !!noStore, // fetched cloud document — same rule as clinical pages
        };
        showThumb(image, note);
        markClinical(state.shot.meta.url);
        if (noStore) els.histNote.hidden = false;
      }
      state.convo.push({
        role: "user",
        text: composeUserText(prompt, state.shot.contextBlock),
        image: state.shot.dataUrl,
      });
    } else {
      // Follow-up: same shot, but the page may have moved on since it was taken
      // (a field filled in by hand, a form saved). Re-read it and, if the text
      // really changed, send the current state with this turn.
      const update = await refreshContext();
      refreshed = update ? (update.moved ? "page" : "text") : "";

      const turn = { role: "user", text: prompt };
      if (update) {
        const note = update.moved ? MOVED_NOTE : STALE_NOTE;
        turn.text = composeUserText(prompt, update.block ? `${note}\n\n${update.block}` : note);
        if (update.image) turn.image = update.image; // new page → new screenshot
      }
      state.convo.push(turn);
    }

    addBubble("user", prompt);
    state.view.push({ role: "user", text: prompt });
    els.input.value = "";
    els.input.style.height = "auto";

    // Reveal the answer streaming into a bubble. In agent mode the bubble is
    // created lazily — after the tool steps — so ordering stays: steps → answer.
    const revealAnswer = (f) => {
      full = f;
      if (!assistantEl) assistantEl = addBubble("assistant", "");
      assistantEl.classList.remove("busy");
      assistantEl.textContent = f;
      scrollBottom();
    };

    let agentSteps = 0;
    let agentStopped = false;

    if (state.agent) {
      const started = new Map(); // tool → performance.now() of the open step
      const result = await runAgent({
        history: state.convo,
        tools: agentTools(),
        callModel: agentCallModel,
        persona: AGENT_PERSONA,
        signal: state.abort.signal,
        onStep: (s) => {
          const label = STEP_LABEL[s.tool] || s.tool;
          if (s.status === "start") {
            const el = addStepBubble();
            el.textContent = `⟳ ${label}…`;
            started.set(s.tool + "@" + started.size, el);
            el._scribeTool = s.tool;
            el._scribeOpen = true;
            el._scribeT0 = performance.now();
          } else {
            // Close the most recent open step for this tool.
            const open = Array.from(els.msgs.querySelectorAll(".msg.step"))
              .reverse()
              .find((n) => n._scribeTool === s.tool && n._scribeOpen);
            if (open) {
              open._scribeOpen = false;
              open.textContent =
                s.status === "error" ? `✕ ${label}: ${s.error || "error"}` : `✓ ${label}`;
              open.classList.toggle("err", s.status === "error");
              sendMetric("agent.tool", {
                tool: s.tool,
                ok: s.status !== "error",
                ms: Math.round(performance.now() - (open._scribeT0 || performance.now())),
              });
            }
          }
        },
        onAnswerToken: (_delta, f) => revealAnswer(f),
      });
      full = result.text || full;
      agentSteps = result.steps;
      agentStopped = result.stopped;
      if (agentStopped && !full) throw Object.assign(new Error("stopped"), { name: "AbortError" });
      if (full && !assistantEl) assistantEl = addBubble("assistant", full);
      sendMetric("agent.run", {
        steps: agentSteps,
        ms: Math.round(performance.now() - t0),
        ok: !!full,
        stopped: agentStopped,
      });
    } else {
      assistantEl = addBubble("assistant", "…");
      assistantEl.classList.add("busy");
      const req = buildRequest({
        format: backend.format,
        base: backend.base,
        model,
        apikey: backend.apikey,
        messages: state.convo,
        stream: true,
        lang: state.lang,
      });
      await runChat(req, { signal: state.abort.signal, onToken: (_delta, f) => revealAnswer(f) });
    }

    state.convo.push({ role: "assistant", text: full });
    if (full && assistantEl) {
      state.view.push({ role: "assistant", text: full });
      renderInto(assistantEl, full);
      addActions(assistantEl, () => full, preset);
      saveHistory(prompt, full).catch(() => {});
      saveSession();
    }
    // Metrika: kuris patarimas panaudotas ir kiek uztruko. Nei klausimo, nei
    // no answer text here — only the preset id and some lengths.
    sendMetric("chat.asked", {
      preset: preset?.id ?? "custom",
      scope: els.wholeDoc.checked ? "whole" : "viewport",
      withText: els.withText.checked,
      wholeDoc: els.wholeDoc.checked,
      hasImage: !!state.shot?.dataUrl,
      clinicalForm: isClinicalUrl(state.shot?.meta?.url || ""),
      ms: Math.round(performance.now() - t0),
      answerChars: full.length,
    });

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const fresh =
      refreshed === "page" ? " · new page" : refreshed === "text" ? " · context refreshed" : "";
    els.meta.textContent = `${secs}s · ${state.shot.note}${fresh}`;
  } catch (err) {
    // Stop pressed: keep whatever streamed in — it's usually the useful part.
    if (err?.name === "AbortError") {
      if (full) {
        state.convo.push({ role: "assistant", text: full });
        state.view.push({ role: "assistant", text: full });
        renderInto(assistantEl, full);
        addActions(assistantEl, () => full, preset);
        saveSession();
      } else {
        assistantEl?.remove();
        if (state.convo[state.convo.length - 1]?.role === "user") state.convo.pop();
        if (state.view[state.view.length - 1]?.role === "user") state.view.pop();
      }
      els.meta.textContent = "stopped";
    } else {
      const msg = err?.message || String(err);
      const bubble = assistantEl || addBubble("error", msg);
      if (assistantEl) {
        assistantEl.className = "msg error";
        assistantEl.textContent = msg;
      }
      addRetry(bubble, prompt, preset);
      // Tik kategorija — klaidos zinuteje gali buti atspindetas promptas.
      sendMetric("error", { where: "chat", kind: chatErrorKind(err) });
      // Roll back the user turn we optimistically pushed so retry isn't polluted.
      if (state.convo[state.convo.length - 1]?.role === "user") state.convo.pop();
      if (state.view[state.view.length - 1]?.role === "user") state.view.pop();
    }
  } finally {
    state.abort = null;
    busy(false);
    els.input.focus();
  }
}

// One button, two jobs: Send while idle, Stop while a request is running.
els.send.addEventListener("click", () => {
  if (state.busy) state.abort?.abort();
  else send();
});
els.input.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter and Ctrl/Cmd+Enter make a newline-friendly compose.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// ---- dictation in the composer --------------------------------------------

// The same dictation path the form uses (the ASR server via the service
// worker), but the transcript lands in the composer instead of a field. No
// /api/llm-correct pass here: that prompt is tuned for clinical dictation and
// would only add a round-trip to a one-line question.
// `base` is whatever was already typed before the mic started — live partials
// are appended to it, never over it.
const mic = { dict: null, on: false, base: "" };

function micUi(on, level = 0) {
  mic.on = on;
  els.mic.classList.toggle("rec", on);
  els.mic.textContent = on ? "■" : "🎤";
  els.mic.title = on ? "Stop dictation" : "Dictate a question";
  els.mic.style.setProperty("--level", `${Math.round(level * 100)}%`);
}

function micCompose(text) {
  els.input.value = mic.base ? `${mic.base} ${text}` : text;
}

// The panel is its own origin (chrome-extension://…), so the microphone
// permission granted to the host page does not apply here — and Chrome shows no
// permission prompt inside a side panel, it just fails. Ask for it in a normal
// window once; after that the panel can record.
function openMicPermissionWindow() {
  return new Promise((resolve) => {
    chrome.windows.create(
      { url: chrome.runtime.getURL("mic-permission.html"), type: "popup", width: 460, height: 280 },
      (win) => {
        if (!win) return resolve();
        const done = (closedId) => {
          if (closedId !== win.id) return;
          chrome.windows.onRemoved.removeListener(done);
          resolve();
        };
        chrome.windows.onRemoved.addListener(done);
      }
    );
  });
}

async function micPermissionState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch (_) {
    return "unknown"; // not queryable — just try getUserMedia
  }
}

/** @returns {Promise<boolean>} whether recording may start */
async function ensureMicPermission() {
  if ((await micPermissionState()) !== "prompt") return true; // granted, denied or unknown → let getUserMedia decide
  els.meta.textContent = "waiting for permission…";
  await openMicPermissionWindow();
  els.meta.textContent = "";
  return (await micPermissionState()) !== "denied";
}

async function toggleMic() {
  if (state.busy) return;

  if (mic.on) {
    els.mic.disabled = true;
    els.meta.textContent = "transcribing…";
    try {
      const text = await mic.dict.finish();
      micCompose(text);
      els.input.dispatchEvent(new Event("input")); // auto-grow
      els.meta.textContent = text ? "" : "nothing recognised";
    } finally {
      mic.dict?.stop();
      mic.dict = null;
      micUi(false);
      els.mic.disabled = false;
      els.input.focus();
    }
    return;
  }

  if (!(await ensureMicPermission())) {
    addBubble(
      "error",
      "The microphone is not allowed for this extension. The permission can be reset at chrome://settings/content/microphone."
    );
    return;
  }

  mic.base = els.input.value.trim();
  const dict = new Dictation({
    onPartial: micCompose,
    onLevel: (level) => els.mic.style.setProperty("--level", `${Math.round(level * 100)}%`),
    onError: (msg) => addBubble("error", msg),
  });

  els.mic.disabled = true;
  els.meta.textContent = "connecting…";
  try {
    await dict.start();
  } catch (err) {
    dict.stop();
    els.meta.textContent = "";
    els.mic.disabled = false;

    const msg = err?.message || String(err);
    // micErrorMessage speaks in page terms ("allow it for this page") — in the
    // panel the origin is the extension, so say that and offer the fix.
    const blocked = /blocked|NotAllowed/i.test(msg);
    const bubble = addBubble(
      "error",
      blocked ? "The microphone is not allowed for this extension — a one-off permission is needed." : msg
    );
    if (blocked) {
      const row = document.createElement("div");
      row.className = "actions";
      const fix = document.createElement("button");
      fix.textContent = "Allow microphone";
      fix.addEventListener("click", async () => {
        bubble.remove();
        await openMicPermissionWindow();
        toggleMic();
      });
      row.appendChild(fix);
      bubble.appendChild(row);
    }
    return;
  }

  mic.dict = dict;
  els.mic.disabled = false;
  micUi(true);
  els.meta.textContent = "recording…";
}

els.mic.addEventListener("click", toggleMic);
// Never leave the mic indicator burning after the panel goes away.
window.addEventListener("pagehide", () => mic.dict?.stop());

// Auto-grow the composer up to its max-height.
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
});

// ---- session (survive closing the panel) ----------------------------------

// The side panel is torn down every time it closes, which used to drop the
// running conversation. storage.session is memory-only and dies with the
// browser — but clinical pages are still skipped, on principle.
const SESSION_KEY = "chatSession";

function saveSession() {
  if (!state.shot || state.shot.noStore || isClinicalUrl(state.shot.meta?.url)) return;
  chrome.storage.session
    .set({ [SESSION_KEY]: { shot: state.shot, convo: state.convo, view: state.view } })
    .catch(() => {});
}

function clearSession() {
  chrome.storage.session.remove(SESSION_KEY).catch(() => {});
}

// A right-click "Ask about this" is a fresh start and always wins over a
// restore — both kick off at load, so the flag settles the race.
let restoreBlocked = false;

async function restoreSession() {
  let saved;
  try {
    ({ [SESSION_KEY]: saved } = await chrome.storage.session.get(SESSION_KEY));
  } catch (_) {
    return;
  }
  if (restoreBlocked || !saved?.view?.length || !saved.shot) return;

  state.shot = saved.shot;
  state.convo = saved.convo || [];
  state.view = saved.view;

  showThumb(state.shot.dataUrl, state.shot.note || "restored");
  markClinical(state.shot.meta?.url);
  for (const turn of state.view) {
    const el = addBubble(turn.role, turn.text);
    if (turn.role === "assistant") {
      renderInto(el, turn.text);
      addActions(el, () => turn.text, null);
    }
  }
}

// ---- history (IndexedDB journal) ------------------------------------------

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("image load failed"));
    img.src = src;
  });
}

// Downscale the screenshot to a small JPEG for the history list.
async function makeThumb(dataUrl, maxW = 320) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxW / (img.width || maxW));
  const w = Math.max(1, Math.round((img.width || maxW) * scale));
  const h = Math.max(1, Math.round((img.height || maxW) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.6);
}

async function saveHistory(prompt, answer) {
  if (!state.shot) return;
  // Never put a clinical page or an attached patient document on disk: the
  // entry would carry a full image plus the answer, kept for up to 200 entries.
  if (state.shot.noStore || isClinicalUrl(state.shot.meta?.url)) return;
  let thumb = "";
  try {
    thumb = await makeThumb(state.shot.dataUrl);
  } catch (_) {}
  await addEntry({
    url: state.shot.meta?.url || "",
    title: state.shot.meta?.title || "",
    note: state.shot.note || "",
    prompt,
    answer,
    thumb,
    image: state.shot.dataUrl,
  });
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderHistoryList(entries) {
  els.histList.innerHTML = "";
  els.histCount.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  if (!entries.length) {
    const e = document.createElement("div");
    e.id = "histEmpty";
    e.textContent = "Nothing here yet.";
    els.histList.appendChild(e);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "hist-item";
    item.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("hist-del")) return;
      openEntry(entry);
    });

    if (entry.thumb) {
      const img = document.createElement("img");
      img.src = entry.thumb;
      img.alt = "";
      item.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "hist-body";
    const title = document.createElement("div");
    title.className = "hist-title";
    title.textContent = entry.prompt || entry.title || "(untitled)";
    const snippet = document.createElement("div");
    snippet.className = "hist-snippet";
    snippet.textContent = entry.answer || "";
    const meta = document.createElement("div");
    meta.className = "hist-meta";
    const time = document.createElement("span");
    time.className = "hist-time";
    time.textContent = timeAgo(entry.ts);
    const del = document.createElement("button");
    del.className = "hist-del";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await deleteEntry(entry.id);
      refreshHistory();
    });
    meta.appendChild(time);
    meta.appendChild(del);

    body.appendChild(title);
    body.appendChild(snippet);
    body.appendChild(meta);
    item.appendChild(body);
    els.histList.appendChild(item);
  }
}

async function refreshHistory() {
  const q = els.histSearch.value.trim();
  const entries = q ? await searchHistory(q) : await getRecent();
  renderHistoryList(entries);
}

// Restore a past entry so you can keep asking follow-ups about the same shot.
function openEntry(entry) {
  resetConversation();
  state.shot = {
    dataUrl: entry.image,
    contextBlock: "",
    note: entry.note || "restored",
    meta: { url: entry.url, title: entry.title },
  };
  state.convo = [
    { role: "user", text: entry.prompt, image: entry.image },
    { role: "assistant", text: entry.answer },
  ];
  state.view = [
    { role: "user", text: entry.prompt },
    { role: "assistant", text: entry.answer },
  ];
  showThumb(entry.image, entry.note || "restored");
  markClinical(entry.url);
  addBubble("user", entry.prompt);
  const a = addBubble("assistant", entry.answer);
  renderInto(a, entry.answer);
  addActions(a, () => entry.answer, null);
  renderChips(deriveSignals(null)); // follow-up presets
  activateView("chat");
}

els.histSearch.addEventListener("input", refreshHistory);
els.histClear.addEventListener("click", async () => {
  if (!confirm("Delete all history? This can't be undone.")) return;
  await clearAll();
  refreshHistory();
});

// ---- watch mode -----------------------------------------------------------

// A frame counts as "changed" when the mean grayscale pixel diff (0..1) crosses
// this — high enough to ignore cursor blinks / minor log scroll, low enough to
// catch a build finishing or a page state flip. Tune if too eager / too quiet.
const CHANGE_THRESHOLD = 0.025;
const DONE_RE =
  /\b(done|finished|complete|completed|success|succeeded|passed|failed|failure|error|errors|crash|crashed|exception|aborted|timed out|stopped)\b/i;

const watch = {
  on: false,
  timer: null,
  windowId: null,
  prompt: "",
  intervalMs: 15000,
  onlyDone: false,
  lastSig: null,
  ticks: 0,
  changes: 0,
  busy: false,
};

// Downscaled grayscale signature for cheap frame-to-frame comparison.
async function frameSignature(dataUrl, size = 64) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  c.drawImage(img, 0, 0, size, size);
  const { data } = c.getImageData(0, 0, size, size);
  const gray = new Float32Array(size * size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

function meanDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

function setWatchStatus(text) {
  els.watchStatus.textContent = text;
}

let _fallbackIcon = "";
function fallbackIcon() {
  if (_fallbackIcon) return _fallbackIcon;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#f4eff2";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#6b2340";
  g.beginPath();
  g.arc(32, 32, 15, 0, Math.PI * 2);
  g.fill();
  _fallbackIcon = c.toDataURL("image/png");
  return _fallbackIcon;
}

function addWatchBubble(text) {
  els.empty.style.display = "none";
  const el = document.createElement("div");
  el.className = "msg watch";
  const t = document.createElement("span");
  t.className = "wt";
  t.textContent = "⟳ watch · " + new Date().toLocaleTimeString();
  const body = document.createElement("div");
  body.className = "md";
  body.innerHTML = renderMarkdown(text);
  el.appendChild(t);
  el.appendChild(body);
  els.msgs.appendChild(el);
  scrollBottom();
}

async function notifyWatch(dataUrl, message) {
  let icon = "";
  try {
    icon = await makeThumb(dataUrl, 128);
  } catch (_) {}
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: icon || fallbackIcon(),
      title: "Watch: change detected",
      message: (message || "").slice(0, 300),
      priority: 1,
    });
  } catch (_) {}
}

async function onWatchChange(dataUrl) {
  let model;
  try {
    model = await ensureModel();
  } catch (_) {
    setWatchStatus("watch: model server unreachable");
    return;
  }
  const promptText =
    watch.prompt ||
    "You are watching a long-running process on screen. In one short sentence, state its current status and whether it has finished, failed, or is still running.";
  const req = buildRequest({
    format: backend.format,
    base: backend.base,
    model,
    apikey: backend.apikey,
    messages: [{ role: "user", text: promptText, image: dataUrl }],
    stream: false,
    lang: state.lang,
  });
  let answer = "";
  try {
    answer = await runChat(req);
  } catch (err) {
    answer = "(watch query failed: " + (err?.message || err) + ")";
  }
  addWatchBubble(answer);
  if (!watch.onlyDone || DONE_RE.test(answer)) notifyWatch(dataUrl, answer);
}

async function watchTick() {
  if (!watch.on || watch.busy) return;
  watch.busy = true;
  try {
    const dataUrl = await captureTab(watch.windowId);
    const sig = await frameSignature(dataUrl);
    watch.ticks++;
    let changed = false;
    let d = 0;
    if (watch.lastSig) {
      d = meanDiff(sig, watch.lastSig);
      changed = d >= CHANGE_THRESHOLD;
    }
    watch.lastSig = sig;
    showThumb(dataUrl, `watch · tick ${watch.ticks}`);
    setWatchStatus(
      `watching · ${watch.ticks} ticks · ${watch.changes} change(s) · Δ ${(d * 100).toFixed(1)}%`
    );
    if (changed) {
      watch.changes++;
      await onWatchChange(dataUrl);
    }
  } catch (err) {
    setWatchStatus("watch stopped: " + (err?.message || err));
    stopWatch();
  } finally {
    watch.busy = false;
  }
}

async function startWatch() {
  if (!(await checkConnection())) {
    setWatchStatus("model server unreachable");
    return;
  }
  const every = Math.max(3, parseInt(els.watchEvery.value, 10) || 15);
  const tab = await getActiveTab();
  watch.windowId = tab?.windowId;
  watch.intervalMs = every * 1000;
  watch.prompt = els.watchPrompt.value.trim();
  watch.onlyDone = els.watchOnlyDone.checked;
  watch.on = true;
  watch.lastSig = null;
  watch.ticks = 0;
  watch.changes = 0;
  els.watchToggle.textContent = "Stop watching";
  els.watchToggle.classList.add("on");
  els.tabWatch.classList.add("running");
  saveWatchSettings();
  setWatchStatus("starting…");
  watchTick(); // baseline immediately
  watch.timer = setInterval(watchTick, watch.intervalMs);
}

function stopWatch() {
  watch.on = false;
  if (watch.timer) {
    clearInterval(watch.timer);
    watch.timer = null;
  }
  els.watchToggle.textContent = "Start watching this window";
  els.watchToggle.classList.remove("on");
  els.tabWatch.classList.remove("running");
  if (watch.ticks) setWatchStatus(`stopped · ${watch.changes} change(s) in ${watch.ticks} ticks`);
}

function saveWatchSettings() {
  chrome.storage.local.set({
    watchEvery: els.watchEvery.value,
    watchPrompt: els.watchPrompt.value,
    watchOnlyDone: els.watchOnlyDone.checked,
  });
}

function loadWatchSettings() {
  chrome.storage.local.get(["watchEvery", "watchPrompt", "watchOnlyDone"], (s) => {
    if (s.watchEvery) els.watchEvery.value = s.watchEvery;
    if (s.watchPrompt !== undefined) els.watchPrompt.value = s.watchPrompt;
    els.watchOnlyDone.checked = !!s.watchOnlyDone;
  });
}

els.watchToggle.addEventListener("click", () => (watch.on ? stopWatch() : startWatch()));
[els.watchEvery, els.watchPrompt, els.watchOnlyDone].forEach((el) =>
  el.addEventListener("change", saveWatchSettings)
);
// Stop cleanly if the panel is closing.
window.addEventListener("pagehide", stopWatch);

// ---- form view (Med Autofill) ---------------------------------------------

// The draft review/edit UI lives in the page itself (the content script's
// overlay), because generation starts from a button next to the field. This
// view only mirrors status and can kick a generation off.

function setMfStatus(row, state, text) {
  row.querySelector(".dot").dataset.state = state;
  row.querySelector(".status-text").textContent = text;
}

/** @returns {Promise<any|null>} null when there is no content script in that tab */
async function askTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

async function testMedConnection() {
  els.mfTest.disabled = true;
  setMfStatus(els.mfConn, "unknown", "Connecting…");
  setMfStatus(els.mfAsr, "unknown", "Connecting…");

  const [llm, asr] = await Promise.all([
    chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }),
    chrome.runtime.sendMessage({ type: "TEST_ASR" }),
  ]);
  els.mfTest.disabled = false;

  if (llm?.ok) setMfStatus(els.mfConn, "ok", `Model · ${hostOf(backend.base)}`);
  else setMfStatus(els.mfConn, "bad", llm?.error || "Model server unreachable");

  if (asr?.ok) setMfStatus(els.mfAsr, "ok", `Transcription · ${hostOf(els.asrEndpoint.value || ENDPOINTS.asr)}`);
  else setMfStatus(els.mfAsr, "bad", asr?.error || "Transcription server unreachable");
}

// One row per detected field. Only curated fields (those with a prompt
// template) can be generated from context; the rest are listed because
// dictation and "insert from chat" reach them just the same.
function fieldRow({ key, label, known, critical, filled }) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = "field-btn";
  if (!known) btn.classList.add("is-plain");
  if (critical) btn.classList.add("is-critical");

  const name = document.createElement("span");
  name.textContent = label;

  const hint = document.createElement("span");
  hint.className = "hint";

  if (known) {
    hint.textContent = "Generate →";
    btn.addEventListener("click", async () => {
      const tab = await getActiveTab(); // resolved now — the list may be a moment old
      if (tab?.id) askTab(tab.id, { type: "START_GENERATION", fieldKey: key });
    });
  } else {
    hint.textContent = filled ? "filled" : "";
    btn.disabled = true;
    btn.title =
      "This field has no prompt template — it is reachable by dictating the whole " +
      "form, or by inserting an answer from the conversation.";
  }

  btn.append(name, hint);
  li.append(btn);
  return li;
}

async function loadMedFields() {
  const tab = await getActiveTab();

  // The same source dictation uses — otherwise the panel would list 2 fields
  // where dictation sees 16.
  const fields = tab?.id ? await askTab(tab.id, { type: "SCAN_FIELDS" }) : null;
  medFields = fields || [];

  renderMedFields(!!tab?.id, fields);
  refreshInsertActions();
}

function renderMedFields(hasTab, fields) {
  if (!hasTab) {
    setMfStatus(els.mfPage, "bad", "No active page");
    els.mfFields.innerHTML = '<li class="empty">—</li>';
    els.mfDictateAll.disabled = true;
    return;
  }

  if (fields === null) {
    setMfStatus(els.mfPage, "bad", "This page is not supported");
    els.mfFields.innerHTML = '<li class="empty">The extension is not active on this page.</li>';
    els.mfDictateAll.disabled = true;
    return;
  }

  els.mfDictateAll.disabled = !fields.length;

  if (!fields.length) {
    setMfStatus(els.mfPage, "warn", "Page supported, no form found");
    els.mfFields.innerHTML = '<li class="empty">No free-text fields found on this page.</li>';
    return;
  }

  const known = fields.filter((f) => f.known).length;
  setMfStatus(els.mfPage, "ok", `Fields found: ${fields.length} · with templates: ${known}`);
  els.mfFields.replaceChildren(...fields.map(fieldRow));
}

async function refreshFormView() {
  await loadMedFields();
  testMedConnection();
}

// The content script pings us whenever the set of fields changes (SPA
// navigation, a form rendering late); tab switches and page loads do the same.
// Runs regardless of which view is open, because the chat needs the list too.
let fieldsRefresh = null;
function scheduleFieldsRefresh() {
  clearTimeout(fieldsRefresh);
  fieldsRefresh = setTimeout(() => loadMedFields(), 150);
}

// Tab switch / page load: refresh fields and chips, and — while no capture has
// been taken yet — keep the "history not saved" badge honest about the page
// you're actually looking at.
async function onTabChanged() {
  scheduleFieldsRefresh();
  scheduleChipsRefresh();
  if (!state.shot) {
    const tab = await getActiveTab();
    markClinical(tab?.url || "");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  // A form appearing without a page load (SPA) is exactly when the chips are
  // wrong too — the panel was opened before the form existed.
  if (msg?.type === "FIELDS_CHANGED") {
    scheduleFieldsRefresh();
    scheduleChipsRefresh();
  }
});
chrome.tabs.onActivated.addListener(onTabChanged);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete") onTabChanged();
});

els.mfTest.addEventListener("click", testMedConnection);

// The same global dictation as the floating button in the page — one less thing
// to hunt for on a long form. The mic is still requested by the page.
els.mfDictateAll.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) await askTab(tab.id, { type: "START_DICTATE_ALL" });
});

// ---- right-click menu context ---------------------------------------------

// Fetch an image the user right-clicked and inline it as a data URL. The
// <all_urls> host permission lets the extension bypass CORS here.
async function fetchImageDataUrl(url) {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch image (HTTP ${res.status}).`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Couldn't read the image."));
    fr.readAsDataURL(blob);
  });
}

// Prepare a fresh conversation seeded from a right-click. For an image we send
// the image itself; for a selection/page we screenshot the tab and lead with
// the selected text.
async function consumePendingAsk(p) {
  if (state.busy || !p) return;
  restoreBlocked = true;
  activateView("chat");

  // A link to a document: fetch and read it. runAttach() does its own reset and
  // busy handling, so this path returns before the screenshot logic below.
  if (p.type === "link" && p.linkUrl) {
    await attachFromUrl(p.linkUrl);
    return;
  }

  resetConversation();
  try {
    if (p.type === "image" && p.srcUrl) {
      const dataUrl = await fetchImageDataUrl(p.srcUrl);
      const ctx = await grabPageContext(p.tabId, { maxChars: 2000 });
      const contextBlock = buildContextBlock(ctx ? { url: ctx.url, title: ctx.title } : null);
      state.shot = {
        dataUrl,
        contextBlock,
        note: "image (from page)",
        meta: { url: ctx?.url || "", title: ctx?.title || "" },
      };
      showThumb(dataUrl, "image (from page)");
      markClinical(state.shot.meta.url);
      renderChips(deriveSignals(null, { image: true }));
      els.input.value = "What is in this image? If it contains text, extract it.";
    } else {
      const dataUrl = await captureTab(p.windowId);
      const ctx = (await grabPageContext(p.tabId)) || {};
      // executeScript can't reach the PDF viewer / restricted pages — backfill
      // URL and title straight from the tab so we still have some context.
      if (!ctx.url) {
        try {
          const t = await chrome.tabs.get(p.tabId);
          ctx.url = t?.url || "";
          ctx.title = t?.title || "";
        } catch (_) {}
      }
      if (p.selectionText) ctx.selection = p.selectionText; // trust the menu's copy
      const contextBlock = buildContextBlock(ctx);
      const note = p.selectionText
        ? "image + selection + text"
        : contextBlock
        ? "image + text"
        : "image only";
      state.shot = { dataUrl, contextBlock, note, meta: { url: ctx.url || "", title: ctx.title || "" } };
      showThumb(dataUrl, note);
      markClinical(state.shot.meta.url);
      renderChips(deriveSignals(ctx));
      els.input.value = p.selectionText ? "Explain this." : "";
    }
    els.input.focus();
    els.input.select();
  } catch (err) {
    addBubble("error", "Couldn't prepare the context: " + (err?.message || err));
  }
}

// The menu click (in the service worker) sets storage.session.pendingAsk. Read
// it on load in case it was set before we were ready, and watch for later ones.
chrome.storage.session.get("pendingAsk", ({ pendingAsk }) => {
  if (pendingAsk) {
    chrome.storage.session.remove("pendingAsk");
    consumePendingAsk(pendingAsk);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingAsk?.newValue) {
    chrome.storage.session.remove("pendingAsk");
    consumePendingAsk(changes.pendingAsk.newValue);
  }
});

// ---- the metrics view (Settings) ------------------------------------------

async function refreshMetricsView() {
  const state = await chrome.runtime.sendMessage({ type: "METRICS_STATE" }).catch(() => null);
  if (!state) return;
  els.metricsOn.checked = state.enabled !== false;
  els.metricsCount.querySelector(".status-text").textContent =
    `Events collected: ${state.count ?? 0}`;

  // The send status. This is not decoration: flush() swallows errors silently
  // (so telemetry cannot disrupt the user's work), so a misconfigured collector
  // would otherwise show up only as data that never arrives.
  const sync = state.sync ?? {};
  const dot = els.metricsSync.querySelector(".dot");
  const txt = els.metricsSync.querySelector(".status-text");
  els.metricsFlush.hidden = !sync.configured;

  if (!sync.configured) {
    dot.dataset.state = "unknown";
    txt.textContent = "Sending is off — the data stays on this machine.";
  } else if (sync.lastError) {
    dot.dataset.state = "bad";
    txt.textContent = `Sending failed: ${sync.lastError} (${sync.pending} pending)`;
  } else {
    dot.dataset.state = "ok";
    txt.textContent = sync.pending
      ? `Sending to the collector · ${sync.pending} pending`
      : "Everything has been sent.";
  }
}

els.metricsOn.addEventListener("change", async () => {
  await chrome.runtime
    .sendMessage({ type: "METRICS_SET_ENABLED", enabled: els.metricsOn.checked })
    .catch(() => {});
  refreshMetricsView();
});

els.metricsFlush.addEventListener("click", async () => {
  els.metricsFlush.disabled = true;
  await chrome.runtime.sendMessage({ type: "METRICS_FLUSH" }).catch(() => {});
  els.metricsFlush.disabled = false;
  refreshMetricsView();
});

els.metricsExport.addEventListener("click", async () => {
  const data = await chrome.runtime.sendMessage({ type: "METRICS_EXPORT" }).catch(() => null);
  if (!data) return;
  // The installId goes in the file name, so that when several files are
  // collected it is clear which is which.
  const name = `metrics-${data.installId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

els.metricsClear.addEventListener("click", async () => {
  if (!confirm("Delete all collected metrics? This cannot be undone.")) return;
  await chrome.runtime.sendMessage({ type: "METRICS_CLEAR" }).catch(() => {});
  refreshMetricsView();
});

loadSettings();
loadWatchSettings();
restoreSession(); // bring back the conversation the panel had when it closed
loadMedFields(); // chat needs the field list too, not just the Form view
refreshChipsForActiveTab();
// The backend has to be loaded BEFORE the connection check, or the check would
// run against the defaults and the banner would lie on first open.
loadBackendSettings().then(checkConnection);
els.input.focus();
