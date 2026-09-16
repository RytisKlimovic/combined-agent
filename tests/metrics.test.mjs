/**
 * Metrics tests.
 *
 * WHY THIS IS THE MOST IMPORTANT FILE in the whole metrics component:
 *
 * Telemetry is the only part of the extension that ACCUMULATES data and (in
 * stage 2) SENDS it. Everywhere else patient text merely passes through. So the
 * entire rest of the privacy design (isClinicalUrl, the clearing in close(),
 * the truncation in readError) is worth nothing if the metrics leaked the same
 * text by another route.
 *
 * These tests therefore check not "does it work" but "is leaking IMPOSSIBLE":
 *   1. the schema describes only numbers, booleans and fixed enums;
 *   2. anything not in the schema is dropped — however insistently the caller
 *      supplies it;
 *   3. editedPct does not lie when the text could not be measured.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

const { sanitize, SCHEMA, errorKind, errorStatus } = await import(
  pathToFileURL(`${EXT}/lib/metrics.js`).href
);
await import(pathToFileURL(`${EXT}/content/text-diff.js`).href);
const { editStats, STATS_TOKEN_LIMIT } = globalThis.SCRIBE_DIFF;

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

// =========================================================================
// 1. PHI: a realistic "worst case"
// =========================================================================
//
// This models a mistake that is genuinely easy to make: someone instrumenting
// a new call site passes the WHOLE context instead of just the numbers.
console.log('--- PHI cannot get through ---');
{
  const PHI = 'Patient reports right-sided abdominal pain, temperature 37.2';

  const { data } = sanitize('draft.inserted', {
    fieldKey: 'history_of_illness',
    chars: 412,
    editedPct: 18,
    // --- everything below is what must NOT be here ---
    text: PHI,
    draft: PHI,
    prompt: PHI,
    context: { complaints: PHI, anamnesisText: PHI },
    messages: [{ role: 'user', content: PHI }],
    patientAge: '67',
    patientSex: 'male',
    diagnoses: ['K35.8 Acute appendicitis'],
    url: 'http://localhost:8080/app/visit-note?patient=12345',
    error: new Error(PHI).message,
  });

  const dumped = JSON.stringify(data);

  check('the permitted fields survived', data.fieldKey === 'history_of_illness' && data.chars === 412 && data.editedPct === 18);
  check('no PHI text appears anywhere in the output', !dumped.includes('abdominal') && !dumped.includes('37.2'), dumped);
  check('not one of the "extra" keys got through',
    !/text|draft|prompt|context|messages|patient|diagnos|url|error/i.test(dumped), dumped);
  check('the output holds ONLY schema-described keys',
    Object.keys(data).every((k) => k in SCHEMA['draft.inserted']), Object.keys(data).join(','));
}

// =========================================================================
// 2. Type enforcement
// =========================================================================
console.log('--- Types ---');
{
  const num = (d) => sanitize('draft.generated', d).data;

  check('a numeric string is NOT coerced', num({ chars: '412' }).chars === undefined);
  check('NaN is rejected', num({ chars: NaN }).chars === undefined);
  check('Infinity is rejected', num({ chars: Infinity }).chars === undefined);
  check('an object in a numeric field is rejected', num({ chars: { toString: () => '9' } }).chars === undefined);
  check('an array is rejected', num({ chars: [1, 2] }).chars === undefined);
  check('a real number passes', num({ chars: 0 }).chars === 0);

  const b = (v) => sanitize('draft.generated', { hasSource: v }).data.hasSource;
  check('a boolean passes', b(true) === true && b(false) === false);
  check('a "truthy" string does NOT become a boolean', b('yes') === undefined);
  check('1 does NOT become true', b(1) === undefined);
}

// =========================================================================
// 3. Enums — only from the fixed list
// =========================================================================
console.log('--- Enums ---');
{
  const reason = (v) => sanitize('draft.discarded', { reason: v }).data.reason;
  check('a known value passes', reason('abort') === 'abort');
  check('an unknown one drops out', reason('the clinician went to lunch') === undefined);

  const field = (v) => sanitize('draft.generated', { fieldKey: v }).data.fieldKey;
  check('a FIELD_MAP key passes', field('objective_status') === 'objective_status');
  check('a free-text fieldKey drops out', field('Note.HistoryOfIllness') === undefined);

  const preset = (v) => sanitize('chat.asked', { preset: v }).data.preset;
  check('a preset id passes', preset('whats-missing') === 'whats-missing');
  check('"custom" passes', preset('custom') === 'custom');
  check('a preset LABEL (rather than its id) drops out', preset("What's missing?") === undefined);
}

// =========================================================================
// 4. Unknown events
// =========================================================================
console.log('--- The event list ---');
{
  check('an unknown event is rejected wholesale', sanitize('draft.leaked', { chars: 1 }) === null);
  check('a known event with no data returns empty', JSON.stringify(sanitize('session.active', {}).data) === '{}');
  check('undefined data does not throw', sanitize('draft.generated', undefined) !== null);
}

// =========================================================================
// 5. null means "not measured", not zero
// =========================================================================
console.log('--- null semantics ---');
{
  const d = sanitize('draft.inserted', { editedPct: null, chars: null, reason: null }).data;
  check('null passes for a numeric field', d.editedPct === null && 'editedPct' in d);
  check('null drops out for an enum', d.reason === undefined);
}

// =========================================================================
// 6. editStats — the single most important metric
// =========================================================================
console.log('--- editStats ---');
{
  const same = editStats('Abdomen soft, non-tender.', 'Abdomen soft, non-tender.');
  check('unchanged text -> 0%', same.editedPct === 0, JSON.stringify(same));

  // A substitution is the clinician's most common action (refining a number).
  // One word of three = 33%, NOT 67%: a change is two diff events (del + add),
  // which is why the count goes via UNCHANGED words.
  const one = editStats('temperature 36.9 degrees', 'temperature 37.2 degrees');
  check('one changed word of three -> 33%', one.editedPct === 33, JSON.stringify(one));
  check('the substitution is NOT inflated to 67%', one.editedPct !== 67, JSON.stringify(one));
  check('editedWords = 1, not 2', one.editedWords === 1, JSON.stringify(one));

  const all = editStats('aaa bbb ccc', 'xxx yyy zzz');
  check('fully rewritten -> 100%', all.editedPct === 100, JSON.stringify(all));

  const empty = editStats('', '');
  check('empty -> 0, not NaN', empty.editedPct === 0 && empty.totalWords === 0);

  // Lengthening: 3 new words out of 4 -> 75%. No clamping is needed, because
  // the denominator is the longer text.
  const added = editStats('aaa', 'aaa bbb ccc ddd');
  check('lengthening -> 75%', added.editedPct === 75, JSON.stringify(added));
  check('lengthening lands inside 0-100 with no clamping', added.editedPct <= 100, JSON.stringify(added));

  // Deletion: 1 word left of 4 -> 75% changed.
  const removed = editStats('aaa bbb ccc ddd', 'aaa');
  check('deletion -> 75%', removed.editedPct === 75, JSON.stringify(removed));
}

// =========================================================================
// 7. Over-long text -> null, and NOT 100
// =========================================================================
//
// This was the trap: past its limit diffWords returns the degenerate
// "everything deleted + everything added". Counted naively, EVERY longer
// history would always give editedPct = 100 — i.e. the headline metric would
// claim clinicians rewrite everything, when in fact they changed nothing.
console.log('--- Over-long text ---');
{
  const long = 'word '.repeat(STATS_TOKEN_LIMIT); // ~2x over the limit after tokenisation
  const stats = editStats(long, long);

  check('over-long -> editedPct === null', stats.editedPct === null, JSON.stringify({ pct: stats.editedPct }));
  check('over-long -> NOT 100', stats.editedPct !== 100);
  check('over-long -> NOT 0 (that would be a lie about being identical)', stats.editedPct !== 0);
  check('totalWords is still known', stats.totalWords > 0);

  const clean = sanitize('draft.inserted', stats).data;
  check('the null survives all the way to the schema', clean.editedPct === null);
}

// =========================================================================
// 8. Error classification — a category, never the text
// =========================================================================
console.log('--- errorKind ---');
{
  const PHI = 'Patient 67, abdominal pain';
  const kind = errorKind(new Error(`Model server error: 403 Forbidden — ${PHI}`));
  check('403 -> auth', kind === 'auth');
  check('the category is a short key, not the message', !String(kind).includes('Patient'));

  check('network', errorKind(new Error('Failed to fetch')) === 'network');
  check('404', errorKind(new Error('Model server error: 404 Not Found')) === 'notfound');
  check('abort -> timeout', errorKind(Object.assign(new Error('x'), { name: 'AbortError' })) === 'timeout');
  check('parse', errorKind(new Error('The model returned no JSON object.')) === 'parse');
  check('config', errorKind(new Error('Invalid configuration: No model name configured.')) === 'config');
  check('unknown -> other', errorKind(new Error('something odd')) === 'other');
  check('null does not throw', errorKind(null) === 'other');

  check('the status is extracted as a number', errorStatus(new Error('HTTP 503 Service Unavailable')) === 503);
  check('no status -> undefined', errorStatus(new Error('Failed to fetch')) === undefined);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
