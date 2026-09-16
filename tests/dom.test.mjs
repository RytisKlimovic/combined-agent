/**
 * DOM tests: context collection from the demo forms + React-safe writing.
 *
 * The content script's functions live inside an IIFE, so their logic is
 * reproduced here 1:1 and the algorithm is checked against a real DOM.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
const { FIELD_MAP, CONTEXT_SELECTORS, MULTI_VALUE_CONTEXT, CONTEXT_CHAR_LIMIT } = globalThis.SCRIBE_FIELDS;

const VISIT_NOTE = `${EXT}/demo/visit-note.html`;
const DISCHARGE = `${EXT}/demo/discharge-summary.html`;

const html = readFileSync(VISIT_NOTE, 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only' });
const { window } = dom;
const { document, HTMLTextAreaElement, HTMLInputElement, Event } = window;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// jsdom has no innerText -> the content script uses `innerText ?? textContent`.
// The fallback to textContent is emulated here.
const text = (n) => (n.innerText ?? n.textContent);

// --- content-script.js logic, reproduced ---------------------------------
const clip = (s) => {
  const t = String(s ?? '').trim().replace(/\s+\n/g, '\n');
  return t.length > CONTEXT_CHAR_LIMIT ? `${t.slice(0, CONTEXT_CHAR_LIMIT)}… [truncated]` : t;
};

function readValue(node) {
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return node.value;
  if (tag === 'SELECT') return node.selectedOptions?.[0]?.text ?? node.value;
  return text(node);
}

/** A CONTEXT_SELECTORS value can be a string OR an array of alternatives. */
function queryContext(doc, sel) {
  for (const candidate of Array.isArray(sel) ? sel : [sel]) {
    let nodes;
    try { nodes = doc.querySelectorAll(candidate); } catch { continue; }
    if (!nodes.length) continue;
    const values = [...new Set(Array.from(nodes).map((n) => clip(readValue(n))).filter(Boolean))];
    if (values.length) return values;
  }
  return [];
}

function collectContext(doc = document) {
  const ctx = {};
  for (const [key, sel] of Object.entries(CONTEXT_SELECTORS)) {
    const values = queryContext(doc, sel);
    if (!values.length) continue;
    ctx[key] = values.length > 1 || MULTI_VALUE_CONTEXT.has(key) ? values : values[0];
  }
  delete ctx.patientBirthDate;
  return ctx;
}

function findField(key, doc = document) {
  for (const sel of FIELD_MAP[key].selectors) {
    let el;
    try { el = doc.querySelector(sel); } catch { continue; }
    if (el) return el;
  }
  return null;
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const nativeSetter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const ownSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
  if (nativeSetter && nativeSetter !== ownSetter) nativeSetter.call(el, value);
  else el.value = value;
}

// --- 1. Every selector is valid CSS against a real DOM -------------------
for (const [key, sel] of Object.entries(CONTEXT_SELECTORS)) {
  const candidates = Array.isArray(sel) ? sel : [sel];
  let ok = true, err = '';
  for (const c of candidates) {
    try { document.querySelectorAll(c); } catch (e) { ok = false; err = `${c}: ${e.message}`; }
  }
  check(`CONTEXT_SELECTORS.${key} is valid CSS`, ok, err);
}

for (const [key, f] of Object.entries(FIELD_MAP)) {
  let ok = true, err = '';
  for (const s of f.selectors) {
    try { document.querySelectorAll(s); } catch (e) { ok = false; err = `${s}: ${e.message}`; }
  }
  check(`FIELD_MAP.${key} selectors are valid CSS`, ok, err);
}

// --- 2. Context collection from the visit note ---------------------------
const ctx = collectContext();
check('patientAge collected', ctx.patientAge === '67', `-> ${JSON.stringify(ctx.patientAge)}`);
check('patientSex collected', ctx.patientSex === 'Male', `-> ${JSON.stringify(ctx.patientSex)}`);
check('visitReason collected', /Breathlessness/.test(ctx.visitReason ?? ''), `-> ${JSON.stringify(ctx.visitReason)}`);

