/**
 * metrics.js — usage metrics.
 *
 * ===========================================================================
 * THE UNBREAKABLE RULE
 * ===========================================================================
 * Not one character of patient text ever reaches the metrics. Not a draft, not
 * a transcript, not a prompt, and not the text of an error message (an error
 * body can echo the prompt — see readError in lib/vllm-client.js).
 *
 * This rule is NOT upheld here by good intentions. It is enforced structurally:
 *
 *   1. SCHEMA is an ALLOW-LIST of fields. Anything not described there is
 *      dropped.
 *   2. Only NUMBERS, BOOLEANS and fixed `Set` enums are permitted. There are
 *      NO free-text fields at all. Inserting patient text is therefore
 *      impossible even by accident — there is nowhere for it to go.
 *   3. Objects and arrays are rejected.
 *
 * That makes `sanitize()` the only route into storage, and
 * tests/metrics.test.mjs tests precisely this invariant. When adding a new
 * event: the schema comes first.
 *
 * ===========================================================================
 * STAGED ROLLOUT
 * ===========================================================================
 * Stage 1 (current): events accumulate LOCALLY only (lib/metrics-store.js) and
 *   the user exports a JSON file from the side panel. The data never leaves
 *   the machine, so no collector and no separate agreement is needed.
 * Stage 2 (once there are more than a handful of users): ENDPOINTS.metrics is
 *   filled in and flush() starts sending batches. The code is the same — only
 *   the egress point differs.
 */

import '../content/field-map.js'; // side effect: populates globalThis.SCRIBE_FIELDS
import { ENDPOINTS } from './settings.js';
import { PRESET_IDS } from '../presets.js';
import * as store from './metrics-store.js';

const { FIELD_MAP } = globalThis.SCRIBE_FIELDS;

/** Schema version. Bump it when fields change, so analysis knows what it reads. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Types and enums
// ---------------------------------------------------------------------------

export const NUM = 'num';
export const BOOL = 'bool';

/**
 * The `fieldKey` enum is derived BY CONSTRUCTION — it is the FIELD_MAP keys
 * (`history_of_illness`, `objective_status`, ...). Those are code identifiers,
 * not data, so they are safe; and if anything tries to push something else
 * through, it simply gets dropped.
 */
const FIELD = new Set(Object.keys(FIELD_MAP));

/** Preset ids from presets.js — stable and language-independent. */
const PRESET = new Set([...PRESET_IDS, 'custom']);

const REASON = new Set(['close', 'abort', 'error']);
const MODE = new Set(['single', 'global']);
const SCOPE = new Set(['viewport', 'whole']);

/** Where the document came from: the tab, a manual upload, or a link. */
const DOC_SOURCE = new Set(['tab', 'file', 'link']);

/** Document type. A file name NEVER reaches the metrics — only the format. */
const DOC_KIND = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'gdoc', 'gsheet', 'gslides', 'image']);

/** Agent tools. The names are code identifiers, not data. */
const AGENT_TOOL = new Set([
  'read_current_page', 'list_form_fields', 'read_document', 'fill_fields',
  'search_guidelines', 'get_patient_documents',
]);

/** Where the error happened. */
const WHERE = new Set(['generate', 'dictate', 'correct', 'distribute', 'chat']);

/**
 * The error CATEGORY, never the text. Error text never reaches the metrics —
 * a 4xx body from the model server can contain an echoed prompt with PHI.
 */
