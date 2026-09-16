"use strict";

// PDF handling via a locally-bundled pdf.js (vendor/pdfjs). Chrome's built-in
// PDF viewer can't be script-injected, so for "whole document" / page text on a
// PDF we fetch the file itself and parse it. pdf.js is loaded lazily on first
// use so it never costs anything on non-PDF pages.
//
// Split into load / extract / render because a scanned PDF needs both paths on
// the SAME parsed document: first the (empty) text layer to notice it is a
// scan, then its pages as images for the vision model. Re-fetching for that
// would download the file twice.

let _pdfjs = null;

async function getPdfjs() {
  if (!_pdfjs) {
    const lib = await import("./vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
    _pdfjs = lib;
  }
  return _pdfjs;
}

/**
 * Open a PDF from a URL or from bytes already in hand (a picked file).
 * Returns null for non-PDFs or on any failure, so callers can fall back.
 * The <all_urls> host permission bypasses CORS on the fetch.
 *
 * @param {string|ArrayBuffer} source
 * @returns {Promise<object|null>} pdf.js document — caller must `destroy()` it
 */
export async function loadPdf(source) {
  let buf = source;

  if (typeof source === "string") {
    const url = source;
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return null;

    let res;
    try {
      res = await fetch(url);
    } catch (_) {
      return null;
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const looksPdf = ct.includes("application/pdf") || /\.pdf(\?|#|$)/i.test(url);
    if (!looksPdf) return null;

    try {
      buf = await res.arrayBuffer();
    } catch (_) {
      return null;
    }
  }

  try {
    const pdfjs = await getPdfjs();
    return await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  } catch (_) {
    return null;
  }
}

/**
 * The PDF's text layer. A scanned document has none — that is exactly how
 * lib/ocr.js `isScanned` tells the two apart.
 * @returns {{text: string, chars: number, pages: number}}
 */
export async function extractText(pdf, { maxChars = 100000, maxPages = 50 } = {}) {
  const pages = Math.min(pdf.numPages, maxPages);

  let text = "";
  for (let i = 1; i <= pages && text.length < maxChars; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items) {
      if (typeof item.str === "string") line += item.str;
      if (item.hasEOL) {
        text += line + "\n";
        line = "";
      } else {
        line += " ";
      }
    }
    if (line.trim()) text += line + "\n";
    text += "\n"; // page break
  }

  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text.slice(0, maxChars), chars: text.length, pages: pdf.numPages };
}

/**
 * One page as a JPEG data URL, for the vision model.
 *
 * `maxPx` caps the long edge: an A4 at 1600 px is ~150 dpi, which is legible
 * for the model without turning every page into a wall of tokens.
 *
 * @returns {Promise<string>} data:image/jpeg;base64,…
 */
export async function renderPage(pdf, pageNumber, { maxPx = 1600, quality = 0.85 } = {}) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, maxPx / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  // Scans are photos of white paper; without this, transparent areas render
  // black and the model reads a dark smear.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    page.cleanup();
  }
}

/**
 * Fetch a URL and, if it's a PDF, return its text. Kept as the one-call path
 * used by the existing context flows.
 */
export async function grabPdfText(url, { maxChars = 100000, maxPages = 50 } = {}) {
  const pdf = await loadPdf(url);
  if (!pdf) return null;
  try {
    return await extractText(pdf, { maxChars, maxPages });
  } finally {
    pdf.destroy?.();
  }
}
