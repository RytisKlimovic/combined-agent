"use strict";

// Service worker for both halves of the extension:
//
//  1. The side-panel agent — opens the side panel (there is no popup) and owns
//     the right-click menu.
//  2. Form autofill — orchestrates form-draft generation and dictation for the
//     content script (all network calls live here, never in the page).
//
// PRIVACY: patient context only passes through here. It is never written to
// chrome.storage and never logged (see DEBUG below).

import "./content/field-map.js"; // side effect: populates globalThis.SCRIBE_FIELDS
import { buildMessages, buildDistributionMessages, parseDistribution } from "./lib/prompt-templates.js";
import { generate, generateStream, testConnection } from "./lib/vllm-client.js";
import { getSettings, validate, validateAsr } from "./lib/settings.js";
import { DictationSession, correctTranscript, testAsrConnection } from "./lib/asr-client.js";
import * as metrics from "./lib/metrics.js";

const { FIELD_MAP } = globalThis.SCRIBE_FIELDS;

/** Marker the model leaves where a fact is missing. Mirrors TODO in prompt-templates.js. */
const TODO_RE = /\[TO CONFIRM\]/g;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
//
// The service worker is the ONLY place that writes metrics — just as it is the
// only place that touches the network. The content script and the panel send
// "METRIC" messages; what happens to them is lib/metrics.js's decision.
//
// Why not in the content script: (1) the collector address would not leak into
// the host application's page, (2) IndexedDB would live in the page's origin
// rather than the extension's.

const METRICS_ALARM = "metrics-flush";

chrome.runtime.onInstalled.addListener(() => {
  metrics.getInstallId(); // create the pseudonym up front
  chrome.alarms.create(METRICS_ALARM, { periodInMinutes: 15 });
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(METRICS_ALARM, { periodInMinutes: 15 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // flush() itself does nothing while ENDPOINTS.metrics is empty (stage 1).
  if (alarm.name === METRICS_ALARM) metrics.flush().catch(() => {});
});

// ===========================================================================
// Side panel + context menu
// ===========================================================================

const MENU_ID = "ask-scribe-agent";

// Track the most recent NORMAL window so we always have somewhere to host the
// side panel, even when the user is acting inside a popup window.
let lastNormalWindowId = null;

async function noteWindow(windowId) {
  if (windowId == null || windowId < 0) return;
  try {
    const w = await chrome.windows.get(windowId);
    if (w && w.type === "normal") lastNormalWindowId = w.id;
  } catch (_) {}
}
chrome.windows.onFocusChanged.addListener(noteWindow);
chrome.windows
  .getLastFocused()
  .then((w) => {
    if (w?.type === "normal") lastNormalWindowId = w.id;
  })
  .catch(() => {});
chrome.windows
  .getAll()
  .then((ws) => {
    if (lastNormalWindowId == null) {
      const n = ws.find((w) => w.type === "normal");
      if (n) lastNormalWindowId = n.id;
    }
  })
  .catch(() => {});

// A window that can host the side panel: the source if it's usable, else the
// last normal window we saw.
function panelWindowFor(sourceWindowId) {
  return lastNormalWindowId ?? sourceWindowId;
}

// Clicking the toolbar icon opens the side panel directly (normal windows only —
// popup windows have no toolbar). Set at every worker start.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Keyboard shortcut. In a normal window it just opens the panel; in a popup
// window it opens the panel in a normal window and seeds a capture of the popup.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-panel") return;
  try {
    const win = await chrome.windows.getCurrent({ populate: true });
    if (win.type === "normal") {
      await chrome.sidePanel.open({ windowId: win.id });
      return;
    }
    await chrome.sidePanel.open({ windowId: panelWindowFor(win.id) });
    const t = (win.tabs || []).find((x) => x.active) || (win.tabs || [])[0];
    if (t) {
      chrome.storage.session.set({
        pendingAsk: { type: "page", selectionText: "", srcUrl: "", tabId: t.id, windowId: win.id, ts: Date.now() },
      });
    }
  } catch (_) {}
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Ask Scribe Agent about this",
      // "link" covers the most common way a document is met: a file in a
      // SharePoint / Nextcloud listing, an attachment in webmail, a document
      // annexed to a record — the panel fetches and reads it instead of
      // screenshotting a list.
      contexts: ["selection", "image", "link", "page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;

  // Open the panel in a panel-capable window inside the click gesture (before
  // any await). The payload keeps the SOURCE window/tab so the panel captures
  // the right thing even when that's a popup window.
  const opening = chrome.sidePanel.open({ windowId: panelWindowFor(tab.windowId) }).catch(() => {});

  const payload = {
    // Selection wins over image and link: if the user highlighted text (even
    // over an <embed>/PDF or inside a link), they're asking about the text.
    type: info.selectionText
      ? "selection"
      : info.srcUrl
      ? "image"
      : info.linkUrl
      ? "link"
      : "page",
    selectionText: info.selectionText || "",
    srcUrl: info.srcUrl || "",
    linkUrl: info.linkUrl || "",
    tabId: tab.id,
    windowId: tab.windowId,
    ts: Date.now(),
  };

  opening.finally(() => {
    chrome.storage.session.set({ pendingAsk: payload });
  });
});

// ===========================================================================
// Form autofill — generation and dictation
// ===========================================================================

/**
 * MUST STAY false IN PRODUCTION.
 * true logs prompts and responses to the console — that is a PHI leak.
 */
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log("[scribe-agent]", ...args);
}

