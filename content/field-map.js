/**
 * field-map.js — the EHR-specific selector map.
 *
 * IMPORTANT: this file is the ONLY place that needs updating when the host
 * EHR changes its DOM. Everything else in the extension is host-agnostic.
 *
 * It is loaded two different ways:
 *   1. as a classic content script (manifest.json -> content_scripts.js)
 *   2. as a side-effect import in the service worker
 *      (`import '../content/field-map.js'`)
 * Because of (1) it cannot use `export` — it publishes everything on
 * globalThis.SCRIBE_FIELDS instead.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH FIELD HAS A LIST OF SELECTORS
 * ---------------------------------------------------------------------------
 * Server-rendered EHR forms (ASP.NET MVC, JSF, Rails and friends) derive the
 * DOM `id` from the model binding path, and that derivation is not stable:
 *
 *   name="Note.ObjectiveStatus"
 *     form A -> id="Note_ObjectiveStatus"
 *     form B -> id="Note_ObjectiveStatus_"   <-- trailing underscore
 *
 * The usual cause is a validation wrapper: when a field is wrapped for
 * validation the wrapper takes the base `id` and the real control gets a
 * suffix. Validation can appear or disappear between forms and releases, so
 * `id` is not something to rely on.
 *
 * Therefore: the FIRST selector is always the `[name="..."]` binding path
 * (stable, identical across forms), and the rest are `#id` fallbacks. Both
 * paths are covered by tests/field-draft.test.mjs.
 */
