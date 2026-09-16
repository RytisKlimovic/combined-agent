/**
 * zip.js — a minimal ZIP reader.
 *
 * Aimed at OOXML files (.docx/.xlsx/.pptx), which are ZIP archives with XML
 * inside. No library is needed: the browser's
 * `DecompressionStream('deflate-raw')` handles inflation, and the archive
 * structure is a handful of headers.
 *
 * Only what Word/Excel/PowerPoint and Google exports actually produce is
 * supported: methods 0 (stored) and 8 (deflate), no ZIP64 and no encryption.
 * Anything beyond that gets a clear error rather than half-read garbage.
 */

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

/** Search for the EOCD from the end: up to 64 KB of comment may follow it. */
function findEocd(view) {
  const max = Math.min(view.byteLength, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const at = view.byteLength - i;
    if (view.getUint32(at, true) === EOCD_SIG) return at;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Map<string, Uint8Array>>} file name -> contents
 */
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('This is not a ZIP file.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported.');
  }

  const decoder = new TextDecoder();
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CEN_SIG) throw new Error('Corrupted ZIP structure.');

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localAt = view.getUint32(offset + 42, true);

    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error('Encrypted ZIP archives are not supported.');
    if (name.endsWith('/')) continue; // a directory

    // The data sits after the LOCAL header, whose variable-field lengths can
    // differ from the central directory's — so read that one specifically.
    if (view.getUint32(localAt, true) !== LOC_SIG) throw new Error('Corrupted ZIP structure.');
    const locNameLen = view.getUint16(localAt + 26, true);
    const locExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + locNameLen + locExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);

    if (method === 0) {
      out.set(name, raw);
    } else if (method === 8) {
      out.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`Unsupported ZIP compression method: ${method}.`);
    }
  }

  return out;
}

/** An archive entry's contents as UTF-8 text ('' when there is no such entry). */
export function entryText(zip, name) {
  const bytes = zip.get(name);
  return bytes ? new TextDecoder().decode(bytes) : '';
}
