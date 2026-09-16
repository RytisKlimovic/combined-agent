"use strict";

import { isClinicalUrl } from "./lib/settings.js";

// Context-aware prompt presets.
// `deriveSignals` reduces a page/context capture to a few booleans;
// `pickPresets` turns those into an ordered button list. Each preset:
// { id, label, prompt, copy?, download? } — copy/download flag output worth
// extracting (tables, OCR, JSON).

const ERROR_RE =
  /\b(error|exception|traceback|stack ?trace|cannot read|is not defined|null ?pointer|segfault|panic:|failed to|unhandled|missing)\b/i;

export function deriveSignals(ctx, extra = {}) {
  if (extra.image) return { image: true };
  // A clinical form — questions about the record itself are more useful than
  // "what is on this screen". This also applies in "whole page" mode:
  // previously that returned early and the clinical presets never appeared on
  // a form.
  const clinicalForm = isClinicalUrl(ctx && ctx.url);
  if (extra.wholeDoc) {
    return { wholeDoc: true, clinicalForm, tableCount: (ctx && ctx.tables) || 0 };
  }
  const hasSelection = !!(ctx && ctx.selection);
  const sample = ((ctx && (ctx.selection || ctx.text)) || "").slice(0, 2000);
  return {
    clinicalForm,
    hasSelection,
    tableCount: (ctx && ctx.tables) || 0,
    codeCount: (ctx && ctx.codeBlocks) || 0,
    isError: ERROR_RE.test(hasSelection ? ctx.selection : sample.slice(0, 600)),
  };
}

/**
 * A stable preset identifier, independent of the label.
 *
 * `label` is UI text — it can be reworded or translated at any time. The
 * metrics (`chat.asked` in lib/metrics.js) need a key that does NOT change and
 * can be validated against a fixed list: free-text strings are not allowed
 * into metrics on principle. So the id travels separately from the label.
 *
 * When adding a preset, its id must be added here too.
 */
export const PRESET_IDS = Object.freeze([
  // image
  "ocr", "describe", "alt-text", "explain-image",
  // clinical form
  "visit-summary", "whats-missing", "what-else-to-ask", "check-wording",
  // whole document
  "doc-summary", "doc-key-points", "doc-tldr", "doc-actions", "doc-translate", "doc-tables-csv",
  // selected text
  "sel-explain-error", "sel-how-to-fix", "sel-explain", "sel-summarize", "sel-translate", "sel-rewrite",
  // screen
  "screen-explain-error", "screen-how-to-fix", "screen-what-is-this", "screen-summarize",
  "screen-next-step", "screen-translate",
  // generic
  "table-csv", "table-markdown", "explain-code", "extract-text",
]);

/**
 * @param {object} signals — from deriveSignals
 * @param {string} [translateInto] — target language for the Translate presets
 */
export function pickPresets(signals = {}, translateInto = "English") {
  const out = [];
  const add = (id, label, prompt, opts) => out.push({ id, label, prompt, ...(opts || {}) });
  const translateLabel = `Translate → ${translateInto}`;

  if (signals.image) {
    add("ocr", "OCR text",
        "Extract all text from this image verbatim. Output only the text, nothing else.",
        { copy: true });
    add("describe", "Describe", "Describe this image concisely.");
    add("alt-text", "Alt text",
        "Write a concise, useful alt-text for this image in one sentence.",
        { copy: true });
    add("explain-image", "Explain", "Explain what this image shows and why it matters.");
    return out;
  }

  // A clinical form: questions about the record itself. Shown first, with the
  // usual presets for that mode after them. A text selection matters more, so
  // these are skipped when there is one.
  if (signals.clinicalForm && !signals.hasSelection) {
    add("visit-summary", "Summarize visit",
        "Summarize this patient record concisely: main complaints, findings, diagnosis and plan.");
    add("whats-missing", "What's missing?",
        "What important information is missing or unclear in this record? Short bullets.",
        { copy: true });
    add("what-else-to-ask", "What else to ask?",
        "Based on this record, what else is worth asking the patient or clarifying during the examination?",
        { copy: true });
    add("check-wording", "Check wording",
        "Review the wording of this record: point out unclear, contradictory or unfinished parts. Do not invent anything.");
  }

  if (signals.wholeDoc) {
    add("doc-summary", "Summarize", "Summarize this document in a few short paragraphs.");
    add("doc-key-points", "Key points",
        "List the key points of this document as concise bullets.",
        { copy: true });
    add("doc-tldr", "TL;DR", "Give a one-sentence TL;DR of this document.");
    add("doc-actions", "Action items",
        "List any deadlines, requirements, or action items in this document as bullets.",
        { copy: true });
    add("doc-translate", translateLabel,
        `Translate this document into ${translateInto}.`,
        { copy: true });
    if (signals.tableCount > 0) {
      add("doc-tables-csv", "Tables → CSV",
          "Extract every table in the document as CSV. Output only CSV.",
          { copy: true, download: "csv" });
    }
    return out;
  }

  if (signals.hasSelection) {
    if (signals.isError) {
      add("sel-explain-error", "Explain error",
          "Explain this error and its most likely cause, briefly.");
      add("sel-how-to-fix", "How to fix", "How do I fix this? Give concrete steps.");
    }
    add("sel-explain", "Explain", "Explain the selected text simply and briefly.");
    add("sel-summarize", "Summarize", "Summarize the selected text in a few bullet points.");
    add("sel-translate", translateLabel,
        `Translate the selected text into ${translateInto}. Output only the translation.`,
        { copy: true });
    add("sel-rewrite", "Rewrite",
        "Rewrite the selected text more clearly and concisely.",
        { copy: true });
  } else {
    if (signals.isError) {
      add("screen-explain-error", "Explain error",
          "Explain the error shown on screen and the most likely cause, briefly.");
      add("screen-how-to-fix", "How to fix",
          "How do I fix what's shown on screen? Give concrete steps.");
    }
    add("screen-what-is-this", "What is this?", "What is shown on this screen? Be brief.");
    add("screen-summarize", "Summarize", "Summarize the main content on this page briefly.");
    add("screen-next-step", "Next step",
        "Based on what's on screen, what should I do or click next?");
    add("screen-translate", translateLabel,
        `Translate the visible text into ${translateInto}.`);
  }

  if (signals.tableCount > 0) {
    add("table-csv", "Table → CSV",
        "Extract the table(s) as CSV. Output only CSV, no commentary.",
        { copy: true, download: "csv" });
    add("table-markdown", "Table → Markdown",
        "Extract the table(s) as a Markdown table. Output only the table.",
        { copy: true });
  }
  if (signals.codeCount > 0 && !signals.isError) {
    add("explain-code", "Explain code",
        "Explain what the code on screen does, concisely.");
  }

  add("extract-text", "Extract text",
      "Extract all readable text from the screenshot verbatim. Output only the text.",
      { copy: true });
  return out;
}