/** Active generation requests: port -> AbortController */
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Generation (port-based, so streaming works)
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scribe-generate") return;

  const controller = new AbortController();
  inFlight.set(port, controller);

  port.onDisconnect.addListener(() => {
    controller.abort();
    inFlight.delete(port);
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "ABORT") {
      controller.abort();
      return;
    }
    if (msg?.type !== "START") return;

    const startedAt = Date.now();

    try {
      // The draft is never cached — it goes straight to the page's review
      // overlay and lives only there, so no PHI stays in the extension's
      // memory.
      const text = await runGeneration(msg, controller.signal, (delta) => {
        safePost(port, { type: "CHUNK", delta });
      });

      safePost(port, { type: "DONE", text });

      // Metrics: LENGTH and timing only, never the text itself.
      const settings = await getSettings();
      metrics.record("draft.generated", {
        fieldKey: msg.fieldKey,
        ms: Date.now() - startedAt,
        chars: text.length,
        todoMarkers: (text.match(TODO_RE) || []).length,
        hasSource: msg.hasSource,
        stream: !!settings.stream,
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        safePost(port, { type: "ABORTED" });
      } else {
        log("generation error", err);
        safePost(port, { type: "ERROR", message: humanError(err) });
        metrics.record("error", {
          where: "generate",
          kind: metrics.errorKind(err),
          httpStatus: metrics.errorStatus(err),
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Dictation (port-based: audio to the WebSocket, text back)
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scribe-dictate") return;

  /** @type {DictationSession|null} */
  let session = null;
  let ended = false;

  // Metrics: volume only. Nothing here touches the audio or the transcript.
  const stats = { startedAt: 0, segments: 0, chars: 0, corrected: false, mode: "single" };

  /**
   * The session metric is written ON DISCONNECT rather than on "STOP": the
   * user may simply close the overlay or the tab, and then "STOP" never
   * arrives. This way abandoned sessions are not lost — and those are the
   * most interesting ones.
   */
  const cleanup = () => {
    session?.close();
    session = null;

    if (stats.startedAt) {
      metrics.record("dictation.session", {
        seconds: Math.round((Date.now() - stats.startedAt) / 1000),
        segments: stats.segments,
        chars: stats.chars,
        corrected: stats.corrected,
        mode: stats.mode,
      });
      stats.startedAt = 0; // so it is not recorded twice
    }
  };

  port.onDisconnect.addListener(cleanup);

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg?.type) {
        case "START": {
          const settings = await getSettings();
          const errors = validateAsr({ ...settings, asrEnabled: true });
          if (errors.length) {
            safePost(port, { type: "ERROR", message: errors.join(" ") });
            return;
          }

          session = new DictationSession({
            endpoint: settings.asrEndpoint,
            onPartial: (text) => safePost(port, { type: "PARTIAL", text }),
            // The server sends "final" both after 'segment' and after 'end'.
            // Accumulation happens in the content script — it knows when the
            // user stopped speaking.
            onFinal: (text) => {
              stats.segments++;
              stats.chars += String(text ?? "").length;
              safePost(port, { type: "FINAL", text, ended });
            },
            onError: (message) => safePost(port, { type: "ERROR", message }),
          });

          await session.open();
          safePost(port, { type: "READY" });
          log("dictation started"); // metadata only, never content

          stats.startedAt = Date.now();
          stats.mode = msg.mode === "global" ? "global" : "single";
          break;
        }

        case "AUDIO": {
          if (!session) return;
          // base64 -> ArrayBuffer (binary data does not survive a port).
          const bin = atob(msg.pcm);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          session.sendAudio(bytes.buffer);
          break;
        }

        case "SEGMENT":
          session?.segment();
          break;

        case "STOP":
          ended = true;
          session?.end();
          break;

        case "CORRECT": {
          // Transcript -> punctuation, clinical terminology, safety rules.
          // On failure asr-client returns the original rather than throwing —
          // an uncorrected text beats a lost dictation.
          const settings = await getSettings();
          const { text, corrected } = await correctTranscript({
            endpoint: settings.asrEndpoint,
            text: msg.text,
          });
          if (corrected) stats.corrected = true;
          safePost(port, { type: "CORRECTED", text, corrected });
          break;
        }

        case "DISTRIBUTE": {
          // Route the dictated text into the form fields.
          const settings = await getSettings();
          const errors = validate(settings);
          if (errors.length) {
            safePost(port, {
              type: "DISTRIBUTE_ERROR",
              message: `Invalid configuration: ${errors.join(" ")}`,
            });
            return;
          }

          const messages = buildDistributionMessages(
            msg.fields,
            msg.transcript,
            settings.systemPromptOverride
          );

          log("distributing to", msg.fields?.length, "fields"); // metadata only
          const distStartedAt = Date.now();

          // No streaming — the full JSON is needed, not chunks.
          // maxTokens with headroom: output ~= input, at roughly 3 characters
          // per token.
          const budget = Math.min(4096, Math.ceil(String(msg.transcript ?? "").length / 2) + 1024);

          try {
            const params = {
              endpoint: settings.vllmEndpoint,
              model: settings.model,
              apiKey: settings.apiKey,
              messages,
              maxTokens: budget,
              temperature: Number(settings.temperature),
            };

            // Use the SAME transport as generation (see runGeneration). In
            // some deployments the model server sits behind a proxy that
            // handles non-streaming requests differently (405 Method Not
            // Allowed has happened), so no separate path is introduced here.
            // The JSON is assembled from the stream.
            const raw = settings.stream
              ? await generateStream({ ...params, onDelta: () => {} })
              : await generate(params);

            const { assignments, unassigned } = parseDistribution(raw, msg.fields);
            safePost(port, { type: "DISTRIBUTED", assignments, unassigned });

            metrics.record("dictation.distributed", {
              fields: msg.fields?.length ?? 0,
              assigned: Object.keys(assignments ?? {}).length,
              // `unassigned` is TEXT — only its length goes into metrics.
              unassigned: String(unassigned ?? "").length,
              ms: Date.now() - distStartedAt,
            });
          } catch (err) {
            // If routing fails the transcript is NOT LOST — the content script
            // shows it as "unassigned".
            log("distribute failed", err);
            safePost(port, { type: "DISTRIBUTE_ERROR", message: humanError(err) });
            metrics.record("error", {
              where: "distribute",
              kind: metrics.errorKind(err),
              httpStatus: metrics.errorStatus(err),
            });
          }
          break;
        }
      }
    } catch (err) {
      log("dictation error", err);
      safePost(port, { type: "ERROR", message: humanError(err) });
      metrics.record("error", {
        where: "dictate",
        kind: metrics.errorKind(err),
        httpStatus: metrics.errorStatus(err),
      });
      cleanup();
    }
  });
});

