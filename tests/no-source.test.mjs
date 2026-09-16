/**
 * Tests: with NO clinical data, the model must DECLINE rather than create.
 *
 * The real incident this catches:
 *   Pressing "AI draft" on an empty form produced a draft containing
 *   "abdominal pain", which nobody had mentioned anywhere. It was NOT a cache
 *   — it was a hallucination: the prompt said "write flowing prose, 1-2
 *   paragraphs", there was no data, and the model filled the void with the most
 *   typical complaint it knew.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
const { CLINICAL_CONTEXT_KEYS, CONTEXT_SELECTORS } = globalThis.SCRIBE_FIELDS;
const { buildMessages, TEMPLATES, hasClinicalSource, TODO } = await import(
  pathToFileURL(`${EXT}/lib/prompt-templates.js`).href
);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// Exactly the context an EMPTY visit-note form with a test patient produces.
const EMPTY_FORM_CTX = { patientSex: 'male', patientAge: '125', admissionDate: '2026-06-03 08:42' };

const NO_DATA = 'NO CLINICAL DATA SUPPLIED';
const DRAFT_BLOCK = 'TEXT THE CLINICIAN HAS ALREADY ENTERED IN THIS FIELD';

// =========================================================================
// 1. hasClinicalSource — the patient header is NOT enough
// =========================================================================
console.log('--- What counts as a clinical source ---');
check('an empty form -> no clinical source', hasClinicalSource(EMPTY_FORM_CTX) === false);
check('age + sex only -> no source', hasClinicalSource({ patientAge: '67', patientSex: 'male' }) === false);
check('a diagnosis alone -> still no source (a history cannot be written from it)',
  hasClinicalSource({ diagnoses: ['J06.9 Acute upper respiratory infection'] }) === false);
check('a reason for visit alone -> no source', hasClinicalSource({ visitReason: 'Cough' }) === false);
check('an empty object -> no source', hasClinicalSource({}) === false);
check('undefined -> no source', hasClinicalSource(undefined) === false);

check('text typed in the field -> IS a source', hasClinicalSource({ fieldDraft: 'abdominal pain' }) === true);
check('complaints from another field -> IS a source', hasClinicalSource({ complaints: 'Cough' }) === true);
check('a history -> IS a source', hasClinicalSource({ anamnesisText: 'Unwell for 3 days.' }) === true);
check('a status -> IS a source', hasClinicalSource({ statusText: 'BP 130/80' }) === true);
check('investigations -> IS a source', hasClinicalSource({ labResults: 'NT-proBNP 2840' }) === true);
check('vitals -> IS a source', hasClinicalSource({ vitals: 'BP 158/94' }) === true);
check('a blank string is NOT a source', hasClinicalSource({ complaints: '   ' }) === false);
check('an empty array is NOT a source', hasClinicalSource({ diagnoses: [], complaints: [] }) === false);
check('an array of blanks is NOT a source', hasClinicalSource({ complaints: ['', '  '] }) === false);

// =========================================================================
// 2. With no source -> the prompt REVOKES the template's demands
// =========================================================================
console.log('\n--- Empty form: the prompt refuses to create ---');
{
  const body = buildMessages('anamnesis', EMPTY_FORM_CTX)[1].content;

  check('the "no data supplied" block is present', body.includes(NO_DATA));
  check('it revokes the preceding formatting demands', /DO NOT APPLY —\s*\n?do not follow them/.test(body),
    body.slice(body.indexOf(NO_DATA)));
  check('it forbids creating clinical content', /DO NOT CREATE any clinical content/.test(body));
  check('it forbids "typical" symptoms (exactly what happened)',
    /not even "typical"/.test(body) && /DO NOT INVENT symptoms/.test(body));
  check('it forbids an invented example', /DO NOT write an invented example/.test(body));
  check(`it asks for a ${TODO} scaffold only`, /Return ONLY a short empty scaffold/.test(body));

  // Recency: the prohibition must come AFTER "write flowing prose, 1-2 paragraphs"
  check('the prohibition comes AFTER the formatting demands (highest weight)',
    body.indexOf(NO_DATA) > body.indexOf('Write flowing prose'));
  check('the prompt ends with the prohibition', body.trim().endsWith('Nothing else.'));
}

// =========================================================================
// 3. With a source -> no prohibition, the normal flow
// =========================================================================
console.log('\n--- With clinician text: no prohibition ---');
{
  const body = buildMessages('complaints', { ...EMPTY_FORM_CTX, fieldDraft: 'abdominal and head pain' })[1].content;
  check('the prohibition block is absent', !body.includes(NO_DATA));
  check('the clinician text is in the prompt', body.includes('abdominal and head pain'));
  check('the draft block is in force', body.includes(DRAFT_BLOCK));
}
{
  // Cross-field context still counts: another field's content is a source
  const body = buildMessages('anamnesis', { ...EMPTY_FORM_CTX, complaints: 'Cough for 3 days' })[1].content;
  check('another field\'s content counts as a source (no prohibition)', !body.includes(NO_DATA));
  check('  ...and it reaches the prompt', body.includes('Cough for 3 days'));
}

// =========================================================================
// 4. EVERY template is protected (centralised in buildMessages)
// =========================================================================
console.log('\n--- Every template is protected ---');
for (const key of Object.keys(TEMPLATES)) {
  const body = buildMessages(key, EMPTY_FORM_CTX)[1].content;
  check(`template "${key}" with no data -> refuses to create`, body.includes(NO_DATA));
}

// =========================================================================
// 5. Mutually exclusive: the prohibition and the draft block never co-occur
// =========================================================================
console.log('\n--- The blocks never collide ---');
for (const key of Object.keys(TEMPLATES)) {
  const withDraft = buildMessages(key, { fieldDraft: 'x' })[1].content;
  const both = withDraft.includes(NO_DATA) && withDraft.includes(DRAFT_BLOCK);
  check(`"${key}": the two contradictory blocks are not both present`, !both);
}

// =========================================================================
// 6. CLINICAL_CONTEXT_KEYS does not fall behind CONTEXT_SELECTORS
//    (if someone adds a new free-text field, this test reminds them)
// =========================================================================
console.log('\n--- Configuration consistency ---');
const PATIENT_HEADER_KEYS = ['patientAge', 'patientBirthDate', 'patientSex', 'diagnoses', 'visitReason', 'admissionDate'];
const unclassified = Object.keys(CONTEXT_SELECTORS).filter(
  (k) => !CLINICAL_CONTEXT_KEYS.includes(k) && !PATIENT_HEADER_KEYS.includes(k)
);
check('every CONTEXT_SELECTORS key is classified (clinical or patient header)',
  unclassified.length === 0, `-> unclassified: ${unclassified.join(', ')}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
