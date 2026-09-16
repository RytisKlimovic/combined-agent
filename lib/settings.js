/**
 * settings.js — extension configuration.
 *
 * Servers and the model are FIXED in code: an internal tool does not need the
 * user changing them, so there is no options page and nothing is written to
 * chrome.storage. There is no patient data here, and there never can be.
 *
 * The defaults point at localhost so the extension runs against a locally
 * served OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio…)
 * out of the box. In a deployment these constants are the single place to
 * change — nothing else in the codebase hard-codes a host.
 */

/** The only network addresses the extension ever talks to. */
export const ENDPOINTS = Object.freeze({
  /** OpenAI-compatible chat completions server. */
  llm: 'http://localhost:8000',
  /** Model name served by `llm`. */
  model: 'Qwen/Qwen3-30B-A3B-FP8',
  /** Speech-to-text server (WS /ws, GET /health, POST /api/llm-correct). */
  asr: 'http://localhost:8001',
  /**
   * Usage-metrics collector (POST /v1/events).
   *
   * WHEN THIS IS SET, metrics are sent AUTOMATICALLY from every browser
   * running this build — every 15 minutes, in the background, with no
   * configuration on the clinician's machine and no action by them. An empty
   * value means metrics are only accumulated locally and exported by hand
   * from the side panel.
   *
   * No token is set here: a collector on an internal network can run with
   * METRICS_ALLOW_ANON=1. If the endpoint ever becomes reachable from
   * outside, that is no longer enough — then it needs an enterprise policy
   * (`metricsEndpoint` + `metricsToken`, see resolveCollector in metrics.js)
   * or a reverse-proxy allowlist.
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

/** Returns the fixed configuration. Async so call sites stay unchanged. */
export async function getSettings() {
  return { ...DEFAULTS };
}

/**
 * @returns {string[]} list of errors; empty means the configuration is valid
 */
export function validate(settings) {
  const errors = [];

  if (!settings.vllmEndpoint) {
    errors.push('No LLM endpoint configured.');
  } else {
    try {
      const u = new URL(settings.vllmEndpoint);
      if (!/^https?:$/.test(u.protocol)) errors.push('The LLM endpoint must be http:// or https://');
    } catch {
      errors.push('The LLM endpoint is not a valid URL.');
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
 * The ASR configuration is validated SEPARATELY from the LLM one — dictation
 * is an extra feature, so its errors must not block text generation.
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
