'use strict';
// Upload validation for reference files. The real file signature decides the type: the extension only says what the teacher meant, and the two
// must agree. Rejected: old PowerPoint (.ppt), macro-enabled files, password-protected files, corrupt files and zip bombs.
const CFB = require('cfb');
const { LIMITS, KINDS, ReferenceFileError, extensionOf } = require('./policy');
const { inspectZip, readEntry } = require('./zipArchive');

const OLD_POWERPOINT = new Set(['.ppt', '.pps', '.pot']);
const MACRO_EXTENSIONS = new Set(['.docm', '.dotm', '.pptm', '.potm', '.ppsm', '.ppam']);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const REQUIRED_PART = Object.freeze({ docx: 'word/document.xml', pptx: 'ppt/presentation.xml' });

/** 'pdf', 'zip', 'ole' or 'unknown', from the bytes only. A PDF header may start anywhere in the first 1024 bytes. */
function signatureOf(buffer) {
  if (buffer.subarray(0, 8).equals(OLE_SIGNATURE)) return 'ole';
  if (buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) return 'zip';
  if (buffer.subarray(0, 1024).includes('%PDF-', 0, 'latin1')) return 'pdf';
  return 'unknown';
}

async function checkOoxml(buffer, kind) {
  const { zip, entries } = await inspectZip(buffer);
  try {
    const byName = new Map(entries.map(item => [item.name, item]));
    const types = byName.get('[Content_Types].xml');
    if (!types) throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
    const contentTypes = (await readEntry(zip, types, 1024 * 1024)).toString('utf8');
    if (/macroEnabled/iu.test(contentTypes) || entries.some(item => /(^|\/)vbaProject\.bin$/iu.test(item.name)))
      throw new ReferenceFileError('REFERENCE_FILE_MACRO');
    if (!byName.has(REQUIRED_PART[kind])) throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
    return { zip, entries };
  } catch (error) { zip.close(); throw error; }
}

const oleStream = (container, name) => {
  const found = CFB.find(container, name);
  return found && found.type === 2 ? Buffer.from(found.content || []) : null;
};

function checkOle(buffer, kind) {
  let container;
  try { container = CFB.read(buffer, { type: 'buffer' }); } catch { throw new ReferenceFileError('REFERENCE_FILE_CORRUPT'); }
  const paths = (container.FullPaths || []).map(name => String(name).toLowerCase());
  // A password-protected DOCX/PPTX is an OLE container holding the encrypted package.
  if (oleStream(container, 'EncryptionInfo') || oleStream(container, 'EncryptedPackage')) throw new ReferenceFileError('REFERENCE_FILE_PASSWORD');
  if (oleStream(container, 'PowerPoint Document')) throw new ReferenceFileError('REFERENCE_FILE_OLD_POWERPOINT');
  if (kind !== 'doc') throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
  const word = oleStream(container, 'WordDocument');
  if (!word) throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
  if (paths.some(name => /\/(macros|_vba_project_cur|vba)\/$/u.test(name) || /\/(macros|_vba_project_cur)\//u.test(name)))
    throw new ReferenceFileError('REFERENCE_FILE_MACRO');
  if (word.length < 0x1aa || word.readUInt16LE(0) !== 0xa5ec) throw new ReferenceFileError('REFERENCE_FILE_CORRUPT');
  if (word.readUInt16LE(0x0a) & 0x0100) throw new ReferenceFileError('REFERENCE_FILE_PASSWORD'); // FIB fEncrypted
}

/** Checks the bytes for a kind already decided from the name. For DOCX/PPTX it returns the open, checked archive (caller closes it). */
async function checkContent(buffer, kind) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ReferenceFileError('REFERENCE_FILE_EMPTY');
  if (buffer.length > LIMITS.maxFileBytes) throw new ReferenceFileError('REFERENCE_FILE_TOO_LARGE');
  const signature = signatureOf(buffer);
  if (kind === 'pdf') {
    if (signature !== 'pdf') throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
    return {};
  }
  if (signature === 'ole') { checkOle(buffer, kind); return {}; }
  if (kind === 'doc' || signature !== 'zip') throw new ReferenceFileError('REFERENCE_FILE_MISMATCH');
  return checkOoxml(buffer, kind);
}

/** Validates an upload: { kind, extension }. Throws ReferenceFileError with a teacher-facing message. */
async function checkReferenceFile(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ReferenceFileError('REFERENCE_FILE_EMPTY');
  if (buffer.length > LIMITS.maxFileBytes) throw new ReferenceFileError('REFERENCE_FILE_TOO_LARGE');
  const extension = extensionOf(originalName);
  if (OLD_POWERPOINT.has(extension)) throw new ReferenceFileError('REFERENCE_FILE_OLD_POWERPOINT');
  if (MACRO_EXTENSIONS.has(extension)) throw new ReferenceFileError('REFERENCE_FILE_MACRO');
  const kind = KINDS[extension];
  if (!kind) throw new ReferenceFileError('REFERENCE_FILE_TYPE');
  const checked = await checkContent(buffer, kind);
  checked.zip?.close();
  return { kind, extension };
}

module.exports = { checkReferenceFile, checkContent, signatureOf };
