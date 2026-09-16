/**
 * ocr.js tests — reading scanned documents.
 *
 * No model is needed here: `ocrPages` takes a `run` function, so the whole flow
 * (ordering, progress, cancellation, a failure on one page) is tested against a
 * fake responder. The key invariant: ON CANCELLATION, the pages already
 * transcribed are NOT LOST.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { isScanned, joinPages, buildOcrRequest, ocrPages, OCR_PROMPT, UNREADABLE } = await import(
  pathToFileURL(`${EXT}/lib/ocr.js`).href
);
const { ENDPOINTS } = await import(pathToFileURL(`${EXT}/lib/settings.js`).href);

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

console.log('--- isScanned ---');
check('an empty text layer over 5 pages -> scanned', isScanned({ chars: 0, pages: 5 }) === true);
check('a few dozen characters -> still scanned', isScanned({ chars: 180, pages: 5 }) === true);
check('a digital document -> not scanned', isScanned({ chars: 40000, pages: 5 }) === false);
check('the boundary: 100 chars/page -> not scanned', isScanned({ chars: 500, pages: 5 }) === false);
check('no pages -> not scanned', isScanned({ chars: 0, pages: 0 }) === false);
check('no arguments does not throw', isScanned() === false);

console.log('--- joinPages ---');
{
  const out = joinPages([
    { page: 1, text: 'First page' },
    { page: 2, text: '   ' },
    { page: 3, text: 'Third page' },
  ]);
  check('page markers are present', out.includes('--- page 1 ---') && out.includes('--- page 3 ---'), out);
  check('an empty page drops out', !out.includes('--- page 2 ---'), out);
  check('the order is preserved', out.indexOf('First') < out.indexOf('Third'), out);
}

console.log('--- The OCR prompt ---');
check('forbids translating', /do not translate/i.test(OCR_PROMPT));
check('forbids guessing digits', /never guess a digit/i.test(OCR_PROMPT));
check('forbids summarising', /do not summarize/i.test(OCR_PROMPT));
check('requires unreadable spots to be marked', OCR_PROMPT.includes(UNREADABLE));

console.log('--- The request shape ---');
{
  const req = buildOcrRequest('data:image/jpeg;base64,AAAA');
  check('it targets the configured model server',
    req.url === `${ENDPOINTS.llm}/v1/chat/completions`, req.url);
  check('no streaming', req.body.stream === false);
  check('there is no system message', !req.body.messages.some((m) => m.role === 'system'));
  const parts = req.body.messages[0].content;
  check('the image is attached', Array.isArray(parts) && parts.some((p) => p.type === 'image_url'),
    JSON.stringify(parts).slice(0, 120));
}

console.log('--- ocrPages: the happy path ---');
{
  const seen = [];
  const progress = [];
  const res = await ocrPages({
    count: 4,
    getImage: async (i) => `img-${i}`,
    run: async (req) => {
      const url = req.body.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
      seen.push(url);
      return `text ${url}`;
    },
    onProgress: (done, total) => progress.push(`${done}/${total}`),
    concurrency: 2,
  });

  check('every page was transcribed', res.pages === 4, String(res.pages));
  check('not cancelled', res.aborted === false);
  check('every image was used', seen.length === 4 && new Set(seen).size === 4, seen.join(','));
  check('the text is assembled in the right order', res.text.indexOf('img-0') < res.text.indexOf('img-3'), res.text);
  check('progress was reported for each page', progress.length === 4, progress.join(' '));
  check('the last progress report is 4/4', progress[3] === '4/4', progress.join(' '));
}

console.log('--- ocrPages: cancellation ---');
{
  const controller = new AbortController();
  const res = await ocrPages({
    count: 10,
    getImage: async (i) => `img-${i}`,
    run: async (req) => {
      const url = req.body.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
      if (url === 'img-4') {
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return `text ${url}`;
    },
    signal: controller.signal,
    concurrency: 1,
  });

  check('it is reported as cancelled', res.aborted === true);
  check('the pages already transcribed survive', res.pages === 4, String(res.pages));
  check('the content is not lost', res.text.includes('img-0') && res.text.includes('img-3'), res.text);
  check('the cancelled page is absent', !res.text.includes('img-4'), res.text);
}

console.log('--- ocrPages: a failure on one page ---');
{
  const res = await ocrPages({
    count: 3,
    getImage: async (i) => `img-${i}`,
    run: async (req) => {
      const url = req.body.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
      if (url === 'img-1') throw new Error('HTTP 500');
      return `text ${url}`;
    },
    concurrency: 1,
  });

  check('the document is not aborted', res.aborted === false && res.pages === 3, String(res.pages));
  check('the bad page is marked', res.text.includes('[page could not be read]'), res.text);
  check('the other pages were transcribed', res.text.includes('img-0') && res.text.includes('img-2'), res.text);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
