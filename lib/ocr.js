/**
 * ocr.js — reading scanned documents through a vision model.
 *
 * A scanned PDF has no text layer, so pdftext.js gets nothing out of it. Here
 * the pages (already rendered to images, see renderPage in pdftext.js) are
 * sent to the model one at a time with a request to transcribe them VERBATIM.
 *
 * Why page by page rather than all at once: 20 pages in one request is tens of
 * thousands of tokens and one long all-or-nothing operation. Separate requests
 * make it possible to show progress, to cancel halfway WITHOUT LOSING the
 * pages already transcribed, and they keep the model's context clear.
 *
 * PHI: the transcribed text only passes through here — it is returned to the
 * caller and stored nowhere.
 */

import { buildRequest, runChat } from '../llm.js';

/** Marker for an unreadable spot. Never a guess. */
export const UNREADABLE = '[unreadable]';

/**
 * The page transcription instruction.
 *
 * Strict in the same sense as the form-draft templates: the model guesses
 * nothing and completes nothing. In a clinical document an invented number is
 * more dangerous than a missing one — so unreadable spots are marked, not
 * filled in.
 */
export const OCR_PROMPT = [
  'This is one page of a scanned document. Transcribe it VERBATIM.',
  '- Output only the transcription. No preamble, no commentary, no markdown.',
  '- Keep the original language. Do NOT translate.',
  '- Keep the line and paragraph structure; keep table rows as lines.',
  '- Do NOT summarize, do NOT correct, do NOT complete anything.',
  '- Copy numbers, dates, units and codes EXACTLY as printed. Never guess a digit.',
  `- Mark anything you cannot read as ${UNREADABLE} instead of guessing.`,
  '- If the page has no text at all, output nothing.',
].join('\n');

/**
 * Is this a scanned document? Text-layer density per page.
 *
 * The threshold is deliberately low: scanned documents often carry a few dozen
 * characters (headers, stamp text, a PDF generator marker), whereas a genuine
 * digital document has at least a few hundred characters per page.
 */
export function isScanned({ chars = 0, pages = 0 } = {}) {
  if (!pages) return false;
  return chars / pages < 100;
}

/** Page texts -> one document, marked where each page ends. */
export function joinPages(pages) {
  return pages
    .map(({ page, text }) => `--- page ${page} ---\n${String(text ?? '').trim()}`)
    .filter((block) => !/^--- page \d+ ---\s*$/.test(block)) // empty pages drop out
    .join('\n\n')
    .trim();
}

/**
 * A single page request. Separate so tests can inspect it.
 *
 * @param {string} image — a data: URL for the rendered page
 * @param {{endpoint: string, model: string, apikey?: string}} llm — the
 *   configured model server. Passed in rather than read from settings here,
 *   because the endpoint is user-configurable and this module must not go
 *   stale after a settings change mid-document.
 */
export function buildOcrRequest(image, llm) {
  return buildRequest({
    format: 'openai',
    base: llm?.endpoint ?? '',
    model: llm?.model ?? '',
    apikey: llm?.apikey ?? '',
    // No system prompt: the default one is a "screen assistant" and it pins
    // the answer's language — which would corrupt the original while
    // transcribing.
    system: '',
    messages: [{ role: 'user', text: OCR_PROMPT, image }],
    stream: false,
  });
}

/**
 * Transcribes the pages in order.
 *
 * @param {object} opts
 * @param {(index: number) => Promise<string>} opts.getImage — the image for a
 *   (0-based) page; a function rather than an array so that not every page is
 *   rendered into memory up front (50 pages × ~300 KB).
 * @param {number} opts.count — how many pages to process
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.concurrency=2] — parallel requests; 2 roughly halves
 *   the wait without swamping a shared model server
 * @param {{endpoint: string, model: string, apikey?: string}} [opts.llm] — the
 *   configured model server
 * @param {(req: object, opts: object) => Promise<string>} [opts.run] — for tests
 * @returns {Promise<{text: string, pages: number, aborted: boolean}>}
 */
export async function ocrPages({
  getImage,
  count,
  onProgress,
  signal,
  concurrency = 2,
  llm,
  run = runChat,
}) {
  const results = new Array(count);
  let next = 0;
  let done = 0;
  let aborted = false;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= count || aborted) return;

      if (signal?.aborted) {
        aborted = true;
        return;
      }

      try {
        const image = await getImage(i);
        const text = await run(buildOcrRequest(image, llm), { signal });
        results[i] = { page: i + 1, text };
      } catch (err) {
        if (err?.name === 'AbortError') {
          aborted = true;
          return;
        }
        // One unreadable page does not abort the document — mark it and move on.
        results[i] = { page: i + 1, text: '[page could not be read]' };
      }

      done++;
      onProgress?.(done, count);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));

  // After a cancellation, what was already transcribed remains — the user's
  // wait is not wasted.
  const got = results.filter(Boolean);
  return { text: joinPages(got), pages: got.length, aborted };
}
