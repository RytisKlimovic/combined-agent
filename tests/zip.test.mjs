/**
 * zip.js tests.
 *
 * The fixtures are produced here with node's `zlib`, so the test checks a REAL
 * ZIP byte stream rather than a format we invented ourselves.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeZip } from './make-zip.mjs';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { readZip, entryText } = await import(pathToFileURL(`${EXT}/lib/zip.js`).href);

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

console.log('--- Reading ---');
{
  const zip = await readZip(
    makeZip([
      { name: 'word/document.xml', data: '<w:p>Hello</w:p>' },
      { name: 'stored.txt', data: 'not compressed', store: true },
      { name: 'unicode.txt', data: 'Ąžuolas, čiužinys — 36.9 °C' },
    ])
  );

  check('every entry was found', zip.size === 3, String(zip.size));
  check('the deflated entry was inflated', entryText(zip, 'word/document.xml') === '<w:p>Hello</w:p>');
  check('the stored entry was read', entryText(zip, 'stored.txt') === 'not compressed');
  check('UTF-8 survives intact', entryText(zip, 'unicode.txt') === 'Ąžuolas, čiužinys — 36.9 °C');
  check('a missing entry yields empty text', entryText(zip, 'nope.xml') === '');
}

console.log('--- Larger content ---');
{
  const big = 'a line with non-ASCII letters: ąčęėįšųūž\n'.repeat(2000);
  const zip = await readZip(makeZip([{ name: 'a.txt', data: big }]));
  check('a long entry round-trips exactly', entryText(zip, 'a.txt') === big);
}

console.log('--- Directories ---');
{
  const zip = await readZip(
    makeZip([
      { name: 'word/', data: '', store: true },
      { name: 'word/document.xml', data: 'x' },
    ])
  );
  check('the directory entry is skipped', zip.size === 1 && zip.has('word/document.xml'), String(zip.size));
}

console.log('--- Errors ---');
{
  const notZip = Buffer.from('this really is not a zip file, just plain text');
  let msg = '';
  try {
    await readZip(notZip);
  } catch (err) {
    msg = err.message;
  }
  check('not a ZIP -> a clear error', /not a ZIP/.test(msg), msg);

  const broken = makeZip([{ name: 'a.txt', data: 'x' }]);
  broken.writeUInt32LE(0, 0); // corrupt the local header
  msg = '';
  try {
    await readZip(broken);
  } catch (err) {
    msg = err.message;
  }
  check('a corrupted structure -> an error', /Corrupted ZIP structure/.test(msg), msg);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
