/**
 * settings.js — extension configuration.
 *
 * The model server, the model name and an optional API key are configurable
 * from the side panel's Settings view and stored in `chrome.storage.local`.
 * The constants below are only the DEFAULTS.
 *
 * There is deliberately no patient data here, and there never can be.
 *
 * `getSettings()` is the single read path. It is async because it reads
 * storage, and every caller already awaited it back when the values were
 * frozen constants — which is why making them configurable touched no call
 * site.
 */

/** Default network addresses. Overridable from the UI (except `metrics`). */
export const ENDPOINTS = Object.freeze({
  /** OpenAI-compatible chat completions server. */
  llm: 'http://localhost:8000',
  /** Model name served by `llm`. */
  model: 'Qwen/Qwen3-30B-A3B-FP8',
  /** Speech-to-text server (WS /ws, GET /health, POST /api/llm-correct). */
  asr: 'http://localhost:8001',
  /**
   * Usage-metrics collector (POST /v1/events). NOT user-configurable — see
   * resolveCollector in metrics.js, which prefers an enterprise policy.
   *
   * WHEN THIS IS SET, metrics are sent AUTOMATICALLY from every browser
   * running this build — every 15 minutes, in the background, with no
   * configuration on the user's machine and no action by them. An empty value
   * means metrics are only accumulated locally and exported by hand from the
   * side panel.
   */
  metrics: '',
});

/**
 * Pages that may contain patient data — the same ones the content script runs
 * on (see `content_scripts.matches` in manifest.json).
 *
 * Their content is NEVER written to disk: chat history (IndexedDB) and
 * conversation restore (storage.session) are skipped on these pages. The
 * form-filling side stores nothing anyway — this makes both sides consistent.
 */
const CLINICAL_HOSTS = ['localhost', '127.0.0.1'];

/** Demo forms shipped with the extension, opened over file://. */
const DEMO_FORMS = /(visit-note|discharge-summary)\.html(\?|#|$)/i;

/** @param {string} url @returns {boolean} */
export function isClinicalUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return false;

  // The demo forms open over file:// — hostname is empty then.
  if (DEMO_FORMS.test(raw)) return true;

  try {
    return CLINICAL_HOSTS.includes(new URL(raw).hostname);
  } catch {
    return false; // not a URL — better not to block history for no reason
  }
}

export const DEFAULTS = Object.freeze({
  vllmEndpoint: ENDPOINTS.llm,
  model: ENDPOINTS.model,
  apiKey: '',
  temperature: 0.2,
  maxTokens: 600,
  stream: true,
  systemPromptOverride: '',

  asrEndpoint: ENDPOINTS.asr,
  asrEnabled: true,
  /** Whether to post-process transcripts via /api/llm-correct (punctuation, terminology). */
  asrCorrect: true,
});

/**
 * The keys the UI is allowed to write. Anything else in DEFAULTS stays fixed,
 * so a stray storage entry cannot, say, disable streaming or rewrite the
 * system prompt.
 */
export const CONFIGURABLE = Object.freeze(['vllmEndpoint', 'model', 'apiKey', 'asrEndpoint']);

/**
 * Whether the configured model server is somewhere other than this machine.
 *
 * Used by the UI to warn that page content — which in a clinical deployment
 * means patient data — would leave the computer. Not a technical restriction:
 * a deliberate choice belongs to the user, an accidental one does not.
 */
export function isLocalEndpoint(endpoint) {
  try {
    const host = new URL(String(endpoint ?? '')).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Reads the stored overrides on top of DEFAULTS. */
export async function getSettings() {
  const base = { ...DEFAULTS };
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return base;

  try {
    const stored = await chrome.storage.local.get(CONFIGURABLE);
    for (const key of CONFIGURABLE) {
      const v = stored?.[key];
      // A blank string means "not configured", so the default applies. The one
      // exception is apiKey, where blank is a legitimate value (a local server
      // needs none).
      if (typeof v !== 'string') continue;
      if (key === 'apiKey') base[key] = v;
      else if (v.trim()) base[key] = v.trim();
    }
  } catch {
    /* storage unavailable — the defaults are still a working configuration */
  }
  return base;
}

/**
 * Persists a subset of the configurable keys. Returns the resulting settings,
 * so a caller can re-render from exactly what was saved.
 * @param {Partial<Record<'vllmEndpoint'|'model'|'apiKey'|'asrEndpoint', string>>} patch
 */
export async function saveSettings(patch) {
  const write = {};
  for (const key of CONFIGURABLE) {
    if (patch && typeof patch[key] === 'string') write[key] = patch[key].trim();
  }
  if (Object.keys(write).length && typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set(write);
  }
  return getSettings();
}

/** Restores the built-in defaults by clearing the stored overrides. */
export async function resetSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.remove(CONFIGURABLE);
  }
  return getSettings();
}

/**
 * @returns {string[]} list of errors; empty means the configuration is valid
 */
export function validate(settings) {
  const errors = [];

  if (!settings.vllmEndpoint) {
    errors.push('No model endpoint configured.');
  } else {
    try {
      const u = new URL(settings.vllmEndpoint);
      if (!/^https?:$/.test(u.protocol)) errors.push('The model endpoint must be http:// or https://');
    } catch {
      errors.push('The model endpoint is not a valid URL.');
    }
  }

  if (!settings.model) errors.push('No model name configured.');

  const t = Number(settings.temperature);
  if (!Number.isFinite(t) || t < 0 || t > 2) errors.push('temperature must be between 0 and 2.');

  const m = Number(settings.maxTokens);
  if (!Number.isInteger(m) || m < 1 || m > 8192) errors.push('maxTokens must be between 1 and 8192.');

  return errors;
}

/**
 * The ASR configuration is validated SEPARATELY from the model server's —
 * dictation is an extra feature, so its errors must not block text generation.
 * @returns {string[]} list of errors; empty means valid
 */
export function validateAsr(settings) {
  const errors = [];
  if (!settings.asrEnabled) return errors;

  if (!settings.asrEndpoint) {
    errors.push('Dictation is enabled but no transcription endpoint is configured.');
  } else {
    try {
      const u = new URL(settings.asrEndpoint);
      if (!/^https?:$/.test(u.protocol)) errors.push('The transcription endpoint must be http:// or https://');
    } catch {
      errors.push('The transcription endpoint is not a valid URL.');
    }
  }
  return errors;
}

/** http(s):// -> ws(s):// for the WebSocket. */
export function toWsUrl(endpoint, path = '/ws') {
  const u = new URL(endpoint);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}${path}`;
  return u.toString();
}
