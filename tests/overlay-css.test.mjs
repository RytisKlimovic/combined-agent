/**
 * Overlay CSS tests — these check the COMPUTED `display`, not just the JS logic.
 *
 * Why this was needed: the recording strip stayed visible even after dictation
 * finished. The JS side was correct (`els.rec.hidden = true`), but the CSS
 * `.rec { display: flex }` beat the browser's `[hidden] { display: none }`, so
 * the attribute had no visual effect at all. An earlier "check" only tested the
 * JS and missed it entirely.
 *
 * This test pulls the REAL overlay CSS out of content-script.js and verifies
 * that any `hidden` element genuinely computes to `display: none`.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// The REAL CSS is extracted from content-script.js (not a copy — so the test
// follows the source).
const src = readFileSync(`${EXT}/content/content-script.js`, 'utf8');
const m = src.match(/const CSS = `([\s\S]*?)`;/);
check('the overlay CSS could be extracted', !!m);
const CSS = m ? m[1] : '';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { document, getComputedStyle } = dom.window;
const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

function displayOf(className, { hidden }) {
  const el = document.createElement('div');
  el.className = className;
  if (hidden) el.setAttribute('hidden', '');
  document.body.appendChild(el);
  const d = getComputedStyle(el).display;
  el.remove();
  return d;
}

// =========================================================================
// Every element that gets hidden via `hidden` MUST disappear.
// .rec carries 'display: flex' -> that is the one that was broken.
// =========================================================================
console.log('\n--- the hidden attribute beats an author display ---');
for (const cls of ['rec', 'seed', 'warn', 'meter', 'single', 'multi', 'unassigned', 'dist-head', 'diff']) {
  check(`.${cls}[hidden] -> display: none`, displayOf(cls, { hidden: true }) === 'none',
    `-> ${displayOf(cls, { hidden: true })}`);
}

// =========================================================================
// Without `hidden` the elements render normally (the recording strip = flex).
// =========================================================================
console.log('\n--- without hidden the elements are visible ---');
check('.rec (no hidden) -> display: flex', displayOf('rec', { hidden: false }) === 'flex',
  `-> ${displayOf('rec', { hidden: false })}`);
check('.backdrop -> display: flex', displayOf('backdrop', { hidden: false }) === 'flex');

// =========================================================================
// A regression guard: if someone adds another element that carries a
// 'display:' and is hidden via the attribute, the safety rule must cover it
// automatically.
// =========================================================================
console.log('\n--- the safety rule exists ---');
check('the CSS contains [hidden]{display:none!important}',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/.test(CSS));
check('the rule is at the END of the CSS (after .rec)',
  CSS.lastIndexOf('[hidden]') > CSS.lastIndexOf('.rec {'),
  'if it is not last, jsdom order-cascade can mislead');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
