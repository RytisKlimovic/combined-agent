/**
 * Global dictation tests: field discovery + text routing.
 *
 * The point: the clinician speaks once, naming the fields, and the model lays
 * the text out. The model CREATES NOTHING here — so these tests check that:
 *   - every free-text field is found (including in unknown forms),
 *   - safety-sensitive fields are recognised and flagged,
 *   - fields that were not mentioned stay EMPTY,
 *   - no text is ever lost (unrouted -> "unassigned").
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

/**
 * jsdom has no layout: offsetParent is always null and getBoundingClientRect
 * returns zeros. Patch both so the visibility check behaves like a real
 * browser.
 */
function withLayout(dom) {
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, 'offsetParent', {
    get() { return this.ownerDocument.body; },
    configurable: true,
  });
  proto.getBoundingClientRect = function () {
    return { width: 300, height: 60, top: 0, left: 0, right: 300, bottom: 60 };
  };
  return dom;
}

// form-scan.js is an IIFE that uses `document` — set one up before importing.
const VISIT_NOTE = `${EXT}/demo/visit-note.html`;
const dom = withLayout(new JSDOM(readFileSync(VISIT_NOTE, 'utf8'), { pretendToBeVisual: true }));

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
await import(pathToFileURL(`${EXT}/content/form-scan.js`).href);
const { scanFreeTextFields, isCritical, humanizeName } = globalThis.SCRIBE_SCAN;

const { buildDistributionMessages, parseDistribution, UNASSIGNED_KEY, TODO } = await import(
  pathToFileURL(`${EXT}/lib/prompt-templates.js`).href
);

// =========================================================================
// 1. Risk classification — works in unknown forms too, purely by name
// =========================================================================
console.log('--- Recognising safety-sensitive fields ---');
for (const s of [
  'Allergies[0].Description',
  'Allergy-causing substance',
  // The stem differs between forms — one says "Allergic reactions".
  'Allergic reactions',
  'Allergy history',
  'MedicationTreatment',
  'Medication treatment given',
  'ClinicalDiagnosis',
  'Diagnoses[0].Description',
  'LabResults',
  'Investigation results',
  'SurgicalProcedures[0].Description',
  'Immunisations[0].Notes',
  'Vaccination notes',
]) {
  check(`critical: "${s}"`, isCritical(s) === true);
}

for (const s of [
  'Note.Complaints',
  'Note.HistoryOfIllness',
  'Note.ObjectiveStatus',
  'TreatmentGiven',
  'StatusAtDischarge',
  'FollowUpRecommendations',
  'PatientInstructions',
  'Notes',
  'Indications',
  'Conclusions',
  'Complications',
  // In radiology an "Investigation description" is the clinician's MAIN
  // dictated narrative. Marking it critical would devalue every warning
  // (alarm fatigue), so only RESULTS (numbers) stay critical.
  'Investigation description',
  'InvestigationsDescription',
]) {
  check(`ordinary: "${s}"`, isCritical(s) === false);
}

// A "plan" is a narrative (what is intended), not a record of measured fact.
check('"Investigation and referral plan" is NOT critical', isCritical('Investigation and referral plan') === false);
check('"InvestigationPlans[0]" is NOT critical', isCritical('InvestigationPlans[0].SpecimenDetails') === false);

// The "non-" prefix inverts the meaning — it must not count as critical.
check('"non-pharmacological" is NOT critical', isCritical('Non-pharmacological treatment given') === false);
check('"pharmacological" IS critical', isCritical('Pharmacological treatment given') === true);

// =========================================================================
// 2. humanizeName — when no <label> was found
// =========================================================================
console.log('\n--- Deriving a label from the binding path ---');
check('Note.HistoryOfIllness -> "History of illness"',
  humanizeName('Note.HistoryOfIllness') === 'History of illness',
  `-> ${humanizeName('Note.HistoryOfIllness')}`);