const KIND = new Set(['network', 'auth', 'notfound', 'timeout', 'parse', 'config', 'other']);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SCHEMA = Object.freeze({
  'draft.generated': { fieldKey: FIELD, ms: NUM, chars: NUM, todoMarkers: NUM, hasSource: BOOL, stream: BOOL },

  // The most important event: editedPct = what percentage of the draft the
  // clinician rewrote.
  // editedPct can be null ("not measured", text too long) — that is NOT zero.
  'draft.inserted': {
    fieldKey: FIELD, msOpen: NUM, chars: NUM,
    editedPct: NUM, editedWords: NUM, totalWords: NUM,
    todoMarkers: NUM, regens: NUM,
  },

  'draft.discarded': { fieldKey: FIELD, msOpen: NUM, chars: NUM, regens: NUM, reason: REASON },
  'draft.regenerated': { fieldKey: FIELD, attempt: NUM },

  'dictation.session': { seconds: NUM, segments: NUM, chars: NUM, corrected: BOOL, mode: MODE },
  'dictation.distributed': { fields: NUM, assigned: NUM, unassigned: NUM, ms: NUM },

  'chat.asked': {
    preset: PRESET, scope: SCOPE, withText: BOOL, wholeDoc: BOOL,
    hasImage: BOOL, clinicalForm: BOOL, ms: NUM, answerChars: NUM,
  },

  // Reading a scanned document. No file name, no text — volume only.
  'doc.ocr': { pages: NUM, ms: NUM, chars: NUM, aborted: BOOL, source: DOC_SOURCE },

  // Reading any document (PDF, Office, a cloud file).
  'doc.read': { kind: DOC_KIND, source: DOC_SOURCE, chars: NUM, ms: NUM, ok: BOOL },

  // The agent loop: how many steps, how long, finished or interrupted.
  'agent.run': { steps: NUM, ms: NUM, ok: BOOL, stopped: BOOL },
  // One tool invocation: which tool, whether it worked, how long. No arguments.
  'agent.tool': { tool: AGENT_TOOL, ok: BOOL, ms: NUM },

  'error': { where: WHERE, kind: KIND, httpStatus: NUM },

  'session.active': {},
});

// ---------------------------------------------------------------------------
// Sanitisation — the only route into storage
// ---------------------------------------------------------------------------

/**
 * @returns {{event:string, data:object}|null} null = the event is dropped entirely
 */
export function sanitize(event, data) {
  const fields = SCHEMA[event];
  if (!fields) return null; // unknown event — discard

  const out = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(data ?? {}, key)) continue;
    const v = data[key];

    // null is permitted ONLY for numerics, and means "not measured" (see editedPct).
    if (v === null && spec === NUM) {
      out[key] = null;
      continue;
    }
    if (v === undefined || v === null) continue;

    if (spec === NUM) {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      continue; // numeric strings ("5") are NOT coerced — that would be a hole
    }
    if (spec === BOOL) {
      if (typeof v === 'boolean') out[key] = v;
      continue;
    }
    if (spec instanceof Set) {
      if (typeof v === 'string' && spec.has(v)) out[key] = v;
      continue;
    }
  }

  // Unknown keys can never get in: we iterate over SCHEMA, not over data.
  return { event, data: out };
}

/** Error object -> CATEGORY. The only place this classification happens. */
export function errorKind(err) {
  const msg = err?.message || String(err ?? '');
  if (err?.name === 'AbortError' || /timeout|timed out/i.test(msg)) return 'timeout';
  if (/Failed to fetch|NetworkError|ERR_/i.test(msg)) return 'network';
  if (/\b(401|403)\b/.test(msg)) return 'auth';
  if (/\b404\b/.test(msg)) return 'notfound';
  if (/JSON|unexpected response shape|parse/i.test(msg)) return 'parse';
  if (/Invalid configuration|No .{0,40}(endpoint|name) configured|not a valid URL/i.test(msg)) return 'config';
  return 'other';
}

/** The HTTP status out of an error message (the number only, no text). */
export function errorStatus(err) {
  const m = /\b(4\d\d|5\d\d)\b/.exec(err?.message || '');
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// The event envelope and writing
// ---------------------------------------------------------------------------

/** A session = one service-worker lifetime. Enough to group events by. */
const sessionId = randomId();

let installIdPromise = null;
let enabledCache = null;

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * A pseudonym created at install time. NOT tied to the user's identity — it
 * makes it possible to count active users without knowing who they are.
 */
export async function getInstallId() {
  if (installIdPromise) return installIdPromise;
  installIdPromise = (async () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return 'dev';
    const { installId } = await chrome.storage.local.get('installId');
    if (installId) return installId;
    const fresh = randomId();
    await chrome.storage.local.set({ installId: fresh });
    return fresh;
  })();
  return installIdPromise;
}

/**
 * Whether metrics are enabled.
 *
 * `managed` (organisation policy) TAKES PRECEDENCE over the user's choice, so
 * an organisation can switch metrics off centrally and the user cannot switch
 * them back on. It does NOT work the other way round: if the organisation
 * enables them, the user can still opt out (`metricsEnabled` in local
 * storage). Transparency matters more than the data.
 */
