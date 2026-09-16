/**
 * make-zip.mjs — a ZIP fixture builder for the tests (not a test itself, hence
 * no `.test` in the name).
 *
 * It uses node's `zlib`, so the archives are REAL rather than an imitation of a
 * format we invented — otherwise the lib/zip.js tests would only be checking
 * themselves.
 */
import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * @param {Array<{name: string, data: string|Buffer, store?: boolean}>} entries
 * @returns {Buffer} a ZIP archive
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(Buffer.concat([local, nameBuf, body]));
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}
