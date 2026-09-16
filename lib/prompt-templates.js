/**
 * prompt-templates.js — prompt templates, one per field type.
 * Every template returns an OpenAI `messages` array.
 *
 * The output language lives in a single constant so a deployment can switch
 * the whole assistant to another language by editing one line.
 */

import '../content/field-map.js'; // side effect: populates globalThis.SCRIBE_FIELDS

const { CLINICAL_CONTEXT_KEYS } = globalThis.SCRIBE_FIELDS;

/** Language every draft is written in. */
export const OUTPUT_LANGUAGE = 'English';

/** Placeholder the model must use instead of inventing a missing fact. */
export const TODO = '[TO CONFIRM]';

export const SYSTEM = `You are a clinical documentation assistant. You produce a DRAFT
that a clinician must review and approve. Rules:
- Use ONLY information present in the supplied context. DO NOT INVENT facts,
  diagnoses, investigation results or medications.
- Where data is missing, leave a gap marked ${TODO}.
- Write in ${OUTPUT_LANGUAGE}, in professional clinical register.
- Do not make final clinical decisions — only summarise the context.
- DO NOT INVENT advice, recommendations for investigations or medications,
  conclusions, or diagnoses.
- Return ONLY the field text: no headings, no explanations, no markdown.`;

/** Safe formatting of a context value into the prompt. */
function val(v, fallback = TODO) {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) {
    const joined = v.filter(Boolean).join('; ');
    return joined || fallback;
  }
  const s = String(v).trim();
  return s || fallback;
}