/** The port may already be disconnected (panel closed) — do not throw. */
function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    /* port closed */
  }
}

async function runGeneration({ fieldKey, context }, signal, onDelta) {
  const field = FIELD_MAP[fieldKey];
  if (!field) throw new Error(`Unknown field: ${fieldKey}`);

  const settings = await getSettings();
  const errors = validate(settings);
  if (errors.length) {
    throw new Error(`Invalid configuration: ${errors.join(" ")}`);
  }

  const messages = buildMessages(field.template, context, settings.systemPromptOverride);
  const maxTokens = field.maxTokens ?? settings.maxTokens;

  const params = {
    endpoint: settings.vllmEndpoint,
    model: settings.model,
    apiKey: settings.apiKey,
    messages,
    maxTokens,
    temperature: Number(settings.temperature),
    signal,
  };

  log("generating", fieldKey, `(${maxTokens} tok)`); // metadata only, never content

  return settings.stream ? generateStream({ ...params, onDelta }) : generate(params);
}

function humanError(err) {
  const msg = err?.message || String(err);
  // The endpoint is user-configurable, so every one of these points at the
  // setting that would actually fix it.
  if (/Failed to fetch/i.test(msg)) {
    return "Could not reach the model server. Check the endpoint in Settings, and that the server is running.";
  }
  if (/401|403/.test(msg)) {
    return "The model server rejected the request. Check the API key in Settings.";
  }
  if (/404/.test(msg)) {
    return "Not found (404). Check the endpoint and the model name in Settings — the endpoint may need the full /chat/completions path.";
  }
  return msg;
}