check('Diagnoses[0].Description -> "Description"',
  humanizeName('Diagnoses[0].Description') === 'Description',
  `-> ${humanizeName('Diagnoses[0].Description')}`);
check('empty -> empty', humanizeName('') === '');

// =========================================================================
// 3. Field discovery in the demo visit-note form
// =========================================================================
console.log('\n--- Discovery in the visit-note form ---');
{
  const fields = scanFreeTextFields(dom.window.document);
  check('free-text fields were found', fields.length >= 10, `-> ${fields.length}`);

  const byLabel = (re) => fields.find((f) => re.test(f.label));
  check('"Complaints" found', !!byLabel(/^Complaints$/));
  check('"History of present illness" found', !!byLabel(/History of present illness/));
  check('"Objective status" found', !!byLabel(/Objective status/));
  check('"Instructions for the patient" found', !!byLabel(/Instructions for the patient/));

  check('every field has a label', fields.every((f) => f.label.trim().length > 0));
  check('every field has a key', fields.every((f) => f.key.trim().length > 0));
  check('the keys are unique', new Set(fields.map((f) => f.key)).size === fields.length);
  check('every field carries its DOM element', fields.every((f) => f.el?.tagName === 'TEXTAREA'));

  // THE critical property: the model routes by LABEL, so two identical labels
  // would mean text landing in an arbitrary field.
  const labels = fields.map((f) => f.label);
  check('ALL labels are unique (otherwise the model would route at random)',
    new Set(labels).size === labels.length,
    `-> duplicates: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(', ')}`);

  // "non-pharmacological" is the OPPOSITE field to the pharmacological one —
  // it must not be treated as critical even though it contains "pharmac".
  const nonPharm = fields.find((f) => /non-pharmacological/i.test(f.label));
  check('"Non-pharmacological treatment given" is NOT critical', nonPharm && nonPharm.critical === false,
    `-> ${nonPharm ? nonPharm.critical : 'field not found'}`);
  const pharm = fields.find((f) => /^Medication treatment$/i.test(f.label));
  check('"Medication treatment" IS critical', pharm && pharm.critical === true,
    `-> ${pharm ? pharm.critical : 'field not found'}`);

  // Administrative fields must not reach dictation
  check('TemplateName is EXCLUDED', !fields.some((f) => /templatename/i.test(f.key)));

  // Safety-sensitive fields ARE included (the clinician dictates them
  // deliberately) but they are flagged.
  const criticals = fields.filter((f) => f.critical);
  check('the allergy field is included and flagged critical',
    criticals.some((f) => /allerg/i.test(f.key + f.label)), `-> critical: ${criticals.length}`);
  check('investigation results are flagged critical',
    criticals.some((f) => /investigation/i.test(f.key + f.label)));

  // Known FIELD_MAP fields carry the curated label
  const known = fields.filter((f) => f.known);
  check('some fields are recognised from FIELD_MAP', known.length >= 5, `-> ${known.length}`);

  // Disabled / read-only fields are excluded.
  const target = fields[0].el;
  target.disabled = true;
  check('a disabled field drops out of the list',
    scanFreeTextFields(dom.window.document).length === fields.length - 1,
    `-> ${scanFreeTextFields(dom.window.document).length} vs ${fields.length}`);
  target.disabled = false;

  target.readOnly = true;
  check('a readonly field drops out of the list',
    scanFreeTextFields(dom.window.document).length === fields.length - 1);
  target.readOnly = false;

  check('restoring it brings the field back', scanFreeTextFields(dom.window.document).length === fields.length);
}

