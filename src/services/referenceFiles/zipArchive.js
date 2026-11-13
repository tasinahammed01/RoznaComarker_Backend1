'use strict';
// Safe reading of DOCX/PPTX (zip) archives, all in memory (files are at most 10 MB). The central directory is read and checked first, before
// anything is unpacked: entry count, total declared unpacked size and compression ratio. A part is then unpacked with a hard output limit equal
// to its declared size (zlib maxOutputLength), so a header that lies about its size fails instead of unpacking more than was checked.
// yauzl reads only the directory: its 2.x read streams drop size-check errors on current Node (the stream goes silent instead of failing), so
// parts are unpacked here. Nothing is ever written to disk, so entry names cannot cause path traversal.
const zlib = require('zlib');
const yauzl = require('yauzl');
const { LIMITS, ReferenceFileError } = require('./policy');

const open = buffer => new Promise((resolve, reject) => {
  yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: false }, (error, zip) => {
    if (error) reject(new ReferenceFileError('REFERENCE_FILE_CORRUPT')); else resolve(zip);
  });
});

/**
 * Reads the central directory after checking the archive limits. Returns { zip, entries }: zip.buffer holds the bytes for readEntry, and
 * zip.close() is kept for callers (nothing stays open).
 */
async function inspectZip(buffer, limits = LIMITS) {
  const directory = await open(buffer);
  if (directory.entryCount > limits.zipMaxEntries) { directory.close(); throw new ReferenceFileError('REFERENCE_FILE_ARCHIVE_LIMIT'); }
  const entries = [];
  try {
    await new Promise((resolve, reject) => {
      let total = 0;
      directory.on('error', () => reject(new ReferenceFileError('REFERENCE_FILE_CORRUPT')));
      directory.on('end', resolve);
      directory.on('entry', entry => {
        const item = { name: entry.fileName, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize,
          method: entry.compressionMethod, localHeaderOffset: entry.relativeOffsetOfLocalHeader, encrypted: (entry.generalPurposeBitFlag & 0x1) !== 0 };
        total += item.uncompressedSize;
        const ratio = item.uncompressedSize / Math.max(1, item.compressedSize);
        if (entries.length >= limits.zipMaxEntries || total > limits.zipMaxUncompressedBytes
          || (item.uncompressedSize > limits.zipRatioMinBytes && ratio > limits.zipMaxRatio)) return reject(new ReferenceFileError('REFERENCE_FILE_ARCHIVE_LIMIT'));
        if (item.encrypted) return reject(new ReferenceFileError('REFERENCE_FILE_PASSWORD'));
        entries.push(item);
        directory.readEntry();
      });
      directory.readEntry();
    });
  } finally { directory.close(); }
  const declared = entries.reduce((sum, item) => sum + item.uncompressedSize, 0);
  if (declared > limits.zipRatioMinBytes && declared / Math.max(1, buffer.length) > limits.zipMaxRatio) throw new ReferenceFileError('REFERENCE_FILE_ARCHIVE_LIMIT');
  return { zip: { buffer, close() {} }, entries };
}

/** Unpacks one checked entry, never more than its declared size (and maxBytes). Stored (0) and deflate (8) only, as Office writes. */
function readEntry(zip, item, maxBytes = LIMITS.zipMaxUncompressedBytes) {
  try {
    if (item.uncompressedSize > maxBytes) throw new ReferenceFileError('REFERENCE_FILE_ARCHIVE_LIMIT');
    const buffer = zip.buffer, at = item.localHeaderOffset;
    if (!Number.isInteger(at) || at < 0 || at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw new ReferenceFileError('REFERENCE_FILE_CORRUPT');
    const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
    if (start + item.compressedSize > buffer.length) throw new ReferenceFileError('REFERENCE_FILE_CORRUPT');
    const data = buffer.subarray(start, start + item.compressedSize);
    let out;
    if (item.method === 0) out = data;
    else if (item.method === 8) {
      try { out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, item.uncompressedSize) }); } catch (error) {
        throw new ReferenceFileError(error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'REFERENCE_FILE_ARCHIVE_LIMIT' : 'REFERENCE_FILE_CORRUPT');
      }
    } else throw new ReferenceFileError('REFERENCE_FILE_CORRUPT');
    if (out.length !== item.uncompressedSize) throw new ReferenceFileError('REFERENCE_FILE_CORRUPT');
    return Promise.resolve(Buffer.from(out));
  } catch (error) { return Promise.reject(error instanceof ReferenceFileError ? error : new ReferenceFileError('REFERENCE_FILE_CORRUPT')); }
}

module.exports = { inspectZip, readEntry };