/** Builds lines, skipping those whose context value is absent. */
function lines(...pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${val(v)}`)
    .join('\n');
}

/**
 * What to say when there is no side context at all.
 *
 * If the clinician has typed something into the field, "No additional
 * context" would be a lie and would contradict draftBlock(), which at the
 * same time asserts that the clinician's text IS the data. So in that case
 * we stay silent.
 */
function noCtx(ctx) {
  return ctx?.fieldDraft ? '' : 'No additional context available.';
}

/** The shared patient "header" block, used by every template. */
function patientBlock(ctx) {
  const head = [
    `Patient age: ${val(ctx.patientAge)}`,
    `Sex: ${val(ctx.patientSex)}`,
    `Diagnoses: ${val(ctx.diagnoses)}`,
  ].join('\n');

  const optional = lines(
    ['Referral diagnosis / reason for visit', ctx.visitReason],
    ['Admission date', ctx.admissionDate]
  );

  return optional ? `${head}\n${optional}` : head;
}

function user(content) {
  return { role: 'user', content };
}

function msgs(content) {
  return [{ role: 'system', content: SYSTEM }, user(content)];
}

export const TEMPLATES = {
  // =========================================================================
  // Shared narrative fields
  // =========================================================================
  anamnesis: (ctx) =>
    msgs(
      `Draft the "History of present illness" field.
${patientBlock(ctx)}
${lines(
  ['Complaints', ctx.complaints],
  ['Previous notes', ctx.previousNotes]
) || noCtx(ctx)}

Cover: onset and course of the complaints, significant past illness, what has
already been done. Write flowing prose, 1-2 paragraphs.`
    ),

  objective_status: (ctx) =>
    msgs(
      `Draft the "Objective status / status assessment" field.
${patientBlock(ctx)}
${lines(
  ['Vital signs', ctx.vitals],
  ['Investigation results', ctx.labResults],
  ['Complaints', ctx.complaints],
  ['History of present illness', ctx.anamnesisText]
) || noCtx(ctx)}

Cover only what is in the context. Do not invent examination findings that are
not in the data — mark such places ${TODO}. Write short, factual sentences.`
    ),

  conclusion: (ctx) =>
    msgs(
      `Draft the "Conclusion / recommendations" field.
${patientBlock(ctx)}
${lines(
  ['Vital signs', ctx.vitals],
  ['Investigation results', ctx.labResults],
  ['Previous notes', ctx.previousNotes]
) || noCtx(ctx)}

Summarise the current status and list the next steps that FOLLOW from the
context. Do not suggest specific medications or doses that are not in the
context — mark those ${TODO}.`
    ),

  diary: (ctx) =>
    msgs(
      `Draft a "Progress note" entry (one visit / one day).
${patientBlock(ctx)}
${lines(
  ['Vital signs', ctx.vitals],
  ['Previous notes', ctx.previousNotes]
) || noCtx(ctx)}

Briefly: subjective status, objective change, plan. Max. 5-6 sentences.`
    ),

  diagnosis_rationale: (ctx) =>
    msgs(
      `Draft the "Diagnosis rationale" field.
${patientBlock(ctx)}
${lines(
  ['Complaints', ctx.complaints],
  ['History of present illness', ctx.anamnesisText],
  ['Objective status', ctx.statusText],
  ['Investigation results', ctx.labResults]
) || noCtx(ctx)}

Justify WHY the stated diagnosis follows from the available data: list the
specific history, examination and investigation findings that support it.
DO NOT establish a new diagnosis and do not change the existing one — only
justify the one already stated.
If the context holds insufficient evidence, write ${TODO}.`
    ),

  decision_context: (ctx) =>
    msgs(
      `Draft the "Clinical decision context" field.
${patientBlock(ctx)}
${lines(
  ['Objective status', ctx.statusText],
  ['Treatment given', ctx.treatmentText]
) || noCtx(ctx)}

Describe the circumstances in which the clinical decisions were made (urgency
of the presentation, data available, consultations obtained). From the context
only. Max. 4 sentences.`
    ),

  treatment_given: (ctx) =>
    msgs(
      `Draft the "NON-PHARMACOLOGICAL treatment given" field.
${patientBlock(ctx)}
${lines(
  ['Objective status', ctx.statusText],
  ['Surgical procedures performed', ctx.surgeryText],
  ['History of present illness', ctx.anamnesisText]
) || noCtx(ctx)}

Describe ONLY non-pharmacological treatment (procedures, regimen, diet,
rehabilitation, oxygen therapy and similar).
DO NOT write medications or doses — those are filled in a separate field from
the prescribing system.
If the context names no such procedures, DO NOT INVENT them — write ${TODO}.`
    ),

  // =========================================================================
  // Discharge summary (inpatient episode)
  // =========================================================================
  complaints_and_history: (ctx) =>
    msgs(
      `Draft the "Complaints and history" field (discharge summary).
${patientBlock(ctx)}
${lines(['Previous notes', ctx.previousNotes]) || noCtx(ctx)}

Briefly state why the patient presented and when the complaints began.
IMPORTANT: if the context contains no specific complaints, DO NOT INVENT
them — write ${TODO}. Max. 4-5 sentences.`
    ),

  status_at_discharge: (ctx) =>
    msgs(
      `Draft the "Patient status at discharge" field (discharge summary).
${patientBlock(ctx)}
${lines(
  ['Objective status', ctx.statusText],
  ['Treatment given', ctx.treatmentText],
  ['Investigation results', ctx.labResults]
) || noCtx(ctx)}

Describe the patient's condition at the point of discharge and how it changed
over the course of treatment.
If the context holds no data on the status at discharge, write ${TODO} — DO
NOT GUESS. Max. 4-5 sentences.`
    ),

  recommendations: (ctx) =>
    msgs(
      `Draft the "Treatment, nursing, occupational and follow-up care
recommendations" field.
${patientBlock(ctx)}
${lines(
  ['Status at discharge', ctx.statusText],
  ['Treatment given', ctx.treatmentText],
  ['Medication treatment given', ctx.medicationText],
  ['Investigation results', ctx.labResults]
) || noCtx(ctx)}

Structure (each item on its own line):
- Regimen and nursing:
- Follow-up care (who to see and when):
- Repeat investigations:
- Fitness for work:

The recommendations must FOLLOW from the context. DO NOT start a new
medication and DO NOT change a dose — if that is needed, write ${TODO}. Mark
missing parts ${TODO}.`
    ),

  // =========================================================================
  // Visit note (outpatient encounter)
  // =========================================================================
  complaints: (ctx) =>
    msgs(
      `Draft the "Complaints" field (visit note).
${patientBlock(ctx)}
${lines(['Previous notes', ctx.previousNotes]) || noCtx(ctx)}

State ONLY the patient's complaints (what they feel, since when, what
provokes it).
Do NOT write the history here — it is filled in a separate field.
IMPORTANT: if the context contains no specific complaints, DO NOT INVENT
them — write ${TODO}. Max. 3-4 sentences.`
    ),

  patient_instructions: (ctx) =>
    msgs(
      `Draft the "Instructions for the patient" field (visit note).
${patientBlock(ctx)}
${lines(
  ['Recommendations', ctx.recommendationsText],
  ['Treatment given', ctx.treatmentText],
  ['Objective status', ctx.statusText]
) || noCtx(ctx)}

This text is for the PATIENT, not the clinician. Therefore:
- Write in plain, clear language, without Latin terms or abbreviations.
- Address the patient in the second person ("Take...", "Contact...").
- List concrete steps: what to do, when to come back, which warning signs to
  react to.