// =========================================================================
// 3b. The discharge summary — the other form profile
// =========================================================================
console.log('\n--- Discovery in the discharge-summary form ---');
{
  const d = withLayout(new JSDOM(readFileSync(`${EXT}/demo/discharge-summary.html`, 'utf8'), { pretendToBeVisual: true }));
  const fields = scanFreeTextFields(d.window.document);

  check('free-text fields were found', fields.length >= 10, `-> ${fields.length}`);
  check('"Complaints and history" found', fields.some((f) => /Complaints and history/.test(f.label)));
  check('"Patient status at discharge" found', fields.some((f) => /status at discharge/i.test(f.label)));
  check('RevisionReason is EXCLUDED', !fields.some((f) => /revisionreason/i.test(f.key)));
  check('the newly-identified allergies field is flagged critical',
    fields.some((f) => /allerg/i.test(f.label) && f.critical === true));
  check('all labels unique', new Set(fields.map((f) => f.label)).size === fields.length);
}

// =========================================================================
// 3c. An unknown, older form: no <label for>, names are meaningless codes.
//     The label then has to come from the `title` attribute.
// =========================================================================
console.log('\n--- An unknown form (no <label>, names are codes) ---');
{
  const d = withLayout(new JSDOM(`<!doctype html><body><form>
    <textarea id="EP48" name="EP48" title="Indications"></textarea>
    <textarea id="EP3100" name="EP3100" title="Allergic reactions"></textarea>
    <textarea id="EP51" name="EP51" title="Investigation description"></textarea>
    <textarea id="EP52" name="EP52" title="Conclusions"></textarea>
    <textarea id="EP53" name="EP53" title="Complications"></textarea>
  </form></body>`, { pretendToBeVisual: true }));

  check('the form really has no <label for>',
    d.window.document.querySelectorAll('label[for]').length === 0);

  const f = scanFreeTextFields(d.window.document);
  check('5 free-text fields found', f.length === 5, `-> ${f.length}`);

  const labels = f.map((x) => x.label);
  // THE regression test: these used to come out as "Ep48", "Ep3100" and so on.
  check('the labels are NO LONGER codes (Ep48, Ep3100...)',
    !labels.some((l) => /^Ep\d+$/i.test(l)), `-> ${labels.join(', ')}`);

  for (const want of ['Indications', 'Allergic reactions', 'Investigation description', 'Conclusions', 'Complications']) {
    check(`  "${want}" found`, labels.includes(want), `-> ${labels.join(', ')}`);
  }

  // SAFETY: the allergy field must be flagged in this form too.
  const allergies = f.find((x) => /Allerg/i.test(x.label));
  check('"Allergic reactions" is flagged critical', allergies?.critical === true,
    `-> ${allergies?.critical}`);

  // The radiologist's main field must NOT be critical — otherwise the
  // warnings lose all meaning.
  const investigation = f.find((x) => x.label === 'Investigation description');
  check('"Investigation description" is NOT critical (it is the main narrative)',
    investigation?.critical === false, `-> ${investigation?.critical}`);

  check('all labels are unique', new Set(labels).size === labels.length);
}

// A label taken from the adjacent table cell (no <label>, no title)
{
  const d = withLayout(new JSDOM(
    '<table><tr><td>Conclusions:</td><td><textarea id="X" name="X"></textarea></td></tr></table>',
    { pretendToBeVisual: true }
  ));
  const f = scanFreeTextFields(d.window.document);
  check('the label comes from the adjacent <td>', f[0]?.label === 'Conclusions', `-> ${f[0]?.label}`);
}

// =========================================================================
// 4. The routing prompt
// =========================================================================
console.log('\n--- The routing prompt ---');
{
  const fields = [
    { key: 'complaints', label: 'Complaints' },
    { key: 'history_of_illness', label: 'History of present illness' },
    { key: 'allergies', label: 'Allergies', critical: true },
  ];
  const m = buildDistributionMessages(fields, 'Complaints: abdominal pain.');
  const sys = m[0].content;
  const body = m[1].content;

  check('returns system + user', m.length === 2 && m[0].role === 'system' && m[1].role === 'user');
  check('forbids creating content', /CREATE NOTHING|DO NOT INVENT/.test(sys));
  check('orders unmentioned fields to be skipped', /must be SKIPPED/.test(sys));
  check(`forbids putting ${TODO} into unmentioned fields`, /TO CONFIRM/.test(sys));
  check('protects unnamed numbers', /NEVER change or delete a number/.test(sys));
  check('transcribes named numbers exactly', /EXACTLY as spoken/.test(sys));
  check('demands nothing is discarded', /DISCARD NOTHING/.test(sys));
  check('every field is listed in the prompt',
    fields.every((f) => body.includes(f.key) && body.includes(f.label)));
  check('the critical field is flagged in the prompt', /safety-critical field/.test(body));
  check('the transcript is included', body.includes('abdominal pain'));
}

