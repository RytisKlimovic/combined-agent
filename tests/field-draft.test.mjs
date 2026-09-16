/**
 * Tests for the "text the clinician typed -> a draft" path.
 *
 * The scenario comes from real use: the clinician jots "abdominal and head
 * pain" into a field and presses "AI draft". Before this feature the text was
 * IGNORED — the model would reply "for lack of additional context ... nothing
 * is specified [TO CONFIRM]".
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
const { FIELD_MAP, CONTEXT_SELECTORS, MULTI_VALUE_CONTEXT, CONTEXT_CHAR_LIMIT } = globalThis.SCRIBE_FIELDS;
const { buildMessages, TEMPLATES } = await import(pathToFileURL(`${EXT}/lib/prompt-templates.js`).href);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// --- collectContext(fieldKey) from content-script.js, reproduced ----------
const clip = (s) => {
  const t = String(s ?? '').trim().replace(/\s+\n/g, '\n');
  return t.length > CONTEXT_CHAR_LIMIT ? `${t.slice(0, CONTEXT_CHAR_LIMIT)}… [truncated]` : t;
};

function makeCollect(document) {
  const readValue = (n) =>
    n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' ? n.value
      : n.tagName === 'SELECT' ? (n.selectedOptions?.[0]?.text ?? n.value)
        : (n.innerText ?? n.textContent);

  const queryContext = (sel) => {
    for (const c of Array.isArray(sel) ? sel : [sel]) {
      let nodes;
      try { nodes = document.querySelectorAll(c); } catch { continue; }
      if (!nodes.length) continue;
      const v = [...new Set(Array.from(nodes).map((n) => clip(readValue(n))).filter(Boolean))];
      if (v.length) return v;
    }
    return [];
  };

  const findField = (key) => {
    for (const sel of FIELD_MAP[key].selectors) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (el) return el;
    }
    return null;
  };

  return function collectContext(fieldKey) {
    const ctx = {};
    for (const [key, sel] of Object.entries(CONTEXT_SELECTORS)) {
      const values = queryContext(sel);
      if (!values.length) continue;
      ctx[key] = values.length > 1 || MULTI_VALUE_CONTEXT.has(key) ? values : values[0];
    }
    delete ctx.patientBirthDate;

    const el = fieldKey && findField(fieldKey);
    const draft = el ? clip(readValue(el)) : '';
    if (draft) {
      ctx.fieldDraft = draft;
      for (const [k, v] of Object.entries(ctx)) {
        if (k !== 'fieldDraft' && v === draft) delete ctx[k];
      }
    }
    return ctx;
  };
}

const FORM = readFileSync(`${EXT}/demo/visit-note.html`, 'utf8');
const DRAFT_BLOCK = 'TEXT THE CLINICIAN HAS ALREADY ENTERED IN THIS FIELD';

// =========================================================================
// 1. The real scenario
// =========================================================================
console.log('--- Scenario: the clinician typed "abdominal and head pain" ---');
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);

  document.querySelector('#Note_Complaints').value = 'abdominal and head pain';

  const ctx = collectContext('complaints');
  check('the clinician text lands in ctx.fieldDraft', ctx.fieldDraft === 'abdominal and head pain',
    `-> ${JSON.stringify(ctx.fieldDraft)}`);

  const body = buildMessages('complaints', ctx)[1].content;
  check('the clinician text IS in the prompt', body.includes('abdominal and head pain'));
  check('the prompt names it the primary source', /PRIMARY source/.test(body));
  check('the prompt forbids adding detail', /DO NOT ADD clinical detail/.test(body));
  check('the prompt forbids saying data is missing', /DO NOT WRITE that data is missing/.test(body));

  // The draft block has to come AFTER the template's task (recency = the
  // heaviest weight), and no template text may follow it.
  check('the draft block comes AFTER the template task',
    body.indexOf(DRAFT_BLOCK) > body.indexOf('Draft the "Complaints" field'));
  check('the prompt ENDS with the draft block rules',
    body.trim().endsWith('never clinical content.'), `-> ...${body.trim().slice(-40)}`);

  // The misleading line must not remain when there genuinely is context.
  check('no misleading "No additional context available." line',
    !body.includes('No additional context available.'), '-> it would contradict the draft block');
}

// =========================================================================
// 2. An empty field -> no draft block (the old behaviour is preserved)
// =========================================================================
console.log('\n--- An empty field ---');
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);

  const ctx = collectContext('complaints');
  check('an empty field gets no fieldDraft', ctx.fieldDraft === undefined, `-> ${ctx.fieldDraft}`);

  const body = buildMessages('complaints', ctx)[1].content;
  check('an empty field means no draft block in the prompt', !body.includes(DRAFT_BLOCK));
}

// Whitespace only in the field — also counts as empty
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);
  document.querySelector('#Note_Complaints').value = '   \n  ';
  const ctx = collectContext('complaints');
  check('whitespace alone is NOT treated as a draft', ctx.fieldDraft === undefined,
    `-> ${JSON.stringify(ctx.fieldDraft)}`);
}

// =========================================================================
// 3. No duplication: a field that is also its own CONTEXT_SELECTORS source
// =========================================================================
console.log('\n--- No duplication (self-reference) ---');
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);

  // statusText points at the VERY SAME field we are generating
  document.querySelector('#Note_ObjectiveStatus').value = 'Condition satisfactory, BP 130/80.';

  const ctx = collectContext('objective_status');
  check('fieldDraft is set', ctx.fieldDraft === 'Condition satisfactory, BP 130/80.');
  check('the same value is REMOVED from ctx.statusText', ctx.statusText === undefined,
    `-> ${JSON.stringify(ctx.statusText)}`);

  const body = buildMessages('objective_status', ctx)[1].content;
  const occurrences = body.split('Condition satisfactory, BP 130/80.').length - 1;
  check('the text appears in the prompt exactly ONCE', occurrences === 1, `-> ${occurrences}x`);
}

// A different field holding the same text is NOT wrongly deleted
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);

  document.querySelector('#Note_Complaints').value = 'Cough.';
  document.querySelector('#Note_HistoryOfIllness').value = 'Unwell for 3 days.';

  const ctx = collectContext('complaints');
  check('other fields\' context survives', ctx.anamnesisText === 'Unwell for 3 days.', `-> ${ctx.anamnesisText}`);
  check('the generated field\'s value is removed from complaints', ctx.complaints === undefined);
}

// =========================================================================
// 4. It works for EVERY template (centralised in buildMessages)
// =========================================================================
console.log('\n--- Every template receives the draft block ---');
for (const key of Object.keys(TEMPLATES)) {
  const body = buildMessages(key, { fieldDraft: 'MARKER-123', patientAge: '40' })[1].content;
  check(`template "${key}" embeds the clinician text`, body.includes('MARKER-123'));
}

// =========================================================================
// 5. systemOverride does not break the draft block
// =========================================================================
console.log('\n--- Interaction with a system override ---');
{
  const m = buildMessages('complaints', { fieldDraft: 'MARKER-456' }, 'Custom system');
  check('the system override is applied', m[0].content === 'Custom system');
  check('the draft block survives the override', m[1].content.includes('MARKER-456'));
}

// =========================================================================
// 6. A long clinician text is clipped (guards against giant prompts)
// =========================================================================
console.log('\n--- Clipping ---');
{
  const { document } = new JSDOM(FORM).window;
  const collectContext = makeCollect(document);
  document.querySelector('#Note_Complaints').value = 'x'.repeat(CONTEXT_CHAR_LIMIT + 500);
  const ctx = collectContext('complaints');
  check('an over-long draft is clipped', ctx.fieldDraft.length <= CONTEXT_CHAR_LIMIT + 20,
    `-> ${ctx.fieldDraft.length}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
