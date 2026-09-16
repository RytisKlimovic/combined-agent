/**
 * Audio conversion and ASR client tests.
 *
 * Why this matters: if the Float32 -> Int16 or the base64 conversion has a bug,
 * the server receives noise instead of speech and returns nonsense — with NO
 * error message at all. Such a bug would silently ruin everything, so the
 * conversion is checked bit for bit.
 */
import { JSDOM } from 'jsdom';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// audio-capture.js is a classic IIFE that uses btoa/AudioContext -> host it in jsdom.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;

// btoa is deliberately NOT replaced with jsdom's: Node's own btoa follows the
// same specification as Chrome's (a latin1 string -> base64), so it is the more
// faithful model. Assigning jsdom's btoa onto globalThis breaks it — it throws
// InvalidCharacterError for perfectly valid bytes.

// Node 24 ships its own getter-only `navigator` -> go through defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
await import(pathToFileURL(`${EXT}/content/audio-capture.js`).href);
const { Recorder, micErrorMessage, TARGET_RATE } = globalThis.SCRIBE_AUDIO;

// =========================================================================
// 1. The format matches the server contract
// =========================================================================
console.log('--- Format ---');
check('sample rate = 16 kHz (server: SAMPLE_RATE = 16000)', TARGET_RATE === 16000, `-> ${TARGET_RATE}`);

// =========================================================================
// 2. Float32 -> Int16 -> base64 -> back (exactly as the service worker does)
// =========================================================================
console.log('\n--- The conversion chain ---');

// The private functions in audio-capture.js are reached through the Recorder's
// onaudioprocess, driven by a fake AudioContext.
function captureVia(input) {
  let captured = null;
  const rec = new Recorder((b64) => { captured = b64; }, () => {});

  // A minimal AudioContext double — only the onaudioprocess chain matters here.
  const fakeProcessor = { connect() {}, disconnect() {} };
  const fakeCtx = {
    state: 'running',
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => fakeProcessor,
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    destination: {},
    close: () => Promise.resolve(),
  };
  globalThis.AudioContext = function () { return fakeCtx; };
  globalThis.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [] }),
  };

  return rec.start().then(() => {
    fakeProcessor.onaudioprocess({
      inputBuffer: { getChannelData: () => input },
    });
    rec.stop();
    return captured;
  });
}

/** base64 -> Int16Array (exactly as in the worker's AUDIO branch). */
function decode(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Int16Array(bin.buffer, bin.byteOffset, bin.length / 2);
}

{
  // The critical values: silence, full amplitude both ways, and half scale.
  const input = new Float32Array([0, 1, -1, 0.5, -0.5]);
  const out = decode(await captureVia(input));

  check('silence -> 0', out[0] === 0, `-> ${out[0]}`);
  check('+1.0 -> 32767 (max int16)', out[1] === 32767, `-> ${out[1]}`);
  check('-1.0 -> -32768 (min int16)', out[2] === -32768, `-> ${out[2]}`);
  check('+0.5 -> 16383', out[3] === 16383, `-> ${out[3]}`);
  check('-0.5 -> -16384', out[4] === -16384, `-> ${out[4]}`);
  check('the sample count is unchanged', out.length === input.length, `-> ${out.length}`);
}

// Clipping — values outside [-1,1] must not wrap around
{
  const out = decode(await captureVia(new Float32Array([2.5, -2.5, 1.0001])));
  check('+2.5 clips to 32767 (does not wrap)', out[0] === 32767, `-> ${out[0]}`);
  check('-2.5 clips to -32768', out[1] === -32768, `-> ${out[1]}`);
  check('1.0001 clips rather than wrapping negative', out[2] === 32767, `-> ${out[2]}`);
}

// A sine wave — check the shape survives (rather than becoming noise)
{
  const N = 256;
  const input = new Float32Array(N);
  for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / TARGET_RATE) * 0.8;

  const out = decode(await captureVia(input));
  check('the sine length is preserved', out.length === N, `-> ${out.length}`);

  let maxErr = 0;
  for (let i = 0; i < N; i++) {
    const expected = input[i] < 0 ? input[i] * 0x8000 : input[i] * 0x7fff;
    maxErr = Math.max(maxErr, Math.abs(out[i] - Math.trunc(expected)));
  }
  check('the sine round-trips undistorted (error <= 1 LSB)', maxErr <= 1, `-> ${maxErr}`);
}