DO NOT prescribe medications or doses that are not in the context — write
${TODO}.`
    ),

  referral_details: (ctx) =>
    msgs(
      `Draft the "Referral additional information" field (visit note).
${patientBlock(ctx)}
${lines(
  ['Complaints', ctx.complaints],
  ['History of present illness', ctx.anamnesisText],
  ['Objective status', ctx.statusText],
  ['Investigation results', ctx.labResults]
) || noCtx(ctx)}

This text is for the RECEIVING CONSULTANT. Provide:
- a short clinical summary (why the referral is being made),
- the specific question you want answered.

Be concise (3-5 sentences). If the question cannot be determined from the
context, write ${TODO}.`
    ),
};

/**
 * Block carrying text the clinician has already typed.
 *
 * When the clinician has written "abdominal and head pain" into the field,
 * that is no longer side context — it is the primary source, and the task
 * turns from writing into editing. So the block goes at the END of the prompt
 * (highest recency weight) and explicitly overrides the template's task.
 *
 * @returns {string} empty string if the clinician typed nothing
 */
function draftBlock(ctx) {
  const draft = String(ctx?.fieldDraft ?? '').trim();
  if (!draft) return '';

  return `=== TEXT THE CLINICIAN HAS ALREADY ENTERED IN THIS FIELD ===
${draft}
=== END OF TEXT ===

MOST IMPORTANT: this clinician text is the PRIMARY source. Your task is to
expand it into a tidy entry written in professional clinical register. Rules:
- PRESERVE EVERY fact the clinician stated. Do not drop any and do not change
  their meaning.
- DO NOT ADD clinical detail the clinician DID NOT state — no duration, no
  severity, no refinement of site, no associated symptoms, and no statements
  that such symptoms are absent.
  If such detail is essential to the entry, write ${TODO}.
- DO NOT WRITE that data is missing or that the context is insufficient — the
  clinician's text IS the data.
- Correct only form, terminology and language, never clinical content.`;
}

/** Whether a value carries any real content. */
function filled(v) {
  if (Array.isArray(v)) return v.some((x) => String(x ?? '').trim() !== '');
  return String(v ?? '').trim() !== '';
}

/**
 * Whether the context holds any CLINICAL content at all — i.e. anything a
 * draft could be built from.
 *
 * Patient-header data (age, sex, diagnosis, admission date) is NOT enough: a
 * history cannot be written from it, only invented.
 */
export function hasClinicalSource(ctx) {
  return CLINICAL_CONTEXT_KEYS.some((k) => filled(ctx?.[k]));
}

/**
 * The block used when there is NO clinical data.
 *
 * Why it was needed: the templates carry concrete formatting demands —
 * "cover the onset and course of the complaints", "write flowing prose, 1-2
 * paragraphs". With no data those concrete instructions beat the vaguer
 * system-prompt ban on inventing facts, and the model fills the void with the
 * most typical presentation it knows. In practice it produced abdominal pain
 * that nobody had mentioned.
 *
 * The block goes at the END (recency) and deliberately revokes the template's
 * formatting demands.
 */
function noSourceBlock() {
  return `=== NO CLINICAL DATA SUPPLIED ===
The context contains NO clinical data about this patient: no complaints, no
history, no examination findings, no investigations, no treatment.

Therefore the PRECEDING instructions about length and form (for example
"write 1-2 paragraphs", "cover the course of the complaints") DO NOT APPLY —
do not follow them.

- DO NOT CREATE any clinical content.
- DO NOT INVENT symptoms, complaints, findings, course or investigations —
  not even "typical", "likely" or "common" ones. That would be dangerous to
  the patient.
- DO NOT write an invented example or a template with illustrative symptoms.

Return ONLY a short empty scaffold with ${TODO} markers where the clinician
has to fill in the content themselves. Nothing else.`;
}

// ===========================================================================
// GLOBAL DICTATION — routing one block of speech into many form fields
// ===========================================================================

/** Key the model puts text under when it fits no field. */
export const UNASSIGNED_KEY = '__unassigned';

const DISTRIBUTE_SYSTEM = `You are a clinical documentation assistant. You have been
given a passage dictated by a clinician and a list of form fields together with
their CURRENT contents. Your ONLY task is to work out which fields must change
and return their new contents.

You CREATE NOTHING and you ADD NOTHING of your own. This is a transfer and
editing task, not a writing task.

The clinician may be:
  a) dictating new content into an empty field;
  b) CORRECTING existing content ("the temperature is not 36.9, it's 37.2");
  c) ADDING to existing content ("add nausea to the complaints");
  d) DELETING part of it ("strike the last sentence of the conclusion").

