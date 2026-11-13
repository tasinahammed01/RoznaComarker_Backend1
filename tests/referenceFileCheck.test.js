'use strict';
// Upload validation for reference files: real signatures, spoofed extensions, size, macros, passwords, corrupt files and zip bombs.
const { checkReferenceFile, signatureOf } = require('../src/services/referenceFiles/fileCheck');
const { safeDisplayName, referenceFilesEnabled, MESSAGES, LIMITS } = require('../src/services/referenceFiles/policy');
const f = require('./helpers/referenceFileFixtures');

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, e => e);
  expect(error).not.toBeNull();
  expect({ code: error.code, message: error.message }).toEqual({ code, message: MESSAGES[code] });
};

describe('accepted files', () => {
  test('a real PDF, DOCX, DOC and PPTX are accepted, typed by their bytes', async () => {
    await expect(checkReferenceFile(await f.pdf(['Course outline']), 'outline.pdf')).resolves.toEqual({ kind: 'pdf', extension: '.pdf' });
    await expect(checkReferenceFile(await f.docx(['Unit plan']), 'Plan.DOCX')).resolves.toEqual({ kind: 'docx', extension: '.docx' });
    await expect(checkReferenceFile(f.doc('Unit plan\r'), 'plan.doc')).resolves.toEqual({ kind: 'doc', extension: '.doc' });
    await expect(checkReferenceFile(await f.pptx({ 1: ['Slide one'] }), 'deck.pptx')).resolves.toEqual({ kind: 'pptx', extension: '.pptx' });
  });
  test('signatures', async () => {
    expect(signatureOf(await f.pdf(['x']))).toBe('pdf');
    expect(signatureOf(await f.docx(['x']))).toBe('zip');
    expect(signatureOf(f.doc('x'))).toBe('ole');
    expect(signatureOf(Buffer.from('MZ\x90\x00'))).toBe('unknown');
  });
});

describe('rejected files', () => {
  test('empty and oversized', async () => {
    await rejects(checkReferenceFile(Buffer.alloc(0), 'a.pdf'), 'REFERENCE_FILE_EMPTY');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(LIMITS.maxFileBytes)]);
    await rejects(checkReferenceFile(big, 'big.pdf'), 'REFERENCE_FILE_TOO_LARGE');
  });
  test('unsupported types, and old PowerPoint asks for .pptx', async () => {
    await rejects(checkReferenceFile(Buffer.from('hello'), 'notes.txt'), 'REFERENCE_FILE_TYPE');
    await rejects(checkReferenceFile(Buffer.from('hello'), 'noextension'), 'REFERENCE_FILE_TYPE');
    await rejects(checkReferenceFile(f.ole({ 'PowerPoint Document': Buffer.alloc(64) }), 'deck.ppt'), 'REFERENCE_FILE_OLD_POWERPOINT');
    expect(MESSAGES.REFERENCE_FILE_OLD_POWERPOINT).toContain('Please save as .pptx');
    // An old PowerPoint renamed to .doc is still recognised by its content.
    await rejects(checkReferenceFile(f.ole({ 'PowerPoint Document': Buffer.alloc(64) }), 'deck.doc'), 'REFERENCE_FILE_OLD_POWERPOINT');
  });
  test('spoofed extensions: the bytes must match the extension', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await rejects(checkReferenceFile(png, 'image.pdf'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'program.docx'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.pdf(['x']), 'fake.docx'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.docx(['x']), 'fake.pdf'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.docx(['x']), 'fake.pptx'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.pptx({ 1: ['x'] }), 'fake.docx'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.docx(['x']), 'fake.doc'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(f.ole({ Workbook: Buffer.alloc(64) }), 'sheet.doc'), 'REFERENCE_FILE_MISMATCH');
    await rejects(checkReferenceFile(await f.zipOf({ 'a.txt': 'x' }), 'plain.docx'), 'REFERENCE_FILE_MISMATCH');
  });
  test('macro-enabled files, by extension, content type or VBA part', async () => {
    await rejects(checkReferenceFile(await f.docx(['x']), 'plan.docm'), 'REFERENCE_FILE_MACRO');
    await rejects(checkReferenceFile(await f.pptx({ 1: ['x'] }), 'deck.pptm'), 'REFERENCE_FILE_MACRO');
    const macroType = f.CONTENT_TYPES.docx.replace('document.main+xml', 'document.macroEnabled.main+xml');
    await rejects(checkReferenceFile(await f.docx(['x'], { contentTypes: macroType }), 'plan.docx'), 'REFERENCE_FILE_MACRO');
    await rejects(checkReferenceFile(await f.docx(['x'], { extra: { 'word/vbaProject.bin': 'vba' } }), 'plan.docx'), 'REFERENCE_FILE_MACRO');
    await rejects(checkReferenceFile(await f.pptx({ 1: ['x'] }, { extra: { 'ppt/vbaProject.bin': 'vba' } }), 'deck.pptx'), 'REFERENCE_FILE_MACRO');
    await rejects(checkReferenceFile(f.doc('x', { extra: { 'Macros/VBA/dir': Buffer.alloc(16) } }), 'plan.doc'), 'REFERENCE_FILE_MACRO');
  });
  test('password-protected DOCX/PPTX (encrypted package) and DOC (FIB flag)', async () => {
    const encrypted = f.ole({ EncryptionInfo: Buffer.alloc(64), EncryptedPackage: Buffer.alloc(64) });
    await rejects(checkReferenceFile(encrypted, 'locked.docx'), 'REFERENCE_FILE_PASSWORD');
    await rejects(checkReferenceFile(encrypted, 'locked.pptx'), 'REFERENCE_FILE_PASSWORD');
    await rejects(checkReferenceFile(f.doc('secret', { flags: 0x0200 | 0x0100 }), 'locked.doc'), 'REFERENCE_FILE_PASSWORD');
  });
  test('corrupt files', async () => {
    const zip = await f.docx(['x']);
    await rejects(checkReferenceFile(zip.subarray(0, zip.length - 40), 'cut.docx'), 'REFERENCE_FILE_CORRUPT');
    await rejects(checkReferenceFile(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(100)]), 'broken.doc'), 'REFERENCE_FILE_CORRUPT');
    const badWord = f.ole({ WordDocument: Buffer.alloc(0x400), '1Table': Buffer.alloc(16) });
    await rejects(checkReferenceFile(badWord, 'nomagic.doc'), 'REFERENCE_FILE_CORRUPT');
  });
});

