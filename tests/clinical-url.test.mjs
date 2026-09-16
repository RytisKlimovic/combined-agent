/**
 * isClinicalUrl tests.
 *
 * Why this matters: whether patient data reaches the on-disk history
 * (IndexedDB) depends on this one function. A wrong `false` is a PHI leak to
 * disk, so every supported page is checked individually.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { isClinicalUrl } = await import(pathToFileURL(`${EXT}/lib/settings.js`).href);

let pass = 0,
  fail = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
};

console.log('--- Clinical pages ---');
for (const url of [
  'http://localhost:3000/form',
  'http://127.0.0.1:8080/x',
  'file:///C:/dev/scribe-agent/demo/visit-note.html',
  'file:///home/u/discharge-summary.html?debug=1',
]) {
  check(url, isClinicalUrl(url) === true);
}

console.log('--- Not clinical ---');
for (const url of [
  'https://www.google.com/',
  'https://example.org/news',
  'https://localhost.evil.com/', // the hostname is matched exactly, not by substring
  'https://notlocalhost/x',
  'file:///home/u/holiday-photos.html',
  'chrome://extensions',
  '',
  'not-a-url',
]) {
  check(url || '(empty)', isClinicalUrl(url) === false);
}

console.log('--- Edge cases ---');
check('null does not throw', isClinicalUrl(null) === false);
check('undefined does not throw', isClinicalUrl(undefined) === false);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
