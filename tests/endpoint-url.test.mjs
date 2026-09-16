/**
 * Endpoint URL tests.
 *
 * Why this deserves its own suite: the endpoint is typed in by a user, and
 * "OpenAI-compatible" providers do not agree on where the API root sits. Get
 * the join wrong and the failure is a 404 from deep inside a stream, which
 * says nothing about the cause. Every provider shape below is one somebody
 * will paste in.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { chatCompletionsUrl, modelsUrl } = await import(pathToFileURL(`${EXT}/llm.js`).href);
const { validate, validateAsr, isLocalEndpoint, DEFAULTS, CONFIGURABLE } = await import(
  pathToFileURL(`${EXT}/lib/settings.js`).href
);

let pass = 0,
  fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};
const eq = (name, got, want) =>
  check(name, got === want, `\n    got:    ${got}\n    wanted: ${want}`);

console.log('--- A server root gets the full path appended ---');
eq('localhost', chatCompletionsUrl('http://localhost:8000'),
  'http://localhost:8000/v1/chat/completions');
eq('a trailing slash is not doubled', chatCompletionsUrl('http://localhost:8000/'),
  'http://localhost:8000/v1/chat/completions');
eq('several trailing slashes', chatCompletionsUrl('http://localhost:8000///'),
  'http://localhost:8000/v1/chat/completions');
eq('surrounding whitespace is trimmed', chatCompletionsUrl('  http://localhost:8000  '),
  'http://localhost:8000/v1/chat/completions');
eq('a path prefix is preserved', chatCompletionsUrl('https://api.groq.com/openai'),
  'https://api.groq.com/openai/v1/chat/completions');
eq('a reverse-proxy sub-path', chatCompletionsUrl('https://gw.example.org/llm'),
  'https://gw.example.org/llm/v1/chat/completions');

console.log('--- A root that already names an API version gets only the operation ---');
eq('.../v1', chatCompletionsUrl('https://api.mistral.ai/v1'),
  'https://api.mistral.ai/v1/chat/completions');
eq('.../api/v1', chatCompletionsUrl('https://openrouter.ai/api/v1'),
  'https://openrouter.ai/api/v1/chat/completions');
eq('.../v1beta', chatCompletionsUrl('https://example.org/v1beta'),
  'https://example.org/v1beta/chat/completions');
eq('.../v2', chatCompletionsUrl('https://example.org/v2'),
  'https://example.org/v2/chat/completions');
// The counter-case: "/v1" must be a whole segment, not any word containing it.
eq('a path merely ending in "v1"-like text is a root',
  chatCompletionsUrl('https://example.org/serv1ce'),
  'https://example.org/serv1ce/v1/chat/completions');

console.log('--- A complete URL is used verbatim ---');
eq('an explicit chat-completions URL', chatCompletionsUrl('http://localhost:8000/v1/chat/completions'),
  'http://localhost:8000/v1/chat/completions');
eq("Gemini's OpenAI layer, which has no /v1 segment",
  chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
eq('a complete URL with a trailing slash',
  chatCompletionsUrl('http://localhost:8000/v1/chat/completions/'),
  'http://localhost:8000/v1/chat/completions');

console.log('--- Nothing in, nothing out ---');
eq('empty string', chatCompletionsUrl(''), '');
eq('null', chatCompletionsUrl(null), '');
eq('undefined', chatCompletionsUrl(undefined), '');
eq('models URL of nothing', modelsUrl(''), '');

console.log('--- modelsUrl is derived from the same rule ---');
eq('server root', modelsUrl('http://localhost:8000'), 'http://localhost:8000/v1/models');
eq('versioned root', modelsUrl('https://api.mistral.ai/v1'), 'https://api.mistral.ai/v1/models');
eq('a complete URL swaps its tail',
  modelsUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
  'https://generativelanguage.googleapis.com/v1beta/openai/models');
check('models and completions always share a parent', (() => {
  for (const e of [
    'http://localhost:8000',
    'https://api.groq.com/openai',
    'https://api.mistral.ai/v1',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  ]) {
    const a = chatCompletionsUrl(e).replace(/\/chat\/completions$/, '');
    const b = modelsUrl(e).replace(/\/models$/, '');
    if (a !== b) return false;
  }
  return true;
})());

console.log('--- isLocalEndpoint (drives the data-leaves-the-machine warning) ---');
for (const url of ['http://localhost:8000', 'http://127.0.0.1:1234/v1', 'http://localhost']) {
  check(`local: ${url}`, isLocalEndpoint(url) === true);
}
for (const url of [
  'https://api.groq.com/openai',
  'https://localhost.evil.example/v1', // a hostname is not a substring match
  'http://192.168.1.10:8000', // another machine, even on the LAN
  'not-a-url',
  '',
  null,
]) {
  check(`not local: ${url || '(empty)'}`, isLocalEndpoint(url) === false);
}

console.log('--- validate() accepts what the UI can produce ---');
const withEndpoint = (vllmEndpoint) => validate({ ...DEFAULTS, vllmEndpoint });
check('the defaults are valid', validate(DEFAULTS).length === 0, validate(DEFAULTS).join(' '));
check('a hosted https endpoint is valid', withEndpoint('https://api.groq.com/openai').length === 0);
check('a full chat-completions URL is valid',
  withEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions').length === 0);
check('an empty endpoint is an error', withEndpoint('').length === 1);
check('a non-URL is an error', withEndpoint('localhost:8000').length === 1,
  withEndpoint('localhost:8000').join(' '));
check('ws:// is an error (it must be http)', withEndpoint('ws://localhost:8000').length === 1);
check('a missing model name is an error',
  validate({ ...DEFAULTS, model: '' }).some((e) => /model name/i.test(e)));

console.log('--- the configurable surface is exactly what the UI offers ---');
check('four configurable keys', CONFIGURABLE.length === 4, CONFIGURABLE.join(','));
check('every configurable key has a default',
  CONFIGURABLE.every((k) => k in DEFAULTS), CONFIGURABLE.join(','));
check('the system prompt is NOT configurable from storage',
  !CONFIGURABLE.includes('systemPromptOverride'));
check('streaming is NOT configurable from storage', !CONFIGURABLE.includes('stream'));

console.log('--- the ASR endpoint is validated separately ---');
check('a bad model endpoint does not invalidate ASR',
  validateAsr({ asrEnabled: true, asrEndpoint: DEFAULTS.asrEndpoint }).length === 0);
check('a bad ASR endpoint does not invalidate the model server',
  withEndpoint(DEFAULTS.vllmEndpoint).length === 0);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