// ---------------------------------------------------------------------------
// One-off messages (the side panel's "Form" card / the content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "TEST_CONNECTION": {
          const settings = await getSettings();
          sendResponse(
            await testConnection({ endpoint: settings.vllmEndpoint, apiKey: settings.apiKey })
          );
          break;
        }

        case "TEST_ASR": {
          const settings = await getSettings();
          sendResponse(await testAsrConnection({ endpoint: settings.asrEndpoint }));
          break;
        }

        // -- Metrics -------------------------------------------------------
        //
        // The only route by which the content script and the panel can record
        // an event. `record()` passes everything through sanitize(), so even
        // if a sender attached patient text it would be dropped.
        case "METRIC": {
          await metrics.record(msg.event, msg.data);
          sendResponse({ ok: true });
          break;
        }

        case "METRICS_EXPORT":
          sendResponse(await metrics.exportAll());
          break;

        case "METRICS_STATE":
          sendResponse({
            enabled: await metrics.isEnabled(),
            count: await metrics.count(),
            sync: await metrics.syncState(),
          });
          break;

        // Manual flush — for diagnostics. Without it, a misconfigured
        // collector would only become visible at the next alarm (15 min).
        case "METRICS_FLUSH": {
          const sent = await metrics.flush();
          sendResponse({ ok: true, sent, sync: await metrics.syncState() });
          break;
        }

        case "METRICS_SET_ENABLED":
          await metrics.setEnabled(!!msg.enabled);
          sendResponse({ ok: true, enabled: !!msg.enabled });
          break;

        case "METRICS_CLEAR":
          await metrics.clearAll();
          sendResponse({ ok: true });
          break;

        case "FIELDS_CHANGED":
          // Aimed at the side panel; here we just close the request quietly.
          sendResponse({ ok: true });
          break;

        case "GET_ASR_STATE": {
          const s = await getSettings();
          sendResponse({ enabled: !!s.asrEnabled && !!s.asrEndpoint });
          break;
        }

        case "GET_FIELD_MAP": {
          // For the panel — metadata only, no selectors.
          sendResponse(
            Object.fromEntries(
              Object.entries(FIELD_MAP).map(([k, v]) => [k, { label: v.label, maxTokens: v.maxTokens }])
            )
          );
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ error: humanError(err) });
    }
  })();

  return true; // asynchronous sendResponse
});
