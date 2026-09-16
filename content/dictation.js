/**
 * dictation.js — one dictation session: microphone -> service worker -> ASR.
 *
 * Loaded as a classic script -> globalThis.SCRIBE_DICT. The same class is
 * used by the content script (for form fields) and by the side panel (for
 * dictating a chat question), which is why it lives here rather than inside
 * content-script.js.
 *
 * Audio is NEVER stored — chunks pass straight through into the WebSocket.
 * Transcripts do not reach chrome.storage either.
 */
(function () {
  'use strict';

  const { Recorder, micErrorMessage } = globalThis.SCRIBE_AUDIO;

  class Dictation {
    /**
     * @param {object} cb
     * @param {(text:string)=>void} cb.onPartial — live partial text
     * @param {(level:number)=>void} cb.onLevel  — microphone level, 0..1
     * @param {(msg:string)=>void}   cb.onError
     */
    constructor(cb) {
      this.cb = cb;
      this.port = null;
      this.recorder = null;
      this.finalText = '';
      this._resolveFinal = null;
    }

    /**
     * @param {{mode?: 'single'|'global'}} [opts]
     *   `mode` is used ONLY for metrics (single-field dictation vs. global
     *   dictation distributed across many fields). It does not affect
     *   transcription.
     */
    async start(opts = {}) {
      this.port = chrome.runtime.connect({ name: 'scribe-dictate' });

      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The transcription server is not responding (10 s).')),
          10000
        );

        this.port.onMessage.addListener((msg) => {
          switch (msg.type) {
            case 'READY':
              clearTimeout(timer);
              resolve();
              break;

            case 'PARTIAL':
              this.cb.onPartial?.(msg.text);
              break;

            case 'FINAL':
              // The server sends "final" both at the end of a sentence and at
              // the end of the session. Accumulate, because one dictation
              // session can contain several sentences.
              if (msg.text) {
                this.finalText = this.finalText ? `${this.finalText} ${msg.text}` : msg.text;
              }
              this._resolveFinal?.(this.finalText);
              break;

            case 'CORRECTED':
              this._resolveCorrect?.(msg);
              break;

            case 'DISTRIBUTED':
              this._resolveDistribute?.({
                assignments: msg.assignments ?? {},
                unassigned: msg.unassigned ?? '',
              });
              break;

            case 'DISTRIBUTE_ERROR':
              this._resolveDistribute?.({ error: msg.message });
              break;

            case 'ERROR':
              clearTimeout(timer);
              reject(new Error(msg.message));
              this.cb.onError?.(msg.message);
              break;
          }
        });

        this.port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          reject(new Error('The connection to the extension was lost.'));
        });
      });

      this.port.postMessage({ type: 'START', mode: opts.mode === 'global' ? 'global' : 'single' });

      // The WebSocket and the microphone come up IN PARALLEL — each takes
      // about a second and neither depends on the other. Previously the
      // microphone only started after the server acknowledged, so the user
      // waited for the SUM of both.
      //
      // The reason it used to be sequential (so the recording indicator would
      // not light up while audio goes nowhere) stays solved: below, if EITHER
      // one fails, both are torn down cleanly.
      this.recorder = new Recorder(
        (pcm) => this.port?.postMessage({ type: 'AUDIO', pcm }),
        (level) => this.cb.onLevel?.(level)
      );

      const [ws, mic] = await Promise.allSettled([ready, this.recorder.start()]);

      if (ws.status === 'rejected' || mic.status === 'rejected') {
        this.stop(); // stops the microphone AND closes the port
        // The microphone error is shown first — the user can fix that
        // immediately (a browser permission), whereas a server error needs an
        // administrator.
        throw mic.status === 'rejected' ? new Error(micErrorMessage(mic.reason)) : ws.reason;
      }
    }

    /** Stops the microphone and waits for the final transcript. */
    async finish(timeoutMs = 30000) {
      this.recorder?.stop();
      this.recorder = null;

      const final = new Promise((resolve) => {
        this._resolveFinal = resolve;
        setTimeout(() => resolve(this.finalText), timeoutMs);
      });

      this.port?.postMessage({ type: 'STOP' });
      return final;
    }

    /**
     * Routes the dictated text into form fields via the LLM.
     * DOM elements do not travel over the port — only {key,label,critical}.
     *
     * @returns {Promise<{assignments?, unassigned?, error?}>}
     */
    async distribute(fields, transcript, timeoutMs = 120000) {
      if (!this.port) return { error: 'The connection to the extension was lost.' };

      const done = new Promise((resolve) => {
        this._resolveDistribute = resolve;
        setTimeout(() => resolve({ error: 'The model did not respond within 2 minutes.' }), timeoutMs);
      });

      this.port.postMessage({
        type: 'DISTRIBUTE',
        fields: fields.map((f) => ({
          key: f.key,
          label: f.label,
          critical: f.critical,
          value: f.value, // needed for corrections: "the temperature is 37.2, not 36.9"
        })),
        transcript,
      });
      return done;
    }

    /** Transcript -> /api/llm-correct (punctuation, clinical terminology). */
    async correct(text, timeoutMs = 60000) {
      if (!this.port) return { text, corrected: false };

      const done = new Promise((resolve) => {
        this._resolveCorrect = resolve;
        setTimeout(() => resolve({ text, corrected: false }), timeoutMs);
      });

      this.port.postMessage({ type: 'CORRECT', text });
      return done;
    }

    stop() {
      this.recorder?.stop();
      this.recorder = null;
      try {
        this.port?.disconnect();
      } catch {
        /* already disconnected */
      }
      this.port = null;
    }
  }

  globalThis.SCRIBE_DICT = Object.freeze({ Dictation });
})();