// diagnoses -> MULTI_VALUE -> always an array
check('diagnoses is an array', Array.isArray(ctx.diagnoses), `-> ${typeof ctx.diagnoses}`);
check('all 3 diagnoses collected', ctx.diagnoses?.length === 3, `-> ${ctx.diagnoses?.length}`);
check('a diagnosis carries its ICD code', /I50\.0/.test(ctx.diagnoses?.[0] ?? ''), `-> ${ctx.diagnoses?.[0]}`);

check('vitals collected', /158\/94/.test(ctx.vitals ?? ''), `-> ${JSON.stringify(ctx.vitals?.slice(0, 40))}`);
check('labResults collected', /NT-proBNP/.test(ctx.labResults ?? ''));
check('previousNotes collected', /Cardiology/.test(ctx.previousNotes ?? ''));
check('patientBirthDate is dropped from the context', ctx.patientBirthDate === undefined);

// --- 3. MULTI_VALUE_CONTEXT: a single match is STILL an array -----------
{
  const d2 = new JSDOM('<div class="dx-list"><span class="dx-item">One dx</span></div>');
  const out = queryContext(d2.window.document, CONTEXT_SELECTORS.diagnoses);
  const single = out.length > 1 || MULTI_VALUE_CONTEXT.has('diagnoses') ? out : out[0];
  check('one diagnosis is still an array (so .join cannot break)', Array.isArray(single), `-> ${typeof single}`);
}

// --- 4. Field discovery in the visit note -------------------------------
check('complaints found', findField('complaints')?.name === 'Note.Complaints');
check('history_of_illness found', findField('history_of_illness')?.name === 'Note.HistoryOfIllness');
check('objective_status found', findField('objective_status')?.name === 'Note.ObjectiveStatus');
check('patient_instructions found', findField('patient_instructions')?.name === 'PatientInstructions');
check('referral_details found', findField('referral_details')?.name === 'Referrals[0].AdditionalInformation');

// Discharge-summary-only fields must NOT resolve here (no cross-contamination)
for (const [key, f] of Object.entries(FIELD_MAP)) {
  if (f.forms?.includes('visit-note')) continue;
  check(`discharge-only field "${key}" does not resolve in the visit note`, findField(key) === null);
}

// --- 5. The discharge summary: the same [name=] path, a different #id ----
// This is the whole reason field-map.js prefers [name=] and keeps #id as a
// fallback only. The two forms bind to the same model path but derive
// different ids.
{
  const d = new JSDOM(readFileSync(DISCHARGE, 'utf8'));
  const doc = d.window.document;

  check('objective_status resolves in the discharge summary too',
    findField('objective_status', doc)?.name === 'Note.ObjectiveStatus');
  check('the discharge summary id carries the validation suffix',
    findField('objective_status', doc)?.id === 'Note_ObjectiveStatus_',
    `-> ${findField('objective_status', doc)?.id}`);
  check('the plain #id does NOT exist in the discharge summary',
    doc.querySelector('#Note_ObjectiveStatus') === null);
  check('while the visit note has exactly the plain #id',
    findField('objective_status')?.id === 'Note_ObjectiveStatus',
    `-> ${findField('objective_status')?.id}`);

  check('complaints_and_history found', findField('complaints_and_history', doc)?.name === 'Note.ComplaintsAndHistory');
  check('status_at_discharge found', findField('status_at_discharge', doc)?.name === 'StatusAtDischarge');

  // Visit-note-only fields must not resolve in the discharge summary.
  for (const [key, f] of Object.entries(FIELD_MAP)) {
    if (f.forms?.includes('discharge-summary')) continue;
    check(`visit-note-only field "${key}" does not resolve in the discharge summary`,
      findField(key, doc) === null);
  }

  // The discharge summary splits diagnoses into primary + secondary.
  const dctx = collectContext(doc);
  check('the primary + secondary diagnosis split is collected', dctx.diagnoses?.length === 3,
    `-> ${dctx.diagnoses?.length}`);
  check('the primary diagnosis is first', /J18\.9/.test(dctx.diagnoses?.[0] ?? ''), `-> ${dctx.diagnoses?.[0]}`);
  check('admissionDate collected', /2026-09-08/.test(dctx.admissionDate ?? ''), `-> ${dctx.admissionDate}`);
  check('patientAge is derived elsewhere (no age element here)', dctx.patientAge === undefined);
  check('patientBirthDate is dropped even though the form has one', dctx.patientBirthDate === undefined);
}