describe('zip bombs', () => {
  test('too many parts', async () => {
    const extra = Object.fromEntries(Array.from({ length: LIMITS.zipMaxEntries }, (_, i) => [`word/media/p${i}.xml`, 'x']));
    await rejects(checkReferenceFile(await f.docx(['x'], { extra }), 'many.docx'), 'REFERENCE_FILE_ARCHIVE_LIMIT');
  });
  test('a part that unpacks more than 100 times its packed size', async () => {
    const bomb = await f.docx(['x'], { extra: { 'word/media/zeros.bin': Buffer.alloc(3 * 1024 * 1024) } });
    expect(bomb.length).toBeLessThan(64 * 1024);
    await rejects(checkReferenceFile(bomb, 'bomb.docx'), 'REFERENCE_FILE_ARCHIVE_LIMIT');
  });
  test('a declared unpacked size over 100 MB is refused before anything is unpacked', async () => {
    const zip = await f.docx(['x'], { extra: { 'word/media/big.bin': Buffer.from('small') } });
    const lying = f.patchCentral(zip, 'word/media/big.bin', { uncompressedSize: 150 * 1024 * 1024, compressedSize: 150 * 1024 * 1024 });
    await rejects(checkReferenceFile(lying, 'huge.docx'), 'REFERENCE_FILE_ARCHIVE_LIMIT');
  });
  test('a large ordinary document (over 1 MB unpacked, normal compression) is not a bomb', async () => {
    let seed = 7; const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const words = ['essay', 'thesis', 'evidence', 'paragraph', 'argument', 'source', 'claim', 'reader', 'context', 'analysis', 'unit', 'week'];
    const text = Array.from({ length: 6000 }, () => Array.from({ length: 30 }, () => words[next() % words.length] + (next() % 97)).join(' '));
    const file = await f.docx(text);
    const { inspectZip } = require('../src/services/referenceFiles/zipArchive');
    const { zip, entries } = await inspectZip(file); zip.close();
    const body = entries.find(e => e.name === 'word/document.xml');
    expect(body.uncompressedSize).toBeGreaterThan(LIMITS.zipRatioMinBytes);
    expect(body.uncompressedSize / body.compressedSize).toBeLessThan(LIMITS.zipMaxRatio);
    await expect(checkReferenceFile(file, 'long.docx')).resolves.toEqual({ kind: 'docx', extension: '.docx' });
  });
});

describe('names and the feature switch', () => {
  test('display names: last path segment, no control/invisible characters, capped, extension kept', () => {
    expect(safeDisplayName('..\\..\\secret\\Plan.docx')).toBe('Plan.docx');
    expect(safeDisplayName('/etc/passwd/../unit.pdf')).toBe('unit.pdf');
    expect(safeDisplayName('Re\u202eport\u200b\u0007 one.pdf')).toBe('Report one.pdf');
    expect(safeDisplayName('...pdf', 'pdf')).toBe('Reference file.pdf');
    const long = safeDisplayName(`${'a'.repeat(300)}.pptx`);
    expect(long.length).toBe(120); expect(long.endsWith('.pptx')).toBe(true);
  });
  test('REFERENCE_FILES_ENABLED is off unless exactly true', () => {
    expect(referenceFilesEnabled({})).toBe(false);
    expect(referenceFilesEnabled({ REFERENCE_FILES_ENABLED: 'false' })).toBe(false);
    expect(referenceFilesEnabled({ REFERENCE_FILES_ENABLED: '1' })).toBe(false);
    expect(referenceFilesEnabled({ REFERENCE_FILES_ENABLED: 'true' })).toBe(true);
    expect(referenceFilesEnabled({ REFERENCE_FILES_ENABLED: ' TRUE ' })).toBe(true);
  });
});
