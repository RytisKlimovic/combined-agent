/**
 * audio-capture.js — microphone capture, converted to the format the
 * transcription server expects (PCM int16 LE, 16 kHz, mono).
 *
 * Loaded as a classic content script -> globalThis.SCRIBE_AUDIO.
 *
 * ---------------------------------------------------------------------------
 * WHY ScriptProcessorNode AND NOT AudioWorklet
 * ---------------------------------------------------------------------------
 * AudioWorklet would need `audioWorklet.addModule(chrome.runtime.getURL(...))`,
 * i.e. loading a script from chrome-extension:// into the page's document.
 * That is checked against the PAGE's CSP script-src — if the host application
 * has a strict CSP the worklet silently fails to load, dictation stops
 * working, and the reason is invisible.
 *
 * ScriptProcessorNode is deprecated, but: it needs no external file, has no
 * CSP surface at all, and its performance is more than enough for 16 kHz mono
 * dictation. Chrome has announced no removal date — reliability wins here.
 */
(function () {
  'use strict';

  const TARGET_RATE = 16000;
  /** Samples per chunk. 4096 @16kHz = 256 ms — about 4 messages/second. */
  const BUFFER_SIZE = 4096;

  /** Float32 [-1..1] -> Int16 LE. */
  function floatToInt16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      // Asymmetric scaling — the int16 range is [-32768, 32767].
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /**
   * ArrayBuffer -> base64. Binary data does not survive a chrome.runtime port
   * (JSON serialisation), and base64 is roughly 2x more compact than an array
   * of numbers in JSON.
   */
  function toBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let bin = '';
    // In slices, so large arrays do not blow the argument stack.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /** RMS, for the microphone level indicator in the UI. */
  function rms(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    return Math.sqrt(sum / input.length);
  }

  class Recorder {
    /**
     * @param {(b64:string)=>void} onChunk — a PCM chunk (base64)
     * @param {(level:number)=>void} [onLevel] — microphone level, 0..1
     */
    constructor(onChunk, onLevel) {
      this.onChunk = onChunk;
      this.onLevel = onLevel;
      this.stream = null;
      this.ctx = null;
      this.source = null;
      this.processor = null;
    }

    async start() {
      // Microphone permission is requested on behalf of the PAGE (a content
      // script shares the document's origin). The user grants it once for the
      // host application's domain.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Chrome resamples the microphone to the requested rate itself — no
      // manual resampling needed.
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);

      this.processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        this.onLevel?.(Math.min(1, rms(input) * 8));
        this.onChunk(toBase64(floatToInt16(input)));
      };

      this.source.connect(this.processor);
      // A ScriptProcessor does not run until it is connected to a
      // destination. We do not want to play the audio back, so it goes
      // through a silent gain node — otherwise the user hears themselves.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.processor.connect(mute);
      mute.connect(this.ctx.destination);
      this._mute = mute;
    }

    stop() {
      try {
        this.processor?.disconnect();
        this._mute?.disconnect();
        this.source?.disconnect();
      } catch {
        /* already disconnected */
      }
      // The browser's microphone indicator only goes out once the tracks stop.
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close().catch(() => {});

      this.processor = this.source = this.stream = this.ctx = this._mute = null;
    }
  }

  /** A human-readable getUserMedia error. */
  function micErrorMessage(err) {
    switch (err?.name) {
      case 'NotAllowedError':
        return (
          'The microphone is blocked. Allow the microphone for this page (click the ' +
          'microphone icon in the address bar) and try again.'
        );
      case 'NotFoundError':
        return 'No microphone found. Check that one is connected.';
      case 'NotReadableError':
        return 'The microphone is in use by another application.';
      default:
        return `Could not access the microphone: ${err?.message || err}`;
    }
  }

  globalThis.SCRIBE_AUDIO = Object.freeze({
    Recorder,
    micErrorMessage,
    TARGET_RATE,
  });
})();
