"use strict";

// Extract text context from the active tab so the model gets URL/title/selection
// and visible text instead of OCR'ing everything from the screenshot. Uses
// activeTab: the user clicked the toolbar icon, which grants access to this tab.

// Runs in the page as its own injection (a serialized `func` can't call another
// function from this file, so it gets its own executeScript call).
//
// Why it exists: form controls are invisible to innerText/textContent. An
// <input> keeps its text in `value`, and a <textarea>'s live value never lands
// in the DOM text either. Without this, anything typed by hand (a doctor
// filling a form) is missing from the context and the model answers, with full
// confidence, that the field is empty.
export function fieldValuesInPage(maxChars) {
  const SKIP = ["hidden", "password", "submit", "button", "reset", "file", "image"];
  const short = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

  // innerText is the honest rendering, but it is empty for hidden/unrendered
  // nodes (and missing outside a real browser) — textContent then carries it.
  const textOf = (el) => (el && (el.innerText || el.textContent)) || "";

  const labelFor = (el) => {
    let lab = "";
    try {
      lab = (el.labels && textOf(el.labels[0])) || el.getAttribute("aria-label") || "";
      if (!lab) {
        // Table-style forms (typical of server-rendered EHRs) keep the caption in
        // the previous cell.
        const cell = el.closest("td, th, div");
        const prev = cell && cell.previousElementSibling;
        const prevText = textOf(prev).replace(/\s+/g, " ").trim();
        if (prevText && prevText.length < 120) lab = prevText;
      }
      if (!lab) lab = el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
    } catch (_) {}
    return short(String(lab).replace(/\s+/g, " ").trim(), 80);
  };

  const seen = new Set();
  const out = [];
  let total = 0;
  let nodes = [];
  try {
    nodes = document.querySelectorAll("input, textarea, select, [contenteditable='true']");
  } catch (_) {}

  for (const el of nodes) {
    const type = String(el.type || "").toLowerCase();
    if (SKIP.indexOf(type) !== -1) continue;

    let value = "";
    if (el.tagName === "SELECT") value = (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].text) || "";
    else if (type === "checkbox" || type === "radio") value = el.checked ? "✓" : "";
    else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") value = textOf(el);
    else value = el.value || "";

    value = String(value).replace(/\s+/g, " ").trim();
    if (!value) continue;

    const line = (labelFor(el) ? labelFor(el) + ": " : "") + short(value, 2000);
    // EHR forms often keep a hidden twin next to every visible input, which
    // would otherwise produce the same line twice.
    if (seen.has(line)) continue;
    seen.add(line);

    out.push(line);
    total += line.length;
    if (total > maxChars) break;
  }
  return out.join("\n");
}

function pageContextInPage(maxChars) {
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "…[truncated]" : s || "");
  let selection = "";
  try {
    selection = String(window.getSelection ? window.getSelection() : "").trim();
  } catch (_) {}
  let text = "";
  try {
    text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  } catch (_) {}
  // Cheap structural signals used to tailor the preset buttons.
  let tables = 0;
  let codeBlocks = 0;
  try {
    tables = document.querySelectorAll("table").length;
    codeBlocks = document.querySelectorAll("pre, code").length;
  } catch (_) {}
  // Absolute URLs of PDFs embedded via <embed>/<object>/<iframe>. Inlined here
  // because this whole function is serialised into the page (no closures).
  const pdfUrls = [];
  try {
    const seen = new Set();
    const add = (u) => {
      if (!u) return;
      try {
        const abs = new URL(u, location.href).href;
        if (!seen.has(abs)) { seen.add(abs); pdfUrls.push(abs); }
      } catch (_) {}
    };
    document.querySelectorAll('embed[type="application/pdf"], embed[src*=".pdf" i]').forEach((e) => add(e.getAttribute("src")));
    document.querySelectorAll('object[type="application/pdf"], object[data*=".pdf" i]').forEach((o) => add(o.getAttribute("data")));
    document.querySelectorAll('iframe[src*=".pdf" i]').forEach((f) => add(f.getAttribute("src")));
  } catch (_) {}
  return {
    url: location.href,
    title: document.title || "",
    selection: clip(selection, 4000),
    text: clip(text, maxChars),
    tables,
    codeBlocks,
    pdfUrls,
  };
}

