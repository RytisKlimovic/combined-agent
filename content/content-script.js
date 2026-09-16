/**
 * content-script.js — DOM discovery, context collection, the review UI, writing.
 *
 * THE CORE RULE: no text ever reaches a form field without an explicit human
 * confirmation (the "Insert into form" button). No auto-submit, ever.
 */
(function () {
  'use strict';

  const { FIELD_MAP, CONTEXT_SELECTORS, MULTI_VALUE_CONTEXT, CLINICAL_CONTEXT_KEYS, CONTEXT_CHAR_LIMIT } =
    globalThis.SCRIBE_FIELDS;
  const { Dictation } = globalThis.SCRIBE_DICT;
  const { scanFreeTextFields } = globalThis.SCRIBE_SCAN;
  const { diffWords, hasChanges, editStats, correctionDiff, countChangeGroups } =
    globalThis.SCRIBE_DIFF;

  const BTN_MARK = 'data-scribe-btn';
  const GLOBAL_MARK = 'data-scribe-global';
  const OVERLAY_HOST_ID = 'scribe-overlay-host';

  /** Marker the model must leave where a fact is missing. Mirrors TODO in prompt-templates.js. */
  const TODO = '[TO CONFIRM]';
  const TODO_RE = /\[TO CONFIRM\]/g;

  /** Whether dictation is configured (answered by the service worker). */
  let asrEnabled = false;

  // -------------------------------------------------------------------------
  // Field discovery
  // -------------------------------------------------------------------------

  /** Finds a field element by the first selector that matches. */
  function findField(fieldKey) {
    const field = FIELD_MAP[fieldKey];
    if (!field) return null;
    for (const sel of field.selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** @returns {Array<{key, field, el}>} every known field currently on the page */
  function detectFields() {
    const found = [];
    for (const [key, field] of Object.entries(FIELD_MAP)) {
      const el = findField(key);
      if (el) found.push({ key, field, el });
    }
    return found;
  }

  /**
   * Every field worth showing in the side panel: the dynamic scan (the same
   * one dictation uses — it finds ALL free-text fields) plus curated
   * FIELD_MAP fields that are not <textarea> and so never show up in the scan.
   *
   * The panel used to show FIELD_MAP only — 2 fields where dictation saw 16.
   */
  function allFields() {
    const scanned = scanFreeTextFields();
    const seen = new Set(scanned.map((f) => f.key));
    const extra = detectFields()
      .filter(({ key }) => !seen.has(key))
      .map(({ key, field }) => ({ key, label: field.label, critical: false, known: true, value: '' }));
    return [...scanned, ...extra];
  }

  /** The element for a key — from FIELD_MAP or from the dynamic scan. */
  function resolveField(fieldKey) {
    return findField(fieldKey) ?? scanFreeTextFields().find((f) => f.key === fieldKey)?.el ?? null;
  }

  function labelForKey(fieldKey) {
    return (
      FIELD_MAP[fieldKey]?.label ??
      scanFreeTextFields().find((f) => f.key === fieldKey)?.label ??
      fieldKey
    );
  }

  // -------------------------------------------------------------------------
  // Context collection
  // -------------------------------------------------------------------------

  function clip(s) {
    const t = String(s ?? '').trim().replace(/\s+\n/g, '\n');
    return t.length > CONTEXT_CHAR_LIMIT ? `${t.slice(0, CONTEXT_CHAR_LIMIT)}… [truncated]` : t;
  }

  /**
   * Extracts text from ANY element.
   *
   * The critical detail: <input> is a void element — its textContent is always
   * "". In a real EHR the diagnoses and other data sit in <input value="...">,
   * so without this branch the context would silently come back empty.
   */
  function readValue(node) {
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return node.value;
    if (tag === 'SELECT') return node.selectedOptions?.[0]?.text ?? node.value;
    return node.innerText ?? node.textContent;
  }

  /**
   * @param {string|string[]} sel — one selector, or alternatives tried in
   *   order (different forms use different selectors).
   */
  function queryContext(sel) {
    for (const candidate of Array.isArray(sel) ? sel : [sel]) {
      let nodes;
      try {
        nodes = document.querySelectorAll(candidate);
      } catch {
        continue; // bad selector in the map — do not break the whole collection
      }
      if (!nodes.length) continue;

      // Deduplicate: EHR forms often carry the same `name` on both a visible
      // and a hidden input, so the same diagnosis would otherwise reach the
      // prompt twice.
      const values = [...new Set(Array.from(nodes).map((n) => clip(readValue(n))).filter(Boolean))];
      if (values.length) return values; // the first selector with VALUES wins
    }
    return [];
  }

  /**
   * Age is derived from the date of birth — deterministically, not by the
   * model. The EHR shows "DoB: 1990-01-01"; there is no separate age field.
   */
  function deriveAge(birthText) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(birthText ?? '');
    if (!m) return null;

    const birth = new Date(+m[1], +m[2] - 1, +m[3]);
    if (Number.isNaN(birth.getTime())) return null;

    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const beforeBirthday =
      now.getMonth() < birth.getMonth() ||
      (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
    if (beforeBirthday) age--;

    return age >= 0 && age < 130 ? String(age) : null;
  }

  /**
   * @param {string} [fieldKey] — when given, that field's CURRENT contents are
   *   attached as `fieldDraft`, the primary source for generation.
   */
  function collectContext(fieldKey) {
    const ctx = {};
    for (const [key, sel] of Object.entries(CONTEXT_SELECTORS)) {
      const values = queryContext(sel);
      if (!values.length) continue;
      ctx[key] = values.length > 1 || MULTI_VALUE_CONTEXT.has(key) ? values : values[0];
    }

    // If the EHR exposes only a date of birth, derive the age ourselves.
    if (!ctx.patientAge && ctx.patientBirthDate) {
      const age = deriveAge(ctx.patientBirthDate);
      if (age) ctx.patientAge = age;
    }
    // A date of birth is an identifier — it never goes into the prompt (data
    // minimisation).
    delete ctx.patientBirthDate;

    // Text the clinician has already typed in THIS field — the most important
    // source. Without this, "abdominal and head pain" would be ignored and the
    // model would report that there is no data.
    const el = fieldKey && findField(fieldKey);
    const draft = el ? clip(readValue(el)) : '';
    if (draft) {
      ctx.fieldDraft = draft;

      // The same text often also arrives via CONTEXT_SELECTORS (e.g. when
      // generating "Objective status", ctx.statusText points at the very same
      // field). Drop it so it is not duplicated in the prompt.
      for (const [k, v] of Object.entries(ctx)) {
        if (k !== 'fieldDraft' && v === draft) delete ctx[k];
      }
    }

    return ctx;
  }

  // -------------------------------------------------------------------------
  // Writing into a field (React/Angular-safe)
  // -------------------------------------------------------------------------

  /**
   * Frameworks (React) replace the `value` setter and do not see a direct
   * assignment. Call the native prototype setter, then dispatch events.
   */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;

    const nativeSetter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const ownSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;

    if (nativeSetter && nativeSetter !== ownSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
  }

  function insertIntoField(el, text) {
    el.focus();

    if (el.isContentEditable) {
      el.textContent = text;
    } else {
      setNativeValue(el, text);
    }

    // So the host application (React/Angular/Vue) "sees" the change.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // The review overlay (Shadow DOM — host page styles cannot leak in)
  // -------------------------------------------------------------------------

  /** Shortens text for a UI strip (never for a prompt). */
  function trimForUi(s, max = 90) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  const overlay = (() => {
    let host = null;
    let root = null;
    let els = {};
    let state = {
      fieldKey: null,
      port: null,
      busy: false,
      dictation: null,
      onStopRec: null,
      mode: 'single',
      /** key -> DOM element, for the global-dictation review */
      distTargets: null,

      // -- metrics (see lib/metrics.js) -------------------------------------
      /**
       * The generated draft exactly as the model RETURNED it.
       *
       * Kept ONLY so that, on insert, there is something to compare the
       * clinician's edited version against (editedPct — the main quality
       * metric). Cleared along with everything else in close(): this is PHI.
       */
      generatedText: '',
      /** When the review was opened — for the "how long did it take" measure. */
      openedAt: 0,
      /** How many times "Regenerate" was pressed for this review. */
      regens: 0,
    };

    /**
     * A metrics event to the service worker.
     *
     * DELIBERATELY sends no text at all — only numbers and fixed keys. Even if
     * something accidentally passed more, sanitize() in lib/metrics.js would
     * strip it, but it is better not to send it through the page in the first
     * place.
     */
    function sendMetric(event, data) {
      try {
        chrome.runtime.sendMessage({ type: 'METRIC', event, data }).catch(() => {});
      } catch {
        /* extension reloaded — a metric is not worth an error */
      }
    }

    const CSS = `
      :host { all: initial; }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(15, 23, 42, .45);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .panel {
        background: #fff; width: min(720px, 92vw); max-height: 86vh;
        border-radius: 12px; display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,.35); overflow: hidden;
      }
      .ai-banner {
        background: #fef3c7; color: #78350f; border-bottom: 2px solid #f59e0b;
        padding: 10px 16px; font-size: 13px; font-weight: 600;
        display: flex; align-items: center; gap: 8px;
      }
      .head {
        padding: 14px 16px 0; display: flex; justify-content: space-between; align-items: baseline;
      }
      .title { font-size: 16px; font-weight: 600; color: #0f172a; margin: 0; }
      .meta { font-size: 12px; color: #64748b; }
      .body { padding: 12px 16px; overflow: auto; flex: 1; }
      textarea {
        width: 100%; box-sizing: border-box; min-height: 260px; resize: vertical;
        font: 14px/1.55 ui-monospace, "Cascadia Code", Consolas, monospace;
        color: #0f172a; background: #fffdf7;
        border: 2px solid #f59e0b; border-radius: 8px; padding: 12px;
      }
      textarea:focus { outline: 2px solid #2563eb; outline-offset: 1px; }
      .seed {
        margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; font-size: 12.5px;
        background: #ecfdf5; color: #065f46; border: 1px solid #6ee7b7;
      }
      .rec {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 10px; padding: 10px 12px; border-radius: 6px;
        background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; font-size: 13px;
      }
      .rec-dot {
        width: 10px; height: 10px; border-radius: 50%; background: #dc2626; flex: none;
        animation: pulse 1.2s ease-in-out infinite;
      }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
      .rec-label { font-weight: 600; flex: none; }
      .meter {
        flex: 1; height: 6px; border-radius: 3px; background: #fecaca; overflow: hidden;
      }
      .meter-fill {
        height: 100%; width: 0%; background: #dc2626; border-radius: 3px;
        transition: width .1s linear;
      }
      @media (prefers-reduced-motion: reduce) {
        .rec-dot { animation: none; }
        .meter-fill { transition: none; }
      }
      .warn {
        margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 13px;
        background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;
      }
      .status { margin-top: 10px; font-size: 13px; color: #64748b; min-height: 18px; }
      .status.error { color: #991b1b; font-weight: 500; }
      .foot {
        padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #f8fafc;
        display: flex; gap: 8px; justify-content: flex-end; align-items: center;
      }
      .spacer { flex: 1; }
      button {
        font: 500 13px system-ui, sans-serif; padding: 8px 14px; border-radius: 6px;
        border: 1px solid #cbd5e1; background: #fff; color: #0f172a; cursor: pointer;
      }
      button:hover:not(:disabled) { background: #f1f5f9; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      .primary:hover:not(:disabled) { background: #1d4ed8; }
      .danger { color: #b91c1c; }
      .disclaimer { font-size: 11px; color: #94a3b8; padding: 0 16px 10px; }

      /* --- Multi-field review (global dictation) --- */
      .dist-item {
        border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;
      }
      .dist-item.critical { border-color: #fca5a5; background: #fef2f2; }
      .dist-item.empty { opacity: .55; }
      .dist-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
        font-size: 13px; font-weight: 600; color: #0f172a;
      }
      .dist-head input[type="checkbox"] { width: 15px; height: 15px; margin: 0; flex: none; }
      .dist-tag {
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
        padding: 2px 6px; border-radius: 4px; background: #fee2e2; color: #991b1b;
      }
      .dist-tag.edit { background: #dbeafe; color: #1e3a8a; }
      .diff {
        font: 12.5px/1.6 system-ui, sans-serif; color: #334155;
        padding: 8px 10px; margin-bottom: 6px; border-radius: 6px;
        background: #f8fafc; border: 1px solid #e2e8f0;
        white-space: pre-wrap; word-break: break-word;
      }
      .diff del { background: #fee2e2; color: #991b1b; text-decoration: line-through; }
      .diff ins { background: #dcfce7; color: #166534; text-decoration: none; font-weight: 600; }
      /* Correction review (dictation): marks what the model fixed in the transcript */
      .correction { margin-bottom: 12px; border: 1px solid #fcd34d; background: #fffbeb; border-radius: 8px; padding: 8px 10px; }
      .correction summary { cursor: pointer; font-size: 13px; font-weight: 650; color: #92400e; list-style: none; }
      .correction summary::-webkit-details-marker { display: none; }
      .correction summary::before { content: "▸ "; }
      .correction[open] summary::before { content: "▾ "; }
      .correction .corr-diff { margin-top: 8px; margin-bottom: 0; }
      .dist-note { font-size: 11px; font-weight: 400; color: #94a3b8; margin-left: auto; }
      .dist-item textarea {
        min-height: 62px; border-color: #cbd5e1; background: #fff; font-size: 13px;
      }
      .dist-item.critical textarea { border-color: #fca5a5; }
      .unassigned {
        border: 1px solid #f59e0b; background: #fffbeb; color: #78350f;
        border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px;
      }
      .unassigned strong { display: block; margin-bottom: 4px; }
      .unassigned textarea {
        min-height: 54px; border-color: #f59e0b; background: #fff; font-size: 13px;
      }
      /*
       * REQUIRED, and it must STAY LAST. An author 'display' (e.g.
       * .rec {display:flex}) beats the browser default [hidden]{display:none},
       * so without this rule the 'hidden' attribute would not work — the
       * recording strip stayed visible after dictation ('els.rec.hidden = true'
       * set the attribute, but CSS ignored it). !important makes 'hidden'
       * always win; putting it last keeps it unambiguous.
       */
      [hidden] { display: none !important; }
    `;

    function build() {
      host = document.createElement('div');
      host.id = OVERLAY_HOST_ID;
      root = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = CSS;

      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      backdrop.innerHTML = `
        <div class="panel" role="dialog" aria-modal="true" aria-label="AI draft review">
          <div class="ai-banner">AI-GENERATED DRAFT — review is mandatory before inserting</div>
          <div class="head">
            <h2 class="title"></h2>
            <span class="meta"></span>
          </div>
          <div class="body">
            <div class="rec" hidden>
              <span class="rec-dot"></span>
              <span class="rec-label">Recording…</span>
              <span class="meter"><span class="meter-fill"></span></span>
              <button class="stop-rec primary">Stop dictation</button>
            </div>
            <div class="seed" hidden></div>

            <div class="single">
              <textarea spellcheck="true" aria-label="Generated draft"></textarea>
              <div class="warn" hidden></div>
            </div>

            <div class="multi" hidden>
              <details class="correction" hidden>
                <summary></summary>
                <div class="diff corr-diff"></div>
              </details>
              <div class="dist-list"></div>
              <div class="unassigned" hidden>
                <strong>Not assigned to any field — move it across by hand:</strong>
                <textarea class="unassigned-text" spellcheck="true"
                  aria-label="Unassigned text" readonly></textarea>
              </div>
            </div>

            <div class="status"></div>
          </div>
          <div class="foot">
            <button class="regen">Regenerate</button>
            <span class="spacer"></span>
            <button class="danger reject">Discard</button>
            <button class="primary insert" disabled>Insert into form</button>
            <button class="primary insert-all" hidden disabled>Insert selected</button>
          </div>
          <div class="disclaimer">
            Clinical responsibility for the final record rests with the clinician. This tool
            produces a draft only and never submits the form automatically.
          </div>
        </div>
      `;

      root.append(style, backdrop);
      document.documentElement.appendChild(host);

      els = {
        backdrop,
        title: root.querySelector('.title'),
        meta: root.querySelector('.meta'),
        seed: root.querySelector('.seed'),
        textarea: root.querySelector('textarea'),
        warn: root.querySelector('.warn'),
        status: root.querySelector('.status'),
        insert: root.querySelector('.insert'),
        regen: root.querySelector('.regen'),
        reject: root.querySelector('.reject'),
        rec: root.querySelector('.rec'),
        meterFill: root.querySelector('.meter-fill'),
        stopRec: root.querySelector('.stop-rec'),
        single: root.querySelector('.single'),
        multi: root.querySelector('.multi'),
        distList: root.querySelector('.dist-list'),
        correction: root.querySelector('.correction'),
        corrSummary: root.querySelector('.correction summary'),
        corrDiff: root.querySelector('.corr-diff'),
        unassigned: root.querySelector('.unassigned'),
        unassignedText: root.querySelector('.unassigned-text'),
        insertAll: root.querySelector('.insert-all'),
      };

      els.insert.addEventListener('click', onInsert);
      els.insertAll.addEventListener('click', onInsertAll);
      // Wrapped: passing `close` directly would hand the Event in as `reason`.
      els.reject.addEventListener('click', () => close('close'));
      els.regen.addEventListener('click', () => {
        state.regens++;
        sendMetric('draft.regenerated', { fieldKey: state.fieldKey, attempt: state.regens });
        generate(state.fieldKey);
      });
      els.stopRec.addEventListener('click', () => state.onStopRec?.());
      els.textarea.addEventListener('input', refreshWarnings);
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) close();
      });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      });
    }

    function refreshWarnings() {
      const text = els.textarea.value;
      const count = (text.match(TODO_RE) || []).length;

      if (count) {
        els.warn.hidden = false;
        els.warn.textContent = `${count} ${TODO} marker(s) left in the text — fill them in before inserting.`;
      } else {
        els.warn.hidden = true;
      }

      // Inserting is allowed only when there is something to insert and
      // generation has finished.
      els.insert.disabled = state.busy || !text.trim();
    }

    function setStatus(msg, isError = false) {
      els.status.textContent = msg;
      els.status.classList.toggle('error', isError);
    }

    /**
     * A clean initial state — the ONLY place it is established.
     * Without this the dictation recording strip carried over into the "AI
     * draft" action.
     */
    function resetPanel() {
      els.rec.hidden = true;
      els.meterFill.style.width = '0%';
      els.seed.hidden = true;
      els.warn.hidden = true;
      els.unassigned.hidden = true;
      els.unassignedText.value = '';
      els.distList.replaceChildren();
      els.correction.hidden = true;
      els.corrDiff.replaceChildren();
      state.distTargets = null;
      setStatus('');
    }

    /** Switches between the single-field and multi-field (global dictation) view. */
    function setMode(mode) {
      const multi = mode === 'multi';
      els.single.hidden = multi;
      els.multi.hidden = !multi;
      els.insert.hidden = multi;
      els.insertAll.hidden = !multi;
      els.regen.hidden = multi;
      state.mode = mode;
    }

    function open(fieldKey) {
      if (!host) build();
      const field = FIELD_MAP[fieldKey];

      // A new review session only when the field changes. "Regenerate" goes
      // through open() with the same field — and then the timer and the
      // regeneration counter must survive, otherwise msOpen would only
      // measure the last attempt.
      if (state.fieldKey !== fieldKey) {
        state.openedAt = Date.now();
        state.regens = 0;
        state.generatedText = '';
      }
      state.fieldKey = fieldKey;
      els.title.textContent = labelForKey(fieldKey);
      els.meta.textContent = `max ${field?.maxTokens ?? '—'} tokens`;

      resetPanel();
      setMode('single');

      host.style.display = '';
      els.textarea.focus();
    }

    /**
     * @param {'close'|'abort'|'error'} reason — how the review ended.
     *   The default 'close' = the clinician closed it without inserting. The
     *   insert path writes its own metric (onInsert) and clears
     *   state.generatedText THERE — which is exactly why an inserted draft is
     *   not recorded a second time here.
     */
    function close(reason = 'close') {
      // There was a draft, but it never reached the form — that is a
      // rejection. This number shows which fields genuinely do not work,
      // which usage counts alone would never reveal.
      if (state.generatedText) {
        sendMetric('draft.discarded', {
          fieldKey: state.fieldKey,
          msOpen: state.openedAt ? Date.now() - state.openedAt : 0,
          chars: els.textarea.value.length,
          regens: state.regens,
          reason,
        });
      }

      abort();
      if (host) host.style.display = 'none';
      // Clear the text out of the DOM — a draft can contain PHI, and the
      // overlay stays attached to the page (it is only hidden).
      els.textarea.value = '';
      els.seed.textContent = '';
      els.seed.hidden = true;
      els.distList.replaceChildren();
      els.unassignedText.value = '';
      els.unassigned.hidden = true;
      state.distTargets = null;
      state.fieldKey = null;
      // generatedText is PHI — cleared along with everything else.
      state.generatedText = '';
      state.openedAt = 0;
      state.regens = 0;
    }

    function abort() {
      if (state.port) {
        try {
          state.port.postMessage({ type: 'ABORT' });
          state.port.disconnect();
        } catch {
          /* already disconnected */
        }
        state.port = null;
      }
      // The microphone must stop no matter what — otherwise the browser's
      // recording indicator stays lit and the clinician would believe they
      // are still being listened to.
      if (state.dictation) {
        state.dictation.stop();
        state.dictation = null;
      }
      els.rec.hidden = true;
      els.meterFill.style.width = '0%';
      state.onStopRec = null;
      state.busy = false;
    }

    function onInsert() {
      const el = resolveField(state.fieldKey);
      if (!el) {
        setStatus('The field is no longer on the page — the form may have been closed.', true);
        return;
      }

      // The metric goes BEFORE close(), because close() clears the text and
      // the state. This is the single most important event in the whole set:
      // editedPct shows how usable the draft was, not merely how often it was
      // used.
      const final = els.textarea.value;
      if (state.generatedText) {
        const { editedWords, totalWords, editedPct } = editStats(state.generatedText, final);
        sendMetric('draft.inserted', {
          fieldKey: state.fieldKey,
          msOpen: state.openedAt ? Date.now() - state.openedAt : 0,
          chars: final.length,
          editedPct,
          editedWords,
          totalWords,
          todoMarkers: (final.match(TODO_RE) || []).length,
          regens: state.regens,
        });
      }

      // REQUIRED before close(): otherwise close() would record the same
      // draft a second time as "discarded".
      state.generatedText = '';

      insertIntoField(el, final);
      close();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // --- Multi-field (global dictation) review -----------------------------

    /** Enables "Insert selected" when at least one field is checked. */
    function refreshInsertAll() {
      const checked = els.distList.querySelectorAll('input[type="checkbox"]:checked').length;
      els.insertAll.disabled = state.busy || checked === 0;
      els.insertAll.textContent = checked
        ? `Insert selected (${checked})`
        : 'Insert selected';
    }

    /**
     * One field row in the review.
     *
     * UNCHECKED by default when:
     *   - the field is safety-critical (allergies, drugs, diagnoses,
     *     results) — the clinician must confirm those deliberately;
     *   - the field already has text — inserting would overwrite it.
     *
     * @param {object} field — from scanFreeTextFields (has .value = current contents)
     * @param {string|undefined} proposed — the new contents the model suggests;
     *   undefined means the clinician did not mention this field.
     */
    function makeDistRow(field, proposed) {
      const current = String(field.value ?? '');
      const touched = typeof proposed === 'string' && proposed.trim() !== '';
      // Show the suggestion; for untouched fields show the existing contents,
      // so the clinician sees the real state of the form rather than a blank.
      const shown = touched ? proposed : current;
      const isEdit = touched && current.trim() !== '';

      const item = document.createElement('div');
      item.className = 'dist-item';
      item.dataset.key = field.key;
      if (field.critical) item.classList.add('critical');
      if (!touched) item.classList.add('empty');

      const head = document.createElement('div');
      head.className = 'dist-head';

      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer;';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !shown.trim();
      // Safety-critical fields are always ticked by the clinician themselves.
      cb.checked = touched && !field.critical;
      cb.addEventListener('change', refreshInsertAll);

      const name = document.createElement('span');
      name.textContent = field.label;

      label.append(cb, name);
      head.append(label);

      if (isEdit) {
        const tag = document.createElement('span');
        tag.className = 'dist-tag edit';
        tag.textContent = 'changing';
        tag.title = 'Existing text will be replaced — check the highlighted differences';
        head.append(tag);
      }

      if (field.critical) {
        const tag = document.createElement('span');
        tag.className = 'dist-tag';
        tag.textContent = 'verify';
        tag.title = 'Safety-critical field — confirm it separately';
        head.append(tag);
      }

      const note = document.createElement('span');
      note.className = 'dist-note';
      if (!touched) note.textContent = current.trim() ? 'unchanged' : 'not mentioned';
      head.append(note);

      item.append(head);

      // When editing it is ESSENTIAL to show what actually changed —
      // otherwise a quietly altered number would go unnoticed.
      if (isEdit) {
        const parts = diffWords(current, proposed);
        if (hasChanges(parts)) item.append(makeDiffBlock(parts));
      }

      const ta = document.createElement('textarea');
      ta.spellcheck = true;
      ta.value = shown;
      ta.setAttribute('aria-label', field.label);
      ta.addEventListener('input', () => {
        // With the text deleted, a tick no longer means anything.
        if (!ta.value.trim()) cb.checked = false;
        cb.disabled = !ta.value.trim();
        refreshInsertAll();
      });

      item.append(ta);
      return item;
    }

    /** The diff block: removals struck through in red, additions in green. */
    function makeDiffBlock(parts) {
      const box = document.createElement('div');
      box.className = 'diff';
      box.title = 'Red — removed, green — added';
      box.append(...diffNodes(parts)); // <del>/<ins> — semantic, and readable by screen readers
      return box;
    }

    /**
     * Shows what the correction pass changed in the dictated text
     * (raw -> corrected). Highlighted spots are the "suspicious" ones: that is
     * where the microphone or the grammar was imprecise.
     */
    function showCorrection(raw, corrected) {
      els.correction.hidden = true;
      els.correction.open = false;
      els.corrDiff.replaceChildren();
      if (!raw || raw === corrected) return;

      // Insignificant (case / punctuation) changes are dropped; what remains
      // is what is worth checking, highlighted at character precision.
      const parts = correctionDiff(raw, corrected);
      if (!hasChanges(parts)) return;

      const groups = countChangeGroups(parts);
      els.corrSummary.textContent = groups
        ? `The model corrected ${groups} spot(s) — check the highlighted ones`
        : 'Model corrections — check the highlighted spots';
      els.corrDiff.replaceChildren(...diffNodes(parts));
      els.correction.hidden = false;
      els.correction.open = true; // open it so the highlights are visible at once
    }

    /** diffWords parts -> DOM nodes (red — removed, green — added). */
    function diffNodes(parts) {
      return parts.map((p) => {
        if (p.type === 'same') return document.createTextNode(p.text);
        const el = document.createElement(p.type === 'del' ? 'del' : 'ins');
        el.textContent = p.text;
        return el;
      });
    }

    function renderDistribution(fields, result, transcript, raw) {
      setMode('multi');

      els.seed.hidden = false;
      els.seed.textContent = `Dictated: “${trimForUi(transcript, 160)}”`;

      // Correction highlights: what was fixed relative to what the microphone
      // heard. The highlighted spots are where ASR or grammar was imprecise,
      // i.e. exactly the ones worth re-reading instead of the whole text.
      showCorrection(raw, transcript);

      state.distTargets = new Map(fields.map((f) => [f.key, f.el]));

      // Touched fields go to the top — a full form has around 20 fields, and
      // without sorting the 3 that changed get lost among the 18 that did not.
      const assignments = result.assignments ?? {};
      const ordered = [...fields].sort((a, b) => {
        const ta = typeof assignments[a.key] === 'string' && assignments[a.key].trim() !== '';
        const tb = typeof assignments[b.key] === 'string' && assignments[b.key].trim() !== '';
        return ta === tb ? 0 : ta ? -1 : 1;
      });

      els.distList.replaceChildren(...ordered.map((f) => makeDistRow(f, assignments[f.key])));

      // Nothing is lost: if routing failed, the clinician's text is shown here
      // in full rather than disappearing.
      const leftover = result.error ? transcript : result.unassigned;
      if (leftover) {
        els.unassigned.hidden = false;
        els.unassignedText.value = leftover;
      }

      const assigned = Object.keys(result.assignments ?? {}).length;
      if (result.error) {
        setStatus(`Could not distribute into fields: ${result.error}`, true);
      } else if (assigned === 0) {
        setStatus('No field was recognised — move the text across by hand.', true);
      } else {
        setStatus('Review each field and tick the ones to insert.');
      }

      refreshInsertAll();
    }

    function onInsertAll() {
      const rows = Array.from(els.distList.querySelectorAll('.dist-item'));
      let inserted = 0;
      const failed = [];

      for (const row of rows) {
        const cb = row.querySelector('input[type="checkbox"]');
        if (!cb?.checked) continue;

        const text = row.querySelector('textarea').value.trim();
        if (!text) continue;

        const el = state.distTargets?.get(row.dataset.key);
        if (!el?.isConnected) {
          failed.push(row.dataset.key);
          continue;
        }
        insertIntoField(el, text);
        inserted++;
      }

      if (failed.length) {
        setStatus(`Inserted ${inserted}, but ${failed.length} field(s) were not found on the page.`, true);
        return;
      }
      close();
    }

    /**
     * The shared dictation flow: microphone -> transcription -> correction.
     * Used by both paths (single field and global) so the recording logic
     * lives in one place.
     *
     * The live transcript is shown in the single-field textarea in both cases.
     * @param {'single'|'global'} [mode] — metrics only, does not change the flow.
     * @returns {Promise<{dict: Dictation, text: string}|null>} null = it failed
     */
    async function runDictation(mode = 'single') {
      const dict = new Dictation({
        onPartial: (text) => {
          els.textarea.value = text;
          els.textarea.scrollTop = els.textarea.scrollHeight;
        },
        onLevel: (level) => {
          els.meterFill.style.width = `${Math.round(level * 100)}%`;
        },
        onError: (msg) => setStatus(msg, true),
      });
      state.dictation = dict;

      const finishUi = () => {
        els.rec.hidden = true;
        els.meterFill.style.width = '0%';
        state.onStopRec = null;
      };

      const bail = (msg) => {
        finishUi();
        state.dictation = null;
        dict.stop();
        setStatus(msg, true);
        return null;
      };

      try {
        setStatus('Connecting to the transcription server and the microphone…');
        await dict.start({ mode });
      } catch (err) {
        return bail(err.message);
      }

      els.rec.hidden = false;
      setStatus('Speak. Press “Stop dictation” when you are done.');

      // Wait until the clinician presses "Stop dictation".
      let stopped = false;
      await new Promise((resolve) => {
        state.onStopRec = () => {
          if (!stopped) {
            stopped = true;
            resolve();
          }
        };
      });

      els.stopRec.disabled = true;
      setStatus('Finalising the transcript…');

      let transcript = '';
      try {
        transcript = await dict.finish();
      } catch (err) {
        setStatus(`Transcription error: ${err.message}`, true);
      }
      els.stopRec.disabled = false;
      finishUi();

      if (!transcript.trim()) return bail('Nothing was recognised. Please try again.');

      // Punctuation, clinical terminology, notation (L4-L5), safety rules.
      els.textarea.value = transcript;
      setStatus('Correcting punctuation and clinical terminology…');
      const { text } = await dict.correct(transcript);
      els.textarea.value = text;

      // The raw transcript is returned so the caller can show WHAT was
      // corrected (dictation highlights) — those are the spots worth checking.
      return { dict, text, raw: transcript };
    }

    /**
     * GLOBAL dictation: one recording -> the model distributes it across every
     * field of the form.
     *
     * The clinician speaks naming the fields ("complaints... on
     * examination..."). The model CREATES NOTHING here — it only routes what
     * was said.
     */
    async function dictateAll() {
      if (!host) build();

      const fields = scanFreeTextFields();

      state.fieldKey = null;
      els.title.textContent = 'Dictate the whole form';
      els.meta.textContent = `${fields.length} free-text field(s)`;
      resetPanel();
      setMode('single'); // show the live transcript while recording
      host.style.display = '';
      abort();

      if (!fields.length) {
        setStatus('No free-text fields found in this form.', true);
        return;
      }

      // While recording, neither "Insert into form" nor "Regenerate" applies.
      els.insert.hidden = true;
      els.regen.hidden = true;
      els.textarea.value = '';
      state.busy = true;

      const res = await runDictation('global');
      if (!res) {
        state.busy = false;
        return;
      }

      setStatus('Distributing into fields…');
      const result = await res.dict.distribute(fields, res.text);

      res.dict.stop();
      state.dictation = null;
      state.busy = false;

      renderDistribution(fields, result, res.text, res.raw);
    }

    /**
     * Entries the assistant (agent) proposes for several fields in ONE review.
     *
     * Uses the same multi-field review as global dictation, so multiple
     * proposals NO LONGER OVERWRITE each other (previously each fill_field
     * opened the same overlay separately and only the last one was visible).
     *
     * @param {Array<{field:string, text:string}>} proposals
     * @returns {{ok:boolean, matched:number, unmatched:string[]}}
     */
    function proposeFields(proposals) {
      if (!host) build();
      const list = Array.isArray(proposals) ? proposals : [];
      const fields = scanFreeTextFields();

      state.fieldKey = null;
      els.title.textContent = 'Assistant proposals';
      resetPanel();
      host.style.display = '';

      if (!fields.length) {
        setMode('multi');
        els.meta.textContent = '0 fields';
        setStatus('No free-text fields found in this form.', true);
        return { ok: true, matched: 0, unmatched: list.map((p) => p.field) };
      }

      // Match the name against a field: exact first, then partial.
      const assignments = {};
      const unmatched = [];
      for (const p of list) {
        const want = String(p.field ?? '').toLowerCase().trim();
        const f =
          fields.find((x) => x.label.toLowerCase() === want) ||
          fields.find((x) => want && x.label.toLowerCase().includes(want));
        if (f) assignments[f.key] = String(p.text ?? '');
        else unmatched.push(p.field);
      }

      els.meta.textContent = `${Object.keys(assignments).length} field(s)`;
      renderDistribution(fields, { assignments, unassigned: '' }, '', '');
      els.seed.textContent = 'Assistant proposals — tick the ones to insert.';
      return { ok: true, matched: Object.keys(assignments).length, unmatched };
    }

    /**
     * Starts generation and streams it into the textarea.
     * @param {string} fieldKey
     * @param {{dictated?: string}} [opts] — dictated text; it ADDS TO the text
     *   already in the field (rather than replacing it — the clinician may
     *   dictate on top of what they already wrote).
     */
    function generate(fieldKey, opts = {}) {
      open(fieldKey);
      abort();

      els.textarea.value = '';
      els.warn.hidden = true;
      state.busy = true;
      els.insert.disabled = true;
      els.regen.disabled = true;

      const context = collectContext(fieldKey);

      if (opts.dictated) {
        context.fieldDraft = context.fieldDraft
          ? `${context.fieldDraft}\n${opts.dictated}`
          : opts.dictated;
      }

      // Show what is being generated from — otherwise the clinician has no way
      // of telling whether their own text was used.
      const hasSource = CLINICAL_CONTEXT_KEYS.some((k) => {
        const v = context[k];
        return Array.isArray(v) ? v.some((x) => String(x).trim()) : String(v ?? '').trim() !== '';
      });

      if (context.fieldDraft) {
        els.seed.hidden = false;
        els.seed.textContent = opts.dictated
          ? `Basis — your dictated text: “${trimForUi(opts.dictated)}”`
          : `Basis — the text you entered: “${trimForUi(context.fieldDraft)}”`;
        setStatus('Expanding your text…');
      } else {
        setStatus('Generating…');
      }

      // With no clinical data a draft would be invented. The model is
      // forbidden from doing that (noSourceBlock), but the clinician needs to
      // know why they are getting nothing but a ${TODO} scaffold.
      if (!hasSource) {
        els.warn.hidden = false;
        els.warn.textContent =
          'This form has no clinical data (complaints, history, examination, investigations). ' +
          `The draft will be a scaffold with ${TODO} only — type or dictate some text.`;
      }

      const port = chrome.runtime.connect({ name: 'scribe-generate' });
      state.port = port;

      port.onMessage.addListener((msg) => {
        switch (msg.type) {
          case 'CHUNK':
            els.textarea.value += msg.delta;
            els.textarea.scrollTop = els.textarea.scrollHeight;
            break;

          case 'DONE':
            if (!els.textarea.value) els.textarea.value = msg.text;
            // The original — the baseline for editedPct when inserting.
            // When streaming, msg.text is the same accumulated text.
            state.generatedText = msg.text ?? els.textarea.value;
            state.busy = false;
            els.regen.disabled = false;
            setStatus('Draft ready. Review and edit it before inserting.');
            refreshWarnings();
            port.disconnect();
            state.port = null;
            break;

          case 'ABORTED':
            state.busy = false;
            els.regen.disabled = false;
            setStatus('Generation cancelled.');
            refreshWarnings();
            break;

          case 'ERROR':
            state.busy = false;
            els.regen.disabled = false;
            setStatus(msg.message, true);
            refreshWarnings();
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (state.busy) {
          state.busy = false;
          els.regen.disabled = false;
          setStatus('The connection to the extension was lost. Please try again.', true);
          refreshWarnings();
        }
      });

      // hasSource goes to the service worker only as a boolean — it is needed
      // for the "did the draft have anything to come from at all" metric.
      port.postMessage({ type: 'START', fieldKey, context, hasSource });
    }

    /**
     * Shows text that arrived from elsewhere (the side-panel conversation) in
     * the same review. Generates nothing and inserts nothing — the clinician
     * still has to read it and press "Insert into form", exactly as with a
     * draft.
     *
     * @returns {{ok: boolean, error?: string}}
     */
    function showDraft(fieldKey, text) {
      // Works with non-curated fields too: inserting needs a field, not a template.
      if (!resolveField(fieldKey)) return { ok: false, error: 'The field was not found on the page.' };

      open(fieldKey);
      abort();
      state.busy = false;
      els.regen.disabled = false;
      els.textarea.value = String(text ?? '');
      setStatus('Text from the conversation — review and edit it before inserting.');
      refreshWarnings();
      els.textarea.focus();
      return { ok: true };
    }

    return { generate, dictateAll, showDraft, proposeFields, open, close };
  })();

  // -------------------------------------------------------------------------
  // The per-field "Generate" buttons
  // -------------------------------------------------------------------------

  const BTN_STYLE = {
    font: '500 12px system-ui, sans-serif',
    margin: '4px 4px 4px 0',
    padding: '4px 10px',
    borderRadius: '5px',
    cursor: 'pointer',
    display: 'inline-block',
  };

  function makeButton(fieldKey, label) {
    const btn = document.createElement('button');
    btn.type = 'button'; // so it can NEVER submit the form
    btn.setAttribute(BTN_MARK, fieldKey);
    btn.textContent = 'AI draft';
    btn.title = `Generate a draft for "${label}" (you will have to confirm it)`;
    Object.assign(btn.style, BTN_STYLE, {
      border: '1px solid #f59e0b',
      background: '#fffbeb',
      color: '#78350f',
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.generate(fieldKey);
    });
    return btn;
  }

  /**
   * One global dictation button for the whole form (rather than a microphone
   * next to every field). Floating, because EHR forms are long — otherwise
   * you would have to scroll back to the top.
   */
  function mountGlobalButton(scanned) {
    const existing = document.querySelector(`[${GLOBAL_MARK}]`);
    const fields = asrEnabled ? scanned : [];

    if (!fields.length) {
      existing?.remove();
      return;
    }

    const caption = `🎤 Dictate the whole form (${fields.length})`;
    if (existing?.isConnected) {
      if (existing.textContent !== caption) existing.textContent = caption;
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button'; // so it can NEVER submit the form
    btn.setAttribute(GLOBAL_MARK, '');
    btn.textContent = caption;
    btn.title =
      'Dictate the whole form in one go, naming the fields as you ' +
      'go ("complaints…", "on examination…"). You will review the text before it is inserted.';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483000',
      font: '600 13px system-ui, sans-serif',
      padding: '10px 16px',
      borderRadius: '999px',
      border: '1px solid #1d4ed8',
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(37, 99, 235, .35)',
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.dictateAll();
    });
    document.body.appendChild(btn);
  }

  /** The last reported field set — so we do not message for nothing. */
  let lastFieldSig = null;

  /**
   * Tells the side panel that the field set changed. The panel may be closed,
   * in which case the message just vanishes — that is fine.
   */
  function notifyFieldsChanged(keys) {
    const sig = keys.join('|');
    if (sig === lastFieldSig) return;
    lastFieldSig = sig;
    try {
      chrome.runtime.sendMessage({ type: 'FIELDS_CHANGED' }).catch(() => {});
    } catch {
      /* panel closed / the service worker has not woken up yet */
    }
  }

  function mountButtons() {
    // "AI draft" — next to every KNOWN field (one that has a curated template).
    const known = detectFields();
    for (const { key, field, el } of known) {
      const existing = document.querySelector(`[${BTN_MARK}="${key}"]`);
      if (!existing?.isConnected) {
        el.insertAdjacentElement('afterend', makeButton(key, field.label));
      }
    }
    // Always scan (not only when dictation is on) — the side panel's "Form"
    // view lives off the same list.
    const scanned = scanFreeTextFields();
    mountGlobalButton(scanned);
    notifyFieldsChanged([...known.map((f) => f.key), ...scanned.map((f) => f.key)]);
  }

  /** Ask the worker whether dictation is configured, then redraw the buttons. */
  async function refreshAsrState() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_ASR_STATE' });
      const next = !!res?.enabled;
      if (next !== asrEnabled) {
        asrEnabled = next;
        mountButtons();
      }
    } catch {
      /* the service worker has not woken up yet — try again later */
    }
  }

  // -------------------------------------------------------------------------
  // SPA support — forms appear without a page reload
  // -------------------------------------------------------------------------

  let rescanTimer = null;
  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(mountButtons, 250); // debounce — MutationObserver fires often
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore our own insertions, or we would loop.
    const relevant = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (n) => n.nodeType === 1 && !n.hasAttribute?.(BTN_MARK) && n.id !== OVERLAY_HOST_ID
      )
    );
    if (relevant) scheduleRescan();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  mountButtons();
  refreshAsrState();

  // Turning dictation on or off in settings — the buttons refresh with no reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('asrEnabled' in changes || 'asrEndpoint' in changes)) {
      refreshAsrState();
    }
  });

  // -------------------------------------------------------------------------
  // Messages from the side panel (the "Form" view)
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':
        sendResponse({ ok: true });
        return false;

      case 'DETECT_FIELDS':
        sendResponse(detectFields().map(({ key, field }) => ({ key, label: field.label })));
        return false;

      // For the panel's list — DOM elements do not travel through messages.
      case 'SCAN_FIELDS':
        sendResponse(
          allFields().map(({ key, label, critical, known, value }) => ({
            key,
            label,
            critical,
            known,
            filled: !!String(value ?? '').trim(),
          }))
        );
        return false;

      case 'START_GENERATION':
        overlay.generate(msg.fieldKey);
        sendResponse({ ok: true });
        return false;

      case 'START_DICTATE_ALL':
        overlay.dictateAll();
        sendResponse({ ok: true });
        return false;

      // A chat answer from the side panel — into the review, not straight into
      // the field.
      case 'INSERT_TEXT':
        sendResponse(overlay.showDraft(msg.fieldKey, msg.text));
        return false;

      // The agent proposes several fields in ONE review (no longer
      // overwriting each other).
      case 'PROPOSE_FIELDS':
        sendResponse(overlay.proposeFields(msg.proposals));
        return false;

      default:
        return false;
    }
  });
})();