// --- 6. The #id fallback works when [name=] is absent -------------------
{
  const d3 = new JSDOM('<textarea id="Note_ObjectiveStatus"></textarea>');
  const el = FIELD_MAP.objective_status.selectors
    .map((s) => d3.window.document.querySelector(s)).find(Boolean);
  check('the #id fallback resolves when [name=] is missing', el?.id === 'Note_ObjectiveStatus');
}

// --- 7. Writing + events ------------------------------------------------
{
  const el = findField('history_of_illness');
  const seen = [];
  ['input', 'change', 'blur'].forEach((t) => el.addEventListener(t, () => seen.push(t)));

  setNativeValue(el, 'Test draft.');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));

  check('the text is written into the field', el.value === 'Test draft.');
  check('input+change+blur were dispatched', seen.join(',') === 'input,change,blur', `-> ${seen}`);
}

// --- 8. The React case: React's _valueTracker --------------------------
// Reproduced from React's source (trackValueOnNode in inputValueTracking.js):
// React installs its OWN value descriptor whose get/set DELEGATE to the native
// ones, but whose setter additionally records `currentValue` — that is the
// "tracker". When something changes the value BYPASSING the tracker (our native
// setter), the tracker's currentValue goes stale -> React's onChange fires.
{
  const el = findField('patient_instructions');
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  const { get, set } = descriptor;

  let currentValue = '' + el.value;
  const tracker = {
    getValue: () => currentValue,
    setValue: (v) => { currentValue = '' + v; },
  };

  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return get.call(this); },
    set(v) { currentValue = '' + v; set.call(this, v); },
  });
  el._valueTracker = tracker;

  setNativeValue(el, 'React text');

  check('the value is set in the React case', el.value === 'React text', `-> "${el.value}"`);
  // The point: the tracker is stale -> React sees the change and fires onChange.
  check('the React tracker stays stale (which is why onChange fires)',
    tracker.getValue() !== el.value, `tracker="${tracker.getValue()}" dom="${el.value}"`);

  // Control: a naive el.value = ... WOULD go through the tracker, and React's
  // onChange would NOT fire.
  const el2 = findField('referral_details');
  let tracked = '';
  Object.defineProperty(el2, 'value', {
    configurable: true,
    get() { return get.call(this); },
    set(v) { tracked = '' + v; set.call(this, v); },
  });
  el2.value = 'the naive way';
  check('control: a naive assignment updates the tracker (React would see nothing)',
    tracked === 'the naive way');
}

// --- 9. The contenteditable branch -------------------------------------
{
  const d4 = new JSDOM('<div id="ce" contenteditable="true"></div>');
  const el = d4.window.document.getElementById('ce');
  Object.defineProperty(el, 'isContentEditable', { value: true });
  if (el.isContentEditable) el.textContent = 'CE text';
  check('writing to contenteditable works', el.textContent === 'CE text');
}

// --- 10. The CONTEXT_CHAR_LIMIT guard ---------------------------------
{
  const huge = 'x'.repeat(CONTEXT_CHAR_LIMIT + 500);
  const out = clip(huge);
  check('an over-long context value is truncated',
    out.length <= CONTEXT_CHAR_LIMIT + 20 && out.endsWith('[truncated]'), `-> ${out.length}`);
}

// --- 11. An empty form value -> the key is skipped (not an empty string) --
{
  const d5 = new JSDOM('<span class="patient-age">   </span>');
  const values = queryContext(d5.window.document, CONTEXT_SELECTORS.patientAge);
  check('an empty context field is skipped entirely', values.length === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
