/**
 * office.js — .docx / .xlsx / .pptx -> text.
 *
 * OOXML is a ZIP with XML inside (see lib/zip.js), so no library is needed.
 * The goal is not to reproduce the document's appearance — it is to hand the
 * model the CONTENT: paragraphs, table rows, slide text.
 *
 * Parsed with regular expressions rather than DOMParser: there is no
 * DOMParser in a service worker, and all that is needed here is the text
 * between tags.
 */

import { readZip, entryText } from './zip.js';

/**
 * The character budget for a whole document.
 *
 * This used to be 200 rows per sheet — and that silently dropped rows in
 * longer files (the user saw 3 of their entries, the model answered about 2).
 * A CHARACTER limit is fairer: a narrow 2000-row table fits, and a wide one is
 * cut only when it genuinely no longer fits in the context — and we say so out
 * loud rather than in a small footnote.
 */
export const MAX_DOC_CHARS = 60000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML entities -> characters. Non-ASCII letters often arrive as &#268;. */
export function decodeXml(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

/** Strips every tag and decodes entities. */
function stripTags(xml) {
  return decodeXml(String(xml ?? '').replace(/<[^>]*>/g, ''));
}

const tidy = (text) =>
  text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/** @returns {{text: string, note: string}} */
export function docxText(zip, { maxChars = MAX_DOC_CHARS } = {}) {
  const xml = entryText(zip, 'word/document.xml');
  if (!xml) return { text: '', note: '' };

  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = paragraphs.map((p) =>
    stripTags(
      p
        .replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:br\b[^>]*\/>/g, '\n')
        // No space is inserted between <w:t> chunks: Word splits a single word
        // across several runs ("pati" + "ent"), and the spaces inside it are
        // separate <w:t> elements of their own.
        .replace(/<\/w:p>/g, '')
    )
  );

  const text = tidy(lines.join('\n'));
  const cut = text.length > maxChars;
  return {
    text: cut ? `${text.slice(0, maxChars)}\n… the end of the document is not shown (too long)` : text,
    note: `${lines.length.toLocaleString()} para.${cut ? ' · part NOT SHOWN' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

/** `xl/sharedStrings.xml` -> an array; cells with t="s" hold an index into it. */
function sharedStrings(zip) {
  const xml = entryText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return (xml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    // One <si> can contain several <t> elements (differently styled chunks) —
    // they are glued without a space, because it is the text of one cell.
    (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => stripTags(t)).join('')
  );
}

/** Sheet name -> file: workbook.xml gives the r:id, rels gives the path. */
function sheetFiles(zip) {
  const workbook = entryText(zip, 'xl/workbook.xml');
  const rels = entryText(zip, 'xl/_rels/workbook.xml.rels');

  const byId = new Map();
  for (const rel of rels.match(/<Relationship\b[^>]*\/?>/g) || []) {
    const id = /Id="([^"]+)"/.exec(rel)?.[1];
    const target = /Target="([^"]+)"/.exec(rel)?.[1];
    if (id && target) byId.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const out = [];
  for (const sheet of workbook.match(/<sheet\b[^>]*\/?>/g) || []) {
    const name = decodeXml(/name="([^"]*)"/.exec(sheet)?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(sheet)?.[1];
    const target = rid && byId.get(rid);
    out.push({ name, path: target ? `xl/${target}` : '' });
  }

  // Malformed rels — fall back to what is actually in the archive.
  if (!out.some((s) => s.path && zip.has(s.path))) {
    const found = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    return found.map((path, i) => ({ name: out[i]?.name || `Sheet${i + 1}`, path }));
  }
  return out.filter((s) => s.path && zip.has(s.path));
}

/**
 * An Excel serial number -> a date.
 *
 * There are NO dates in the file — there is the number 45678 and a style
 * telling the app to display it as a date. Without conversion the model would
 * receive "45678" and answer about it with a straight face; that is more
 * dangerous than a dropped row, because it looks plausible.
 *
 * 25569 = the serial for 1970-01-01 (the historic 1900 leap-year bug is
 * already accounted for).
 */
export function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  if (!Number.isFinite(ms)) return '';
  const iso = new Date(ms).toISOString();
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** The built-in date format numbers (ECMA-376). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/**
 * Style index (`<c s="N">`) -> whether it is a date.
 * @returns {boolean[]}
 */
function dateStyles(zip) {
  const xml = entryText(zip, 'xl/styles.xml');
  if (!xml) return [];

  const custom = new Set();
  for (const fmt of xml.match(/<numFmt\b[^>]*\/?>/g) || []) {
    const id = Number(/numFmtId="(\d+)"/.exec(fmt)?.[1]);
    const code = decodeXml(/formatCode="([^"]*)"/.exec(fmt)?.[1] ?? '');
    // Quoted text and escaped characters are not format tokens — otherwise
    // `0.00 "mln"` would turn into a date because of the letter "m".
    const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '');
    if (/[dmy]/i.test(bare) && /[dmyhs]/i.test(bare)) custom.add(id);
  }

  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  return (xfs.match(/<xf\b[^>]*\/?>/g) || []).map((xf) => {
    const id = Number(/numFmtId="(\d+)"/.exec(xf)?.[1] ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || custom.has(id);
  });
}

/** "B12" -> 1 (zero-based column index). */
export function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref ?? '').toUpperCase())?.[1];
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** @returns {Array<{n: number, line: string}>} the row number plus its cells */
function sheetRows(xml, strings, isDateStyle = []) {
  const rows = [];
  for (const row of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || []) {
    // Excel omits empty rows entirely, so the numbering has gaps — take the
    // REAL `r`, so the model can say "row 12" and the user can find it in the
    // file.
    const n = Number(/<row\b[^>]*\br="(\d+)"/.exec(row)?.[1] ?? rows.length + 1);
    const cells = [];
    for (const cell of row.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = /r="([A-Z]+\d+)"/.exec(cell)?.[1];
      const type = /t="([^"]+)"/.exec(cell)?.[1];
      let value = '';

      if (type === 's') {
        const idx = Number(stripTags(/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? ''));
        value = strings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = (cell.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => stripTags(t)).join('');
      } else {
        value = stripTags(/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? '');
        const style = Number(/\bs="(\d+)"/.exec(cell)?.[1] ?? -1);
        if (isDateStyle[style] && value !== '' && Number.isFinite(Number(value))) {
          value = excelDate(Number(value));
        }
      }

      const at = ref ? columnIndex(ref) : cells.length;
      cells[at] = value;
    }
    // Empty rows are skipped, otherwise a sparse table turns into noise.
    if (cells.some((c) => String(c ?? '').trim())) {
      rows.push({ n, line: Array.from(cells, (c) => c ?? '').join('\t') });
    }
  }
  return rows;
}

/**
 * @returns {{text: string, note: string}} note — how many sheets and rows
 *   actually made it in; that is what reveals whether the document was cut
 */
export function xlsxText(zip, { maxChars = MAX_DOC_CHARS } = {}) {
  const strings = sharedStrings(zip);
  const isDateStyle = dateStyles(zip);
  const blocks = [];

  let sheets = 0;
  let taken = 0;
  let dropped = 0;
  let used = 0;

  for (const sheet of sheetFiles(zip)) {
    const xml = entryText(zip, sheet.path);
    const rows = sheetRows(xml, strings, isDateStyle);
    if (!rows.length) continue;

    sheets++;
    // On a filtered sheet the user sees only some rows — the model gets
    // EVERYTHING, but we say that the on-screen view may differ.
    const filtered = /<autoFilter\b/.test(xml);
    const lines = [];

    for (const row of rows) {
      const line = `${row.n}\t${row.line}`;
      if (used + line.length > maxChars) {
        dropped += rows.length - lines.length;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }

    taken += lines.length;
    if (!lines.length) continue;

    const cut = rows.length - lines.length;
    const head =
      `## ${sheet.name} — ${rows.length} rows` +
      (filtered ? ', a filter is active on this sheet (not all rows are visible on screen)' : '') +
      '; the first column is the row number' +
      (cut > 0 ? `. NOTE: only the first ${lines.length} rows fit, ${cut} not shown` : '');

    blocks.push(`${head}\n${lines.join('\n')}`);
    if (used >= maxChars) break;
  }

  const note =
    `${sheets} sheets · ${taken.toLocaleString()} rows` +
    (dropped ? ` · ${dropped.toLocaleString()} NOT SHOWN (too large)` : '');

  return { text: tidy(blocks.join('\n\n')), note };
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

/** @returns {{text: string, note: string}} */
export function pptxText(zip, { maxChars = MAX_DOC_CHARS } = {}) {
  const slides = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));

  const blocks = [];
  let used = 0;
  let shown = 0;

  for (const [i, path] of slides.entries()) {
    const xml = entryText(zip, path);
    const runs = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => stripTags(t));
    if (!runs.length) continue;

    const block = `## Slide ${i + 1}\n${runs.join('\n')}`;
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length + 2;
    shown++;
  }

  const dropped = slides.length - shown;
  return {
    text: tidy(blocks.join('\n\n')),
    note: `${shown} slides${dropped > 0 ? ` · ${dropped} NOT SHOWN` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Is this an OOXML file we know how to read? */
export function officeKind(name = '', type = '') {
  const n = String(name).toLowerCase();
  const t = String(type).toLowerCase();
  if (n.endsWith('.docx') || t.includes('wordprocessingml')) return 'docx';
  if (n.endsWith('.xlsx') || t.includes('spreadsheetml')) return 'xlsx';
  if (n.endsWith('.pptx') || t.includes('presentationml')) return 'pptx';
  return null;
}

/**
 * @returns {Promise<{text: string, kind: 'docx'|'xlsx'|'pptx', note: string}>}
 *   `note` is shown to the user: it reveals how many sheets/rows/slides made
 *   it in, so a silent truncation cannot go unnoticed.
 * @throws if the format is unsupported or the file is corrupted
 */
export async function officeText(buffer, { name = '', type = '', maxChars } = {}) {
  const kind = officeKind(name, type);
  if (!kind) throw new Error('Unsupported document format.');

  const zip = await readZip(buffer);
  const opts = maxChars ? { maxChars } : {};
  const { text, note } =
    kind === 'docx' ? docxText(zip, opts) : kind === 'xlsx' ? xlsxText(zip, opts) : pptxText(zip, opts);

  return { text, kind, note };
}