export async function isEnabled() {
  if (enabledCache !== null) return enabledCache;
  if (typeof chrome === 'undefined' || !chrome.storage) return false;

  try {
    const managed = await chrome.storage.managed?.get('metricsEnabled').catch(() => ({}));
    if (managed && managed.metricsEnabled === false) return (enabledCache = false);
  } catch {
    /* no managed policy — that is normal */
  }
  const { metricsEnabled } = await chrome.storage.local.get('metricsEnabled');
  return (enabledCache = metricsEnabled !== false); // enabled by default
}

/** The user's toggle in the panel. */
export async function setEnabled(on) {
  enabledCache = !!on;
  await chrome.storage.local.set({ metricsEnabled: !!on });
}

/** Clears the cache after the setting changes in another context. */
export function invalidateEnabledCache() {
  enabledCache = null;
}

/**
 * Records an event. NEVER throws and never blocks the UI — telemetry must not
 * be able to break the user's work.
 */
export async function record(event, data = {}) {
  try {
    if (!(await isEnabled())) return;

    const clean = sanitize(event, data);
    if (!clean) return;

    await store.append({
      v: SCHEMA_VERSION,
      ts: Date.now(),
      installId: await getInstallId(),
      sessionId,
      event: clean.event,
      data: clean.data,
    });
  } catch {
    /* metrics never cause disruption */
  }
}

// ---------------------------------------------------------------------------
// Sending (stage 2) and exporting (stage 1)
// ---------------------------------------------------------------------------

const BATCH = 500;

/** The last send error — shown in the panel's settings for diagnostics. */
let lastFlushError = '';

/**
 * The collector address and token.
 *
 * Organisation policy (`chrome.storage.managed`) wins, because:
 *   - the same build then suits any deploying organisation;
 *   - the ingest token stays out of the code and out of git;
 *   - an IT department can turn sending off without repackaging the extension.
 *
 * With no policy set, fall back to ENDPOINTS.metrics (empty by default, i.e.
 * nothing is sent and metrics only accumulate locally).
 *
 * @returns {Promise<{endpoint: string, token: string}>}
 */
async function resolveCollector() {
  let managed = {};
  try {
    managed = (await chrome.storage.managed?.get(['metricsEndpoint', 'metricsToken'])) ?? {};
  } catch {
    /* no managed policy — that is normal */
  }
  return {
    endpoint: String(managed.metricsEndpoint || ENDPOINTS.metrics || '').trim(),
    token: String(managed.metricsToken || '').trim(),
  };
}

/**
 * Sends the accumulated events. With no collector configured it does nothing,
 * and events keep accumulating locally for export.
 * @returns {Promise<number>} how many events were sent
 */
export async function flush() {
  const { endpoint, token } = await resolveCollector();
  if (!endpoint) return 0;

  try {
    const batch = await store.readBatch(BATCH);
    if (!batch.length) return 0;

    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // `id` is the local IndexedDB key — the collector does not need it.
      body: JSON.stringify({ events: batch.map(({ id, ...e }) => e) }),
    });

    // Delete ONLY after a 2xx — otherwise a broken collector would mean lost
    // data. The collector treats duplicates as accepted (`on conflict do
    // nothing`), so resending after a dropped connection does not wedge the
    // buffer forever.
    if (!res.ok) {
      lastFlushError = `HTTP ${res.status}`;
      return 0;
    }
    await store.remove(batch.map((e) => e.id));
    lastFlushError = '';
    return batch.length;
  } catch (err) {
    // Silent as far as the user is concerned, BUT the reason is kept: without
    // this, a misconfigured endpoint would mean metrics simply never arrive
    // and nobody finds out until the buffer fills.
    lastFlushError = err?.message || String(err);
    return 0;
  }
}

/** Send status, for the panel. */
export async function syncState() {
  const { endpoint, token } = await resolveCollector();
  return {
    configured: !!endpoint,
    endpoint,
    hasToken: !!token,
    lastError: lastFlushError,
    pending: await store.count(),
  };
}

/** Stage 1: everything into a JSON file the user downloads. */
export async function exportAll() {
  const events = await store.readAll();
  return {
    schemaVersion: SCHEMA_VERSION,
    installId: await getInstallId(),
    exportedAt: new Date().toISOString(),
    count: events.length,
    events: events.map(({ id, ...e }) => e),
  };
}

export async function clearAll() {
  await store.clear();
}

export async function count() {
  return store.count();
}