// --- Correction mode: the prompt sees the CURRENT field contents ----------
console.log('\n--- Correcting by voice (the current contents are in the prompt) ---');
{
  const fields = [
    { key: 'status', label: 'Objective status', value: 'Temperature 36.9 °C. Pulse 78 bpm.' },
    { key: 'complaints', label: 'Complaints', value: '' },
  ];
  const body = buildDistributionMessages(fields, 'The temperature is 37.2, not 36.9.')[1].content;
  const sys = buildDistributionMessages(fields, 'x')[0].content;

  check('the current field contents are in the prompt', body.includes('Temperature 36.9 °C'));
  check('an empty field is marked as empty', /\(empty\)/.test(body));
  check('the prompt knows how to correct', /CORRECTING existing content/.test(sys));
  check('the prompt knows how to append', /ADDING to existing content/.test(sys));
  check('it demands the FULL new text', /return its FULL new text/.test(sys));
  check('it forbids rewriting the unchanged part', /WORD FOR WORD/.test(sys));
  check('it forbids deleting unasked', /DO NOT DELETE text/.test(sys));
}

// =========================================================================
// 5. Response parsing — robustness and "nothing gets lost"
// =========================================================================
console.log('\n--- Response parsing ---');
const FIELDS = [
  { key: 'complaints', label: 'Complaints' },
  { key: 'history', label: 'History' },
  { key: 'status', label: 'Status' },
];

{
  const r = parseDistribution('{"complaints":"Abdominal pain.","status":"Abdomen soft."}', FIELDS);
  check('routes into the named fields',
    r.assignments.complaints === 'Abdominal pain.' && r.assignments.status === 'Abdomen soft.');
  check('an unmentioned field stays EMPTY', r.assignments.history === undefined);
  check('nothing is unassigned', r.unassigned === '');
}
{
  // Models often wrap the JSON in markdown
  const r = parseDistribution('```json\n{"complaints":"Cough."}\n```', FIELDS);
  check('a markdown wrapper does not get in the way', r.assignments.complaints === 'Cough.');
}
{
  const r = parseDistribution('Here is the result:\n{"complaints":"Cough."}\nThat is all.', FIELDS);
  check('prose around the JSON does not get in the way', r.assignments.complaints === 'Cough.');
}
{
  const r = parseDistribution(`{"complaints":"Cough.","${UNASSIGNED_KEY}":"Review tomorrow."}`, FIELDS);
  check('unassigned text is preserved', r.unassigned === 'Review tomorrow.');
}
{
  // An unknown key — the text is NOT LOST, it goes to unassigned
  const r = parseDistribution('{"invented_field":"Important text."}', FIELDS);
  check('an unknown key is rejected', r.assignments.invented_field === undefined);
  check('  ...but its text is NOT LOST', r.unassigned === 'Important text.');
}
{
  const r = parseDistribution('{"complaints":"", "history":"   "}', FIELDS);
  check('empty values are skipped', Object.keys(r.assignments).length === 0);
}
{
  const r = parseDistribution('{"complaints": 42, "history": null}', FIELDS);
  check('non-string values are skipped', Object.keys(r.assignments).length === 0);
}
for (const bad of ['not json at all', '', 'null', '[1,2,3]']) {
  let threw = false;
  try { parseDistribution(bad, FIELDS); } catch { threw = true; }
  check(`an invalid response throws: ${JSON.stringify(bad.slice(0, 12))}`, threw);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