(function () {
  'use strict';

  /**
   * Fields the assistant is allowed to draft.
   *   selectors — tried in order; the first one that matches an element wins.
   *   label     — shown in the UI.
   *   template  — key into lib/prompt-templates.js.
   *   maxTokens — generation limit for this field.
   *   forms     — which form profiles contain the field (documentation only).
   */
  const FIELD_MAP = {
    // =======================================================================
    // Shared fields (present in both the visit note and the discharge summary)
    // =======================================================================
    history_of_illness: {
      selectors: ['textarea[name="Note.HistoryOfIllness"]', '#Note_HistoryOfIllness'],
      label: 'History of present illness',
      template: 'anamnesis',
      maxTokens: 600,
      forms: ['visit-note', 'discharge-summary'],
    },
    objective_status: {
      selectors: [
        'textarea[name="Note.ObjectiveStatus"]',
        '#Note_ObjectiveStatus', // visit note
        '#Note_ObjectiveStatus_', // discharge summary (wrapped for validation)
      ],
      label: 'Objective status',
      template: 'objective_status',
      maxTokens: 500,
      forms: ['visit-note', 'discharge-summary'],
    },
    diagnosis_rationale: {
      selectors: ['textarea[name="DiagnosisBlocks[0].Rationale"]', '#DiagnosisBlocks_0__Rationale'],
      label: 'Diagnosis rationale',
      template: 'diagnosis_rationale',
      maxTokens: 500,
      forms: ['visit-note', 'discharge-summary'],
    },
    decision_context: {
      selectors: [
        'textarea[name="DiagnosisBlocks[0].DecisionContext"]',
        '#DiagnosisBlocks_0__DecisionContext',
      ],
      label: 'Clinical decision context',
      template: 'decision_context',
      maxTokens: 400,
      forms: ['visit-note', 'discharge-summary'],
    },
    treatment_given: {
      selectors: ['textarea[name="TreatmentGiven"]', '#TreatmentGiven'],
      label: 'Non-pharmacological treatment given',
      template: 'treatment_given',
      maxTokens: 500,
      forms: ['visit-note', 'discharge-summary'],
    },
    recommendations: {
      selectors: ['textarea[name="FollowUpRecommendations"]', '#FollowUpRecommendations'],
      label: 'Treatment / nursing / follow-up recommendations',
      template: 'recommendations',
      maxTokens: 600,
      forms: ['visit-note', 'discharge-summary'],
    },

    // =======================================================================
    // Discharge summary only (inpatient episode)
    // =======================================================================
    complaints_and_history: {
      selectors: ['textarea[name="Note.ComplaintsAndHistory"]', '#Note_ComplaintsAndHistory'],
      label: 'Complaints and history',
      template: 'complaints_and_history',
      maxTokens: 500,
      forms: ['discharge-summary'],
    },
    status_at_discharge: {
      selectors: ['textarea[name="StatusAtDischarge"]', '#StatusAtDischarge'],
      label: 'Patient status at discharge',
      template: 'status_at_discharge',
      maxTokens: 400,
      forms: ['discharge-summary'],
    },

    // =======================================================================
    // Visit note only (outpatient encounter)
    // =======================================================================
    complaints: {
      selectors: ['textarea[name="Note.Complaints"]', '#Note_Complaints'],
      label: 'Complaints',
      template: 'complaints',
      maxTokens: 400,
      forms: ['visit-note'],
    },
    patient_instructions: {
      selectors: ['textarea[name="PatientInstructions"]', '#PatientInstructions'],
      label: 'Instructions for the patient',
      template: 'patient_instructions',
      maxTokens: 500,
      forms: ['visit-note'],
    },
    referral_details: {
      selectors: [
        'textarea[name="Referrals[0].AdditionalInformation"]',
        '#Referrals_0__AdditionalInformation',
      ],
      label: 'Referral additional information',
      template: 'referral_details',
      maxTokens: 400,
      forms: ['visit-note'],
    },
  };

  /*
   * =========================================================================
   * FIELDS DELIBERATELY LEFT OUT
   * =========================================================================
   * These fields exist in the forms but are intentionally absent from
   * FIELD_MAP. The reasons are not technical, they are safety reasons. Adding
   * any of them needs a separate, explicit decision.
   *
   *  Allergies[0].*, NewlyIdentifiedAllergies[0].*
   *      Allergies. A hallucinated or dropped allergy is a direct threat to
   *      the patient. Structured, safety-critical data.
   *
   *  MedicationTreatment
   *      Drugs and doses. Populated from the e-prescription system, so
   *      generated prose could contradict the authoritative medication
   *      record. Used ONLY as context for recommendations.
   *
   *  ClinicalDiagnosis, DiagnosisBlocks[0].Description,
   *  PrimaryDiagnosis.Description, SecondaryDiagnoses[0].Description,
   *  Diagnoses[0].Description
   *      Diagnoses. The tool makes no clinical decisions and does not
   *      establish diagnoses. A diagnosis is an INPUT to generation, never an
   *      output.
   *
   *  LabResults, InvestigationsDescription, Investigations.Description
   *      Measured values. The forms carry no authoritative source for them,
   *      so generating them would be pure guesswork. Used ONLY as context.
   *      Could be enabled once a real results feed is wired in.
   *
   *  SurgicalProcedures[0].Description
   *      Procedures actually performed — a record of fact that is not in the
   *      context. Used ONLY as context.
   *
   *  NewbornExamination
   *      Newborn examination findings. No data source, so generating it would
   *      mean inventing physical findings for an infant.
   *
   *  RevisionReason, TemplateName, Notes, PrivateNotes,
   *  Immunisations[0].Notes, InvestigationPlans[0].SpecimenDetails
   *      Administrative / system fields, not clinical narrative.
   */

  /**
   * Context fields — where patient data for the prompt is read from. A value
   * is either a selector string OR an array of alternatives (tried in order;
   * the first selector that yields NON-EMPTY values wins).
   *
   * Other fields of the SAME form are collected too: a draft has to build on
   * everything the clinician has already entered. IMPORTANT: only non-empty
   * values are collected — an empty field never reaches the prompt, not as an
   * empty string and not as a "[TO CONFIRM]" line from `lines()`.
   *
   * DATA MINIMISATION (GDPR): patient name, surname and national ID are
   * DELIBERATELY not collected (.patient-name, .patient-surname,
   * .patient-national-id). A draft does not need them, so they are never sent
   * to the model. Date of birth is read only to derive an age, and is dropped
   * from the context afterwards.
   */
  const CONTEXT_SELECTORS = {
    patientAge: '.patient-age',

    // Date of birth -> age (see deriveAge in content-script.js)
    patientBirthDate: '.patient-birth-date',

    patientSex: '.patient-sex',

    // Diagnoses. Each form stores them differently:
    //   discharge summary -> PrimaryDiagnosis + SecondaryDiagnoses[N]
    //   visit note        -> Diagnoses[N].Diagnosis
    //   both              -> DiagnosisBlocks[N].Diagnosis
    // A single comma-separated selector string returns ALL matches.
    diagnoses: [
      '.dx-list .dx-item',
      [
        '#PrimaryDiagnosis_Name',
        '[id^="SecondaryDiagnoses_"][id$="__Name"]',
        '[id^="Diagnoses_"][id$="__Diagnosis_Name"]',
        '[id^="DiagnosisBlocks_"][id$="__Diagnosis_Name"]',
      ].join(', '),
    ],

    visitReason: ['#visit-reason', '#ReferralDiagnosis_Name'],

    vitals: '.vitals-panel',
    previousNotes: '.history-notes',

    labResults: [
      '.lab-results-table',
      'textarea[name="LabResults"], textarea[name="InvestigationsDescription"], textarea[name="Investigations.Description"]',
    ],

    // Already-filled form fields, used as context for the other fields
    admissionDate: '.admission-date',
    complaints: 'textarea[name="Note.ComplaintsAndHistory"], textarea[name="Note.Complaints"]',
    anamnesisText: 'textarea[name="Note.HistoryOfIllness"]',
    statusText: 'textarea[name="Note.ObjectiveStatus"]',
    treatmentText: 'textarea[name="TreatmentGiven"]',
    medicationText: 'textarea[name="MedicationTreatment"]',
    surgeryText: 'textarea[name="SurgicalProcedures[0].Description"]',
    dischargeStatusText: 'textarea[name="StatusAtDischarge"]',
    recommendationsText: 'textarea[name="FollowUpRecommendations"]',
  };

  /** Context keys always collected as an array, even when a single node matches. */
  const MULTI_VALUE_CONTEXT = new Set(['diagnoses']);

  /**
   * Context keys that count as CLINICAL content — i.e. material a draft can
   * actually be built from.
   *
   * What is NOT on this list, and why: patientAge, patientSex, diagnoses,
   * visitReason, admissionDate. Those are patient-header data. From "male,
   * 67, arrived 08:42" it is IMPOSSIBLE to write a history — only to invent
   * one.
   *
   * That is exactly what used to happen: with no clinical content the prompt
   * still said "write flowing prose, 1-2 paragraphs", and the model filled
   * the void with the most typical presentation it knew. See `noSourceBlock()`
   * in lib/prompt-templates.js.
   */
  const CLINICAL_CONTEXT_KEYS = Object.freeze([
    'fieldDraft',
    'complaints',
    'anamnesisText',
    'statusText',
    'treatmentText',
    'medicationText',
    'surgeryText',
    'dischargeStatusText',
    'recommendationsText',
    'vitals',
    'labResults',
    'previousNotes',
  ]);

  /** Max characters taken from a single context field (guards prompt size). */
  const CONTEXT_CHAR_LIMIT = 4000;

  globalThis.SCRIBE_FIELDS = Object.freeze({
    FIELD_MAP,
    CONTEXT_SELECTORS,
    MULTI_VALUE_CONTEXT,
    CLINICAL_CONTEXT_KEYS,
    CONTEXT_CHAR_LIMIT,
  });
})();