// Collect what the user has typed, across frames. Separate injection because a
// serialized page function can't call another one from this module.
async function grabFieldValues(tabId, { allFrames = false, maxChars = 6000 } = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      func: fieldValuesInPage,
      args: [maxChars],
    });
    return results
      .map((r) => r.result)
      .filter(Boolean)
      .join("\n")
      .slice(0, maxChars);
  } catch (_) {
    return "";
  }
}

// Returns { url, title, selection, text, fields } or null if injection isn't
// allowed (chrome://, the Web Store, PDFs, blocked pages).
export async function grabPageContext(tabId, { maxChars = 12000 } = {}) {
  if (tabId == null) return null;
  try {
    // Inject into every frame: the selection may live in an iframe while
    // url/title/text come from the top document (frameId 0).
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageContextInPage,
      args: [maxChars],
    });
    if (!results?.length) return null;

    const top = results.find((r) => r.frameId === 0) || results[0];
    const base = top?.result;
    if (!base) return null;

    // Prefer the top frame's selection; fall back to any subframe that has one.
    let selection = base.selection;
    if (!selection) {
      for (const r of results) {
        if (r.result?.selection) { selection = r.result.selection; break; }
      }
    }
    const fields = await grabFieldValues(tabId, { allFrames: true });
    return { ...base, selection, fields };
  } catch (_) {
    return null;
  }
}

// Runs in the page: pull the full main-content text of the document so you can
// ask about the whole thing, not just the viewport. Prefers a semantic content
// root (article/main) to strip nav/menu/footer noise; falls back to the body.
function fullDocumentInPage(maxChars) {
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "…[truncated]" : s || "");
  const clean = (t) =>
    (t || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  let root = null;
  try {
    const main = document.querySelector("main") || document.querySelector('[role="main"]');
    if (main && main.innerText && main.innerText.trim().length > 200) {
      root = main;
    } else {
      // A single <article> is a real article page; many <article>s are a list
      // (e.g. GitHub trending cards) — grabbing the first would drop the rest,
      // so fall through to the body instead.
      const arts = document.querySelectorAll("article");
      if (arts.length === 1 && arts[0].innerText && arts[0].innerText.trim().length > 200) {
        root = arts[0];
      }
    }
  } catch (_) {}
  const src = root || document.body;
  // Use textContent, not innerText: innerText skips content that isn't rendered
  // (off-screen `content-visibility: auto` items, e.g. GitHub's list cards), so
  // it silently drops most of a long list. Clone, strip noise, add block breaks.
  let raw = "";
  try {
    const clone = src.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,svg,template").forEach((e) => e.remove());
    clone
      .querySelectorAll("p,div,li,tr,td,h1,h2,h3,h4,h5,h6,br,section,article,header,footer,pre,blockquote")
      .forEach((el) => el.appendChild(document.createTextNode("\n")));
    raw = clone.textContent || "";
  } catch (_) {
    try {
      raw = src ? src.innerText : "";
    } catch (_) {}
  }
  const text = clean(raw);
  const pdfUrls = [];
  try {
    const seen = new Set();
    const add = (u) => {
      if (!u) return;
      try {
        const abs = new URL(u, location.href).href;
        if (!seen.has(abs)) { seen.add(abs); pdfUrls.push(abs); }
      } catch (_) {}
    };
    document.querySelectorAll('embed[type="application/pdf"], embed[src*=".pdf" i]').forEach((e) => add(e.getAttribute("src")));
    document.querySelectorAll('object[type="application/pdf"], object[data*=".pdf" i]').forEach((o) => add(o.getAttribute("data")));
    document.querySelectorAll('iframe[src*=".pdf" i]').forEach((f) => add(f.getAttribute("src")));
  } catch (_) {}
  return {
    url: location.href,
    title: document.title || "",
    text: clip(text, maxChars),
    chars: text.length,
    pdfUrls,
  };
}

// Returns { url, title, text, chars, fields } or null if injection isn't
// allowed (chrome://, PDFs, blocked pages).
export async function grabFullDocument(tabId, { maxChars = 100000 } = {}) {
  if (tabId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fullDocumentInPage,
      args: [maxChars],
    });
    const doc = results?.[0]?.result;
    if (!doc) return null;
    return { ...doc, fields: await grabFieldValues(tabId) };
  } catch (_) {
    return null;
  }
}

// The active tab in the focused window — the one captureVisibleTab shot.
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