STRICT RULES:
- Return a field ONLY if its contents must change.
  A field the clinician DID NOT MENTION must be SKIPPED — it must not appear
  in the answer at all. Put nothing in it, not "no data", not "${TODO}", not
  an empty string.
- When you return a field, return its FULL new text, not just the changed part.
- When correcting, change ONLY what the clinician explicitly asked for. Leave
  the rest of the field text WORD FOR WORD as it was — do not paraphrase or
  rewrite it in your own words.
- NEVER change or delete a number (blood pressure, pulse, temperature, dose,
  score) that the clinician did not name. Transcribe the ones they did name
  EXACTLY as spoken.
- DO NOT DELETE text unless explicitly asked to.
- DO NOT INVENT symptoms, findings, diagnoses, doses or investigation results.
- If the clinician names a field explicitly ("complaints...", "on
  examination..."), follow that naming rather than your own hunch.
- Text that fits no field goes into "${UNASSIGNED_KEY}".
  DISCARD NOTHING — every sentence spoken must end up somewhere.

Return ONLY a JSON object, no markdown, no explanations:
{"field_key": "full new text", "${UNASSIGNED_KEY}": "remainder"}`;

/**
 * @param {Array<{key:string,label:string,critical?:boolean,value?:string}>} fields — form fields
 * @param {string} transcript — the cleaned-up clinician transcript
 * @param {string} [systemOverride]
 */
export function buildDistributionMessages(fields, transcript, systemOverride) {
  // The current contents are ESSENTIAL: without them the model could neither
  // correct ("not 36.9 but 37.2") nor add — it would simply overwrite the
  // field from scratch.
  const list = (fields ?? [])
    .map((f) => {
      const head = `- "${f.key}" = ${f.label}${f.critical ? ' (safety-critical field)' : ''}`;
      const value = String(f.value ?? '').trim();
      return value ? `${head}\n  current contents: """${value}"""` : `${head}\n  (empty)`;
    })
    .join('\n');

  return [
    { role: 'system', content: systemOverride?.trim() || DISTRIBUTE_SYSTEM },
    {
      role: 'user',
      content: `Form fields (key = label, followed by the current contents):
${list}

Text dictated by the clinician:
"""
${String(transcript ?? '').trim()}
"""

Work out which fields must change and return their FULL new contents.
Skip entirely any field the clinician said nothing about.
Put unused text into "${UNASSIGNED_KEY}".`,
    },
  ];
}

/**
 * Parses the model response into {key: text}. Tolerant of markdown fences and
 * of extra prose around the JSON.
 *
 * @param {string} raw
 * @param {Array<{key:string}>} fields — permitted keys (everything else is rejected)
 * @returns {{assignments: Record<string,string>, unassigned: string}}
 */
export function parseDistribution(raw, fields) {
  const allowed = new Set((fields ?? []).map((f) => f.key));
  const text = String(raw ?? '');

  // Models often wrap JSON in markdown or add commentary — take the object.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The model returned no JSON object.');

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`Could not read the model response: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model response is not an object.');
  }

  const assignments = {};
  let unassigned = '';

  for (const [key, value] of Object.entries(parsed)) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) continue; // empty value = the field was not mentioned

    if (key === UNASSIGNED_KEY) {
      unassigned = v;
    } else if (allowed.has(key)) {
      assignments[key] = v;
    } else {
      // Unknown key — the text is NOT discarded, it goes to unassigned.
      unassigned = unassigned ? `${unassigned}\n${v}` : v;
    }
  }

  return { assignments, unassigned };
}

/**
 * Builds the messages for one field.
 * @param {string} templateKey — key into TEMPLATES
 * @param {object} ctx — the collected page context
 * @param {string} [systemOverride] — user-supplied system prompt override
 */
export function buildMessages(templateKey, ctx, systemOverride) {
  const tpl = TEMPLATES[templateKey];
  if (!tpl) throw new Error(`Unknown prompt template: ${templateKey}`);

  const messages = tpl(ctx ?? {});
  const last = messages[messages.length - 1];

  // Appended centrally so no individual template can forget to do it.
  if (hasClinicalSource(ctx)) {
    const draft = draftBlock(ctx);
    if (draft) last.content = `${last.content}\n\n${draft}`;
  } else {
    // Nothing to generate from — force the model to decline rather than create.
    last.content = `${last.content}\n\n${noSourceBlock()}`;
  }

  if (systemOverride && systemOverride.trim()) {
    messages[0] = { role: 'system', content: systemOverride.trim() };
  }
  return messages;
}
