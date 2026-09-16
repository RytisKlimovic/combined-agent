/**
 * text-diff.js — word-level text comparison.
 *
 * Why it exists: when the clinician CORRECTS an already-filled field by voice
 * ("the temperature is 37.2, not 36.9"), the model returns the FULL new field
 * text. Without a diff the clinician would see only the end result and could
 * not verify that exactly what they asked for changed — a number quietly
 * altered elsewhere would go unnoticed.
 *
 * Uses an LCS (longest common subsequence) algorithm at the word level.
 */
(function () {
  'use strict';

  /** Split keeping whitespace as its own tokens — otherwise formatting is lost. */
  function tokenize(s) {
    return String(s ?? '')
      .split(/(\s+)/)
      .filter((t) => t !== '');
  }

  /**
   * For very long texts the O(n*m) table stops being worth it. In that case
   * the change is shown as a whole rather than word by word.
   */
  const TOKEN_LIMIT = 400;

  /**
   * @returns {Array<{type:'same'|'add'|'del', text:string}>}
   */
  function diffWords(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);

    if (!a.length) return b.length ? [{ type: 'add', text: newText }] : [];
    if (!b.length) return [{ type: 'del', text: oldText }];

    if (a.length > TOKEN_LIMIT || b.length > TOKEN_LIMIT) {
      return [
        { type: 'del', text: String(oldText) },
        { type: 'add', text: String(newText) },
      ];
    }

    const m = a.length;
    const n = b.length;
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] =
          a[i] === b[j]
            ? dp[(i + 1) * width + (j + 1)] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }

    const out = [];
    const push = (type, text) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        push('same', a[i]);
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        push('del', a[i]);
        i++;
      } else {
        push('add', b[j]);
        j++;
      }
    }
    while (i < m) push('del', a[i++]);
    while (j < n) push('add', b[j++]);

    return out;
  }

  /** Whether the texts differ at all (ignoring whitespace-only changes). */
  function hasChanges(parts) {
    return parts.some((p) => p.type !== 'same' && p.text.trim() !== '');
  }

  /**
   * A separate, LARGER limit for metrics (see editStats).
   *
   * The UI diff (TOKEN_LIMIT = 400) runs live, so speed matters there.
   * Metrics are computed ONCE, when "Insert" is pressed, so more is
   * affordable. The limit is not arbitrary: the dp table is (m+1)*(n+1) Int32
   * — at 1200 that is a ~5.8 MB one-off allocation, at 2000 already ~16 MB.
   *
   * WHY THIS IS NEEDED: with a 400-token limit diffWords returns the
   * degenerate "everything deleted + everything added" result, from which
   * editedPct would always be 100. A history-of-illness draft (maxTokens 600)
   * exceeds that limit routinely, i.e. the single most important metric would
   * be a lie almost every time.
   */
  const STATS_TOKEN_LIMIT = 1200;

  /**
   * How much the clinician changed the generated draft before inserting it.
   * This is the only objective measure of draft quality, so it is computed
   * here, next to the diff, rather than at the call site.
   *
   * COUNTED VIA UNCHANGED words, not changed ones:
   *
   *   editedPct = 100 * (1 - unchanged / words_in_the_longer_text)
   *
   * The reason is not style. A one-word SUBSTITUTION is two diff events (old
   * deleted + new added), so counting "changed" tokens would score
   * "temperature 36.9 degrees" -> "temperature 37.2 degrees" as 67 %, when in
   * reality one word of three changed. Substitutions would be systematically
   * inflated by almost 2x — and a substitution is exactly what clinicians do
   * most often (refining a number).
   *
   * Counted via unchanged words the same example gives 33 %, and the result
   * naturally lands in 0-100 with no artificial clamping.
   *
   * @returns {{editedWords:number|null, totalWords:number, editedPct:number|null}}
   *   editedPct === null means "not measured" (text too long), NOT 0 and NOT
   *   100. Analysis must skip such records rather than treat them as zeros.
   */
  function editStats(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);
    const countWords = (t) => t.filter((x) => x.trim() !== '').length;
    const totalWords = Math.max(countWords(a), countWords(b));

    if (a.length > STATS_TOKEN_LIMIT || b.length > STATS_TOKEN_LIMIT) {
      return { editedWords: null, totalWords, editedPct: null };
    }
    if (totalWords === 0) return { editedWords: 0, totalWords: 0, editedPct: 0 };

    let unchanged = 0;
    for (const part of diffWords(oldText, newText)) {
      if (part.type === 'same') unchanged += countWords(tokenize(part.text));
    }

    const editedWords = totalWords - unchanged;
    return {
      editedWords,
      totalWords,
      editedPct: Math.round((editedWords / totalWords) * 100),
    };
  }

  // ==========================================================================
  // Correction diff (dictation highlights)
  // ==========================================================================
  //
  // Why this is separate: the dictation post-processor adds a capital letter
  // and punctuation to almost EVERY word. A word-level diffWords then marks
  // the WHOLE word, and it looks as though every single word was corrected —
  // the highlights become meaningless.
  //
  // Here: (1) pure case / surrounding-punctuation changes are treated as
  // INSIGNIFICANT and not highlighted; (2) real changes (inflections, words,
  // numbers) are highlighted at CHARACTER precision.

  /**
   * A word without surrounding punctuation and without case. Internal
   * punctuation (36.9; L4-L5) is PRESERVED.
   */
  function normalizeWord(w) {
    return String(w ?? '')
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N}]+$/u, '');
  }

  /** Character-level diff for two short words (LCS over characters). */
  function charDiff(oldW, newW) {
    const a = Array.from(oldW);
    const b = Array.from(newW);
    if (!a.length) return b.length ? [{ type: 'add', text: newW }] : [];
    if (!b.length) return [{ type: 'del', text: oldW }];
    if (a.length > 200 || b.length > 200) {
      return [{ type: 'del', text: oldW }, { type: 'add', text: newW }];
    }

    const m = a.length;
    const n = b.length;
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] =
          a[i] === b[j]
            ? dp[(i + 1) * width + (j + 1)] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }

    const out = [];
    const push = (type, text) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) push('same', a[i++]), j++;
      else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) push('del', a[i++]);
      else push('add', b[j++]);
    }
    while (i < m) push('del', a[i++]);
    while (j < n) push('add', b[j++]);
    return out;
  }

  /** Merges an adjacent [del one-word][add one-word] pair into a char diff. */
  function refineSubstitutions(parts) {
    const out = [];
    const push = (p) => {
      const last = out[out.length - 1];
      if (last && last.type === p.type) last.text += p.text;
      else out.push({ type: p.type, text: p.text });
    };
    for (let k = 0; k < parts.length; k++) {
      const cur = parts[k];
      const nxt = parts[k + 1];
      if (cur.type === 'del' && nxt && nxt.type === 'add' && !/\s/.test(cur.text) && !/\s/.test(nxt.text)) {
        charDiff(cur.text, nxt.text).forEach(push);
        k++; // the 'add' has been consumed too
      } else {
        push(cur);
      }
    }
    return out;
  }

  /**
   * Diff for dictation highlights: raw transcript -> model-corrected text.
   * Insignificant (case / surrounding punctuation) changes are NOT shown.
   * @returns {Array<{type:'same'|'add'|'del', text:string}>}
   */
  function correctionDiff(rawText, correctedText) {
    const a = tokenize(rawText);
    const b = tokenize(correctedText);
    if (!a.length) return b.length ? [{ type: 'add', text: correctedText }] : [];
    if (!b.length) return [{ type: 'del', text: rawText }];
    if (a.length > TOKEN_LIMIT || b.length > TOKEN_LIMIT) {
      return [{ type: 'del', text: rawText }, { type: 'add', text: correctedText }];
    }

    const eq = (x, y) => x === y || normalizeWord(x) === normalizeWord(y);
    const m = a.length;
    const n = b.length;
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] = eq(a[i], b[j])
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }

    const words = [];
    const push = (type, text) => {
      const last = words[words.length - 1];
      if (last && last.type === type) last.text += text;
      else words.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (eq(a[i], b[j])) push('same', b[j++]), i++; // show the CORRECTED form, unhighlighted
      else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) push('del', a[i++]);
      else push('add', b[j++]);
    }
    while (i < m) push('del', a[i++]);
    while (j < n) push('add', b[j++]);

    return refineSubstitutions(words);
  }

  /** How many distinct corrected spots (an adjacent del+add counts as one). */
  function countChangeGroups(parts) {
    let groups = 0;
    let inRun = false;
    for (const p of parts) {
      const change = p.type !== 'same' && p.text.trim() !== '';
      if (change && !inRun) {
        groups++;
        inRun = true;
      } else if (!change) {
        inRun = false;
      }
    }
    return groups;
  }

  globalThis.SCRIBE_DIFF = Object.freeze({
    diffWords,
    hasChanges,
    tokenize,
    editStats,
    STATS_TOKEN_LIMIT,
    correctionDiff,
    countChangeGroups,
  });
})();
