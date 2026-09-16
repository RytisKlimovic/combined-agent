/**
 * Word-level comparison tests.
 *
 * Why this is a SAFETY mechanism rather than a nice extra: when the clinician
 * corrects an already-filled field by voice, the model returns the FULL new
 * text. Without a diff, a quietly altered number (36.9 -> 37.2, or worse,
 * 78 -> 87) would go unnoticed.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
await import(pathToFileURL(`${EXT}/content/text-diff.js`).href);
const { diffWords, hasChanges, tokenize, correctionDiff, countChangeGroups } = globalThis.SCRIBE_DIFF;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

/** Rebuilds the text from the diff parts — proves nothing was lost. */
const rebuildOld = (p) => p.filter((x) => x.type !== 'add').map((x) => x.text).join('');
const rebuildNew = (p) => p.filter((x) => x.type !== 'del').map((x) => x.text).join('');
const render = (p) =>
  p.map((x) => (x.type === 'same' ? x.text : x.type === 'del' ? `[-${x.text}-]` : `{+${x.text}+}`)).join('');

// =========================================================================
// 1. The main case: correcting a number
// =========================================================================
console.log('--- Correcting a number ---');
{
  const o = 'Temperature 36.9 °C. Pulse 78 bpm.';
  const n = 'Temperature 37.2 °C. Pulse 78 bpm.';
  const d = diffWords(o, n);

  check('the change is detected', hasChanges(d));
  check('the old value is marked deleted', d.some((p) => p.type === 'del' && p.text.includes('36.9')));
  check('the new value is marked added', d.some((p) => p.type === 'add' && p.text.includes('37.2')));
  check('the UNCHANGED part stays "same"',
    d.filter((p) => p.type === 'same').map((p) => p.text).join('').includes('Pulse 78'),
    `-> ${render(d)}`);
  check('the old text can be rebuilt from the diff', rebuildOld(d) === o);
  check('the new text can be rebuilt from the diff', rebuildNew(d) === n);
}

// =========================================================================
// 2. Appending / deleting
// =========================================================================
console.log('\n--- Appending and deleting ---');
{
  const d = diffWords('Abdominal pain.', 'Abdominal pain. Also nauseated.');
  check('appending: nothing was deleted', !d.some((p) => p.type === 'del'), `-> ${render(d)}`);
  check('appending: the new sentence is marked', d.some((p) => p.type === 'add' && /nauseated/.test(p.text)));
}
{
  const d = diffWords('Abdominal pain. Nauseated.', 'Abdominal pain.');
  check('deleting: nothing was added', !d.some((p) => p.type === 'add'));
  check('deleting: the removed sentence is marked', d.some((p) => p.type === 'del' && /Nauseated/.test(p.text)));
}

// =========================================================================
// 3. Unchanged text — no markings at all (or the warnings lose meaning)
// =========================================================================
console.log('\n--- Unchanged text ---');
{
  const s = 'Condition satisfactory, BP 130/80.';
  const d = diffWords(s, s);
  check('identical text -> no changes', hasChanges(d) === false);
  check('identical text -> one "same" part', d.length === 1 && d[0].type === 'same');
}

// =========================================================================
// 4. Edge cases
// =========================================================================
console.log('\n--- Edge cases ---');
{
  const d = diffWords('', 'New text.');
  check('empty to text -> everything added', d.length === 1 && d[0].type === 'add');
}
{
  const d = diffWords('Old text.', '');
  check('text to empty -> everything deleted', d.length === 1 && d[0].type === 'del');
}
{
  check('both empty -> nothing', diffWords('', '').length === 0);
  check('null/undefined do not throw', diffWords(null, undefined).length === 0);
}
{
  // Accented and special characters must not be corrupted
  const o = 'Lasègue on the left 40°, power 5/5.';
  const n = 'Lasègue on the left 45°, power 5/5.';
  const d = diffWords(o, n);
  check('accented / special characters survive', rebuildNew(d) === n, `-> ${rebuildNew(d)}`);
  check('the changed degree value is marked', d.some((p) => p.type === 'add' && p.text.includes('45°')));
}
{
  // Whitespace and newlines are preserved (formatting matters in documentation)
  const o = 'First line.\nSecond line.';
  const n = 'First line.\nSecond changed line.';
  const d = diffWords(o, n);
  check('newlines are preserved', rebuildNew(d) === n && rebuildOld(d) === o);
}
{
  // Very long text -> no word-by-word comparison, but nothing is lost
  const o = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  const n = `${o} appended`;
  const d = diffWords(o, n);
  check('long text does not break the comparison', d.length > 0);
  check('  ...and the new text is still rebuildable', rebuildNew(d) === n);
}

// =========================================================================
// 5. tokenize — whitespace is kept as its own tokens
// =========================================================================
console.log('\n--- Tokenising ---');
check('whitespace is kept as separate tokens',
  tokenize('a b').join('|') === 'a| |b', `-> ${tokenize('a b').join('|')}`);
check('an empty string -> nothing', tokenize('').length === 0);

// =========================================================================
// 6. correctionDiff — dictation highlights (case/punctuation noise discarded)
// =========================================================================
console.log('\n--- The correction diff ---');
{
  // Purely a capital letter — NOT shown.
  const p = correctionDiff('the patient reports pain', 'The patient reports pain');
  check('a capital letter is not highlighted', !hasChanges(p), render(p));
  check('the corrected text is what is shown', rebuildNew(p) === 'The patient reports pain', render(p));

  // Added punctuation — NOT shown.
  const q = correctionDiff('it is snowing outside he slipped', 'It is snowing. Outside he slipped.');
  check('punctuation + capitalisation are not highlighted', !hasChanges(q), render(q));

  // A changed word ending — highlighted at CHARACTER precision.
  const g = correctionDiff('the patient report pain', 'the patient reports pains');
  check('the ending is highlighted', hasChanges(g));
  check('the unchanged stem stays "same" (report)',
    g.some((x) => x.type === 'same' && x.text.includes('report')), render(g));
  check('only the ending is marked, not the whole word',
    render(g).includes('report') && !render(g).includes('[-report-]'), render(g));
  check('the corrected text is rebuildable', rebuildNew(g) === 'the patient reports pains', render(g));

  // A genuine word change — shown.
  const w = correctionDiff('it is summer now', 'it is winter now');
  check('a changed word is highlighted', hasChanges(w) && rebuildNew(w) === 'it is winter now', render(w));

  // A changed number is NOT hidden (internal punctuation stays significant).
  const num = correctionDiff('temperature 369', 'temperature 36.9');
  check('a changed number is shown', hasChanges(num), render(num));

  // Nothing changed — empty.
  check('identical text -> nothing', !hasChanges(correctionDiff('all fine', 'all fine')));
}

console.log('\n--- countChangeGroups ---');
{
  const g = correctionDiff('the patient report pain', 'the patient reports pains');
  check('two corrected spots (reports, pains)', countChangeGroups(g) === 2,
    `-> ${countChangeGroups(g)} | ${render(g)}`);
  check('no changes -> 0', countChangeGroups(correctionDiff('a b', 'a b')) === 0);
  // adjacent del+add (one substitution) -> one spot
  const one = correctionDiff('summer', 'winter');
  check('a substitution -> one spot', countChangeGroups(one) === 1, `-> ${countChangeGroups(one)}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
