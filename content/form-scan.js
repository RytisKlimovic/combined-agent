/**
 * form-scan.js — dynamic free-text field discovery for GLOBAL dictation.
 *
 * How this differs from field-map.js:
 *   field-map.js — a static, curated map with prompt templates behind it.
 *                  Drives the "AI draft" button (generation from context).
 *   form-scan.js — dynamic. Finds EVERY free-text field in any form, so
 *                  global dictation also works on forms that are not in the
 *                  curated map yet.
 *
 * Global dictation needs no prompt templates: the model creates nothing, it
 * only ROUTES what the clinician said into fields, based on the field labels.
 */
(function () {
  'use strict';

  const { FIELD_MAP } = globalThis.SCRIBE_FIELDS;

  /**
   * Fields where routing text to the wrong place would be dangerous.
   * They are NOT excluded (the clinician dictates them deliberately), but the
   * review overlay marks them red and leaves them UNCHECKED by default.
   */
  const CRITICAL_PATTERNS = [
    // "allerg" rather than "allergy" — the stem differs between forms:
    // "Allergies", "Allergy-causing substance", but also "Allergic reactions".
    /allerg/i,
    // (?<!non-?) — "non-pharmacological treatment" is the OPPOSITE field
    // (regimen, procedures, diet) and must not be treated as critical.
    /(?<!non-?)pharmac|medicat|\bdrug/i,
    /diagnos/i,
    // RESULTS only (numbers have to be transcribed exactly), not any mention
    // of an "investigation". In radiology "Investigation description" is the
    // clinician's MAIN dictated narrative — marking it critical would
    // devalue every warning (alarm fatigue).
    /laborator/i,
    // `lab[_ -]?result` rather than a bare `lab`, which would also match "label".
    /lab[_\s-]?result/i,
    /(test|investigation|invest)[^\s]*\s*(result|value|data)/i,
    /procedur|operati|surgic/i,
    /immunis|immuniz|vaccin/i,
  ];

  /** Administrative / system fields — not clinical narrative. */
  const ADMIN_PATTERNS = [
    /templatename|template name/i,
    /revisionreason|revision reason/i,
    /distribution/i,
    /privatenotes|private notes/i,
    /fakeuser|fakepass/i,
  ];

  const matchesAny = (patterns, s) => patterns.some((p) => p.test(s));

  /**
   * A "plan" is a narrative (what is intended), not a record of fact, so
   * "Investigation and referral plan" is NOT critical while "Investigation
   * results" is.
   */
  function isCritical(haystack) {
    if (/\bplan/i.test(haystack)) return false;
    return matchesAny(CRITICAL_PATTERNS, haystack);
  }

  /** Model binding path -> human-readable label, when no <label> was found. */
  function humanizeName(name) {
    if (!name) return '';
    const last = String(name).split('.').pop().replace(/\[\d+\]/g, '');
    const spaced = last
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_+/g, ' ')
      .trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : '';
  }

  /**
   * Parent segment of the binding path — used to tell identical labels apart.
   * "Diagnoses[0].Description" -> "Diagnoses"
   */
  function parentContext(name) {
    const parts = String(name || '').split('.');
    return parts.length >= 2 ? humanizeName(parts[parts.length - 2]) : '';
  }

  /**
   * EHR forms typically have several fields whose <label> is just
   * "Description" (diagnoses, allergies, procedures). The model could not
   * tell those apart, so duplicate labels are qualified with the parent
   * segment of the binding path.
   */
  function disambiguateLabels(fields) {
    const counts = new Map();
    for (const f of fields) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);

    const used = new Set();
    for (const f of fields) {
      if (counts.get(f.label) > 1) {
        const ctx = parentContext(f.rawName);
        if (ctx && !new RegExp(ctx, 'i').test(f.label)) f.label = `${ctx} — ${f.label}`;
      }
      // If labels still collide after qualifying (e.g. two "Investigation
      // description" fields), append a number — otherwise the model would
      // route into an arbitrary one.
      let label = f.label;
      for (let i = 2; used.has(label); i++) label = `${f.label} (${i})`;
      f.label = label;
      used.add(label);
    }
    return fields;
  }

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/:$/, '');

  /**
   * Label taken from the first cell of a table row.
   *
   * Older EHR forms have no <label for> at all — the label sits in the
   * neighbouring <td>:
   *   <td class="leftrow">Indications:</td><td><textarea id="EP48"></td>
   *
   * A field can be nested in inner tables, so walk up through parent rows
   * until a cell with text is found.
   */
  function labelFromTableRow(el) {
    let cell = el.closest('td, th');
    for (let depth = 0; cell && depth < 4; depth++) {
      const row = cell.parentElement;
      const first = row?.firstElementChild;
      if (first && first !== cell) {
        const t = clean(first.textContent);
        if (t && t.length <= 60) return t;
      }
      cell = row?.parentElement?.closest('td, th') ?? null;
    }
    return '';
  }

  /** Finds a field label several ways — every EHR marks them up differently. */
  function deriveLabel(el, labelByFor) {
    const byFor = el.id && labelByFor.get(el.id);
    if (byFor) return byFor;

    const parent = el.closest('label');
    if (parent) {
      const t = clean(parent.textContent);
      if (t) return t;
    }

    // `title` is the primary source in older forms that have no <label> but
    // do give every textarea a title="Indications" and so on.
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const v = clean(el.getAttribute(attr));
      if (v) return v;
    }

    const fromRow = labelFromTableRow(el);
    if (fromRow) return fromRow;

    return humanizeName(el.name || el.id);
  }

  /** Visible and editable? Hidden template fields stay out of dictation. */
  function isEditableVisible(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.closest('[hidden]')) return false;
    // offsetParent === null means display:none (or position:fixed — which a
    // textarea in these forms never is).
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** FIELD_MAP key for this element, if the field is in the curated map. */
  function knownKeyFor(el, document) {
    for (const [key, field] of Object.entries(FIELD_MAP)) {
      for (const sel of field.selectors) {
        let match;
        try {
          match = document.querySelector(sel);
        } catch {
          continue;
        }
        if (match === el) return key;
      }
    }
    return null;
  }

  /**
   * Finds every free-text field suitable for global dictation.
   *
   * @returns {Array<{key,el,label,critical,known,value}>}
   *   key      — stable identifier (FIELD_MAP key, otherwise `name`/`id`)
   *   label    — shown to the clinician AND sent to the model as a routing target
   *   critical — safety-sensitive field (allergies, drugs, diagnoses, results)
   *   known    — whether the field is in the curated FIELD_MAP
   */
  function scanFreeTextFields(doc = document) {
    const labelByFor = new Map();
    doc.querySelectorAll('label[for]').forEach((l) => {
      const t = l.textContent.replace(/\s+/g, ' ').trim().replace(/:$/, '');
      if (t) labelByFor.set(l.getAttribute('for'), t);
    });

    const out = [];
    const seenKeys = new Set();

    for (const el of doc.querySelectorAll('textarea')) {
      if (!isEditableVisible(el)) continue;

      const name = el.name || '';
      const id = el.id || '';
      const label = deriveLabel(el, labelByFor);
      const haystack = `${name} ${id} ${label}`;

      if (matchesAny(ADMIN_PATTERNS, haystack)) continue;
      if (!label) continue; // without a label the model has nothing to route to

      const known = knownKeyFor(el, doc);
      const key = known || name || id;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);

      out.push({
        key,
        el,
        rawName: name || id,
        label: known ? (FIELD_MAP[known].label ?? label) : label,
        critical: isCritical(haystack),
        known: !!known,
        value: el.value || '',
      });
    }

    return disambiguateLabels(out);
  }

  globalThis.SCRIBE_SCAN = Object.freeze({
    scanFreeTextFields,
    isCritical,
    humanizeName,
    CRITICAL_PATTERNS,
    ADMIN_PATTERNS,
  });
})();