// A large buffer — the String.fromCharCode.apply stack limit
{
  const big = new Float32Array(65536).fill(0.25);
  const out = decode(await captureVia(big));
  check('a large buffer (64k samples) does not break base64', out.length === 65536, `-> ${out.length}`);
  check('  ...and the values are correct', out[0] === 8191 && out[65535] === 8191, `-> ${out[0]}`);
}

// =========================================================================
// 3. Microphone error messages — readable by a human
// =========================================================================
console.log('\n--- Microphone errors ---');
check('NotAllowedError explains what to do',
  /Allow the microphone/.test(micErrorMessage({ name: 'NotAllowedError' })));
check('NotFoundError mentions a missing microphone',
  /No microphone found/.test(micErrorMessage({ name: 'NotFoundError' })));
check('NotReadableError mentions a busy microphone',
  /in use by another application/.test(micErrorMessage({ name: 'NotReadableError' })));
check('an unknown error still returns a message',
  micErrorMessage({ name: 'Weird', message: 'x' }).length > 10);

// =========================================================================
// 4. The WebSocket URL derived from an http(s) endpoint
// =========================================================================
console.log('\n--- WS URL ---');
const { toWsUrl, validateAsr } = await import(pathToFileURL(`${EXT}/lib/settings.js`).href);

check('https -> wss', toWsUrl('https://asr.example.org') === 'wss://asr.example.org/ws',
  `-> ${toWsUrl('https://asr.example.org')}`);
check('http -> ws', toWsUrl('http://localhost:8001') === 'ws://localhost:8001/ws',
  `-> ${toWsUrl('http://localhost:8001')}`);
check('a trailing slash is not doubled',
  toWsUrl('https://asr.example.org/') === 'wss://asr.example.org/ws',
  `-> ${toWsUrl('https://asr.example.org/')}`);

// =========================================================================
// 5. ASR validation is separate from the model server's
// =========================================================================
console.log('\n--- Configuration validation ---');
check('ASR off -> no errors', validateAsr({ asrEnabled: false }).length === 0);
check('on with no address -> an error', validateAsr({ asrEnabled: true, asrEndpoint: '' }).length === 1);
check('on with a bad URL -> an error',
  validateAsr({ asrEnabled: true, asrEndpoint: 'not-a-url' }).length === 1);
check('on with ws:// -> an error (it must be http)',
  validateAsr({ asrEnabled: true, asrEndpoint: 'ws://x:8001' }).length === 1);
check('on with https -> valid',
  validateAsr({ asrEnabled: true, asrEndpoint: 'https://asr.example.org' }).length === 0);

// =========================================================================
// 6. correctTranscript: a failure must NOT lose the dictation
// =========================================================================
console.log('\n--- Correction (fallback) ---');
const { correctTranscript } = await import(pathToFileURL(`${EXT}/lib/asr-client.js`).href);
const realFetch = globalThis.fetch;

globalThis.fetch = async () => { throw new Error('the server is down'); };
{
  const r = await correctTranscript({ endpoint: 'http://x:8001', text: 'abdominal pain' });
  check('a server failure -> the ORIGINAL text is returned', r.text === 'abdominal pain', `-> ${r.text}`);
  check('  ...and it is flagged as uncorrected', r.corrected === false);
}

globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
{
  const r = await correctTranscript({ endpoint: 'http://x:8001', text: 'abdominal pain' });
  check('HTTP 500 -> the original is returned', r.text === 'abdominal pain');
}

globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: '' }) });
{
  const r = await correctTranscript({ endpoint: 'http://x:8001', text: 'abdominal pain' });
  check('an empty server response -> the original is returned', r.text === 'abdominal pain');
}

globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: 'Abdominal pain.' }) });
{
  const r = await correctTranscript({ endpoint: 'http://x:8001', text: 'abdominal pain' });
  check('a successful response -> the corrected text', r.text === 'Abdominal pain.' && r.corrected === true);
}
{
  const r = await correctTranscript({ endpoint: 'http://x:8001', text: '   ' });
  check('empty input -> the server is not called at all', r.text === '' && r.corrected === false);
}

globalThis.fetch = realFetch;

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
