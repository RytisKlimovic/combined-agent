/**
 * presets.js tests — the context-aware suggestion buttons.
 *
 * Why this was needed: in "whole page" mode deriveSignals used to return early
 * and clinicalForm was never set, so the clinical suggestions NEVER appeared on
 * a form — even though the page had been recognised correctly.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { deriveSignals, pickPresets, PRESET_IDS } = await import(pathToFileURL(`${EXT}/presets.js`).href);

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

const FORM = 'http://localhost:8080/app/visit-note';
const labels = (signals, into) => pickPresets(signals, into).map((p) => p.label);

console.log('--- Signals ---');
{
  const viewport = deriveSignals({ url: FORM, text: 'Complaints' });
  const whole = deriveSignals({ url: FORM }, { wholeDoc: true });
  const other = deriveSignals({ url: 'https://www.google.com/', text: 'x' });

  check('viewport mode recognises the form', viewport.clinicalForm === true);
  check('whole page mode recognises the form', whole.clinicalForm === true);
  check('whole page keeps its own flag', whole.wholeDoc === true);
  check('another page is not a form', other.clinicalForm === false);
}

console.log('--- Suggestions on a form ---');
{
  const whole = labels(deriveSignals({ url: FORM }, { wholeDoc: true }));
  check('whole page: "Summarize visit" is there', whole.includes('Summarize visit'), whole.join(', '));
  check('whole page: "What\'s missing?" is there', whole.includes("What's missing?"));
  check('whole page: the clinical ones come first', whole[0] === 'Summarize visit', whole.join(', '));
  check('whole page: the document suggestions survive', whole.includes('TL;DR'), whole.join(', '));

  const viewport = labels(deriveSignals({ url: FORM, text: 'Complaints' }));
  check('viewport: "What else to ask?" is there', viewport.includes('What else to ask?'), viewport.join(', '));
  check('viewport: "Extract text" survives', viewport.includes('Extract text'));
}

console.log('--- A selection takes precedence ---');
{
  const sel = labels(deriveSignals({ url: FORM, selection: 'headache', text: 'x' }));
  check('no clinical ones when something is selected', !sel.includes('Summarize visit'), sel.join(', '));
  check('the selection suggestions are there', sel.includes('Rewrite'), sel.join(', '));
}

console.log('--- Other pages are unchanged ---');
{
  const plain = labels(deriveSignals({ url: 'https://www.google.com/', text: 'x' }));
  check('no clinical suggestions', !plain.includes('Summarize visit'), plain.join(', '));
  check('the usual ones are there', plain.includes('What is this?'), plain.join(', '));

  const img = labels(deriveSignals(null, { image: true }));
  check('the image suggestions are unchanged', img.includes('OCR text'), img.join(', '));
}

console.log('--- The translate target follows the answer language ---');
{
  const lt = labels(deriveSignals({ url: FORM }, { wholeDoc: true }), 'Lithuanian');
  check('the label names the target language', lt.includes('Translate → Lithuanian'), lt.join(', '));
}

console.log('--- Every preset has a registered id ---');
{
  const ids = new Set(PRESET_IDS);
  const seen = new Set();
  const collect = (signals, into) => {
    for (const p of pickPresets(signals, into)) seen.add(p.id);
  };
  collect(deriveSignals(null, { image: true }));
  collect(deriveSignals({ url: FORM }, { wholeDoc: true }));
  collect(deriveSignals({ url: FORM, text: 'x', tables: 1, codeBlocks: 1 }));
  collect(deriveSignals({ url: FORM, selection: 'error: is not defined', text: 'x' }));
  collect(deriveSignals({ url: 'https://x.test/', text: 'traceback', tables: 1 }));

  const unknown = [...seen].filter((id) => !ids.has(id));
  check('no preset uses an unregistered id', unknown.length === 0, unknown.join(', '));
  check('the ids actually got exercised', seen.size > 15, String(seen.size));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
