/**
 * Prompt template tests: the field map and lib/prompt-templates.js must stay
 * in step, and a missing context value must never leak into a prompt as
 * "undefined".
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));

// field-map.js is a classic IIFE -> imported for the side effect, exactly as
// the service worker does.
await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
const { FIELD_MAP, CONTEXT_SELECTORS } = globalThis.SCRIBE_FIELDS;

const { TEMPLATES, buildMessages, SYSTEM, TODO } = await import(
  pathToFileURL(`${EXT}/lib/prompt-templates.js`).href
);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// --- 1. The worker can pick FIELD_MAP up off globalThis -------------------
check('field-map populates globalThis.SCRIBE_FIELDS', !!FIELD_MAP && !!CONTEXT_SELECTORS);

// --- 2. Every field points at a template that exists ----------------------
for (const [key, f] of Object.entries(FIELD_MAP)) {
  check(`field "${key}" -> template "${f.template}" exists`, typeof TEMPLATES[f.template] === 'function');
  check(`field "${key}" has maxTokens`, Number.isInteger(f.maxTokens) && f.maxTokens > 0);
  check(`field "${key}" has selectors`, Array.isArray(f.selectors) && f.selectors.length > 0);
}

// --- 3. The selectors are syntactically plausible -------------------------
//     (a simple check — there is no CSS parser here)
const allSelectors = [...Object.values(FIELD_MAP).flatMap((f) => f.selectors), ...Object.values(CONTEXT_SELECTORS)];
const flat = allSelectors.flat();
check('no selector carries a placeholder marker', !flat.some((s) => /[<>]/.test(s)),
  flat.filter((s) => /[<>]/.test(s)).join(','));

// --- 4. buildMessages with a full context --------------------------------
const fullCtx = {
  patientAge: '67',
  patientSex: 'Male',
  visitReason: 'Breathlessness',
  diagnoses: ['I50.0 Congestive heart failure', 'I10 Hypertension'],
  vitals: 'BP 158/94',
  labResults: 'NT-proBNP 2840',
  previousNotes: 'Cardiology review',
};

const m = buildMessages('anamnesis', fullCtx);
check('buildMessages returns system+user', m.length === 2 && m[0].role === 'system' && m[1].role === 'user');
check('the system prompt forbids inventing facts', /DO NOT INVENT/.test(m[0].content));
check('an array (diagnoses) is joined with ;', m[1].content.includes('I50.0 Congestive heart failure; I10 Hypertension'));
check('context values reach the prompt', m[1].content.includes('67') && m[1].content.includes('Breathlessness'));

// --- 5. buildMessages with an EMPTY context -> TODO, never "undefined" ----
const empty = buildMessages('anamnesis', {});
check(`empty context -> ${TODO}`, empty[1].content.includes(TODO));
check('empty context does NOT write "undefined"', !/undefined/.test(empty[1].content), empty[1].content);
check('empty context does NOT write "null"', !/\bnull\b/.test(empty[1].content));

// --- 6. An empty array / blank string also -> TODO -----------------------
const blank = buildMessages('anamnesis', { diagnoses: [], patientAge: '   ', patientSex: null });
check(`empty array -> ${TODO}`, blank[1].content.includes(`Diagnoses: ${TODO}`), blank[1].content.slice(0, 200));
check(`whitespace string -> ${TODO}`, blank[1].content.includes(`Patient age: ${TODO}`));

// --- 7. Every template renders without error -----------------------------
for (const key of Object.keys(TEMPLATES)) {
  try {
    const msgs = buildMessages(key, fullCtx);
    const ok = msgs.length === 2 && msgs[1].content.length > 50 && !/undefined/.test(msgs[1].content);
    check(`template "${key}" renders a clean prompt`, ok);
  } catch (e) {
    check(`template "${key}" renders a clean prompt`, false, e.message);
  }
}

// --- 8. systemPromptOverride works ---------------------------------------
const over = buildMessages('conclusion', fullCtx, '  My custom prompt  ');
check('the system override replaces the system role', over[0].content === 'My custom prompt');
check('the system override leaves the user role alone', over[1].role === 'user');
const noOver = buildMessages('conclusion', fullCtx, '   ');
check('a blank override -> the default SYSTEM', noOver[0].content === SYSTEM);

// --- 9. An unknown template throws ---------------------------------------
try {
  buildMessages('no-such-template', fullCtx);
  check('an unknown template throws', false);
} catch (e) {
  check('an unknown template throws', /Unknown prompt template/.test(e.message));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
