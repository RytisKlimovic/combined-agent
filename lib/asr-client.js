/**
 * asr-client.js — client for the streaming speech-to-text server.
 *
 * Called ONLY from the service worker: that sidesteps the page's CSP/CORS and
 * keeps to the rule that all network traffic goes through the worker.
 *
 * The server contract:
 *   WS  /ws                — binary: PCM int16 LE, 16 kHz, mono
 *                            text:   "segment" (close the sentence, carry on)
 *                                    "end"     (end the session)
 *                            <- {type:"partial"|"final"|"error", text}
 *   GET /health            -> {status:"ready"|"loading"|"error"}
 *   POST /api/llm-correct  -> {text} -> {text}   (punctuation, terminology, safety)
 */

import { toWsUrl } from './settings.js';

/** The audio format the server expects — the content script must match it. */
export const AUDIO = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  format: 'pcm_s16le',
});

function normalize(endpoint) {
  return String(endpoint || '').trim().replace(/\/+$/, '');
}

/**
 * A live dictation session. Narrow responsibility: hold the WebSocket and
 * forward audio and text. No audio is buffered here — it passes straight
 * through.
 */
export class DictationSession {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint  — the ASR server's http(s) address
   * @param {(text:string)=>void} opts.onPartial — partial (live) result
   * @param {(text:string)=>void} opts.onFinal   — a finished sentence or session
   * @param {(msg:string)=>void}  opts.onError
   */
  constructor({ endpoint, onPartial, onFinal, onError }) {
    this.endpoint = normalize(endpoint);
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.ws = null;
    this.closed = false;
  }

  /** @returns {Promise<void>} resolves once the WebSocket is open */
  open() {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = toWsUrl(this.endpoint, '/ws');
      } catch (err) {
        reject(new Error(`Invalid transcription address: ${err.message}`));
        return;
      }

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new Error(`Could not open the WebSocket: ${err.message}`));
        return;
      }

      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => resolve();

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return; // not JSON — ignore
        }
        if (msg.type === 'partial') this.onPartial?.(msg.text ?? '');
        else if (msg.type === 'final') this.onFinal?.(msg.text ?? '');
        else if (msg.type === 'error') this.onError?.(msg.text || 'Transcription error');
      };

      ws.onerror = () => {
        const e = new Error(
          'Could not connect to the transcription server. Check the address in ' +
            'the settings and that the server is running.'
        );
        if (ws.readyState === WebSocket.CONNECTING) reject(e);
        else this.onError?.(e.message);
      };

      ws.onclose = () => {
        if (!this.closed) this.onError?.('The transcription connection was lost.');
        this.closed = true;
      };
    });
  }

  /** @param {ArrayBuffer} buf — PCM int16 LE @16kHz */
  sendAudio(buf) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Closes the current sentence; the session continues (server replies "final"). */
  segment() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('segment');
  }

  /** Ends the session — the server sends one last "final" and closes. */
  end() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('end');
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}

/**
 * Transcript correction: punctuation, clinical terminology, notation (L4-L5).
 * The server-side prompt carries strict safety rules (never change a number,
 * never guess).
 *
 * On failure it returns the ORIGINAL text — an uncorrected transcript beats a
 * lost dictation.
 *
 * @returns {Promise<{text: string, corrected: boolean}>}
 */
export async function correctTranscript({ endpoint, text, signal }) {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', corrected: false };

  try {
    const res = await fetch(`${normalize(endpoint)}/api/llm-correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw }),
      signal,
    });
    if (!res.ok) return { text: raw, corrected: false };

    const data = await res.json();
    const out = String(data?.text ?? '').trim();
    return out ? { text: out, corrected: true } : { text: raw, corrected: false };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { text: raw, corrected: false };
  }
}

/**
 * Connection check. Returns no patient data of any kind.
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 */
export async function testAsrConnection({ endpoint, signal }) {
  try {
    const res = await fetch(`${normalize(endpoint)}/health`, { signal });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data?.status === 'ready') return { ok: true, status: 'ready' };
    if (data?.status === 'loading') return { ok: false, error: 'The model is still loading — please wait.' };
    return { ok: false, error: data?.detail || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
