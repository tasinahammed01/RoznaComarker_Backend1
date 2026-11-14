'use strict';
// Reference files: the model, the index migration and asynchronous extraction (processing -> ready / failed, lease, retries, removed files).
// In-memory MongoDB and synthetic files only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const ReferenceFile = require('../src/models/ReferenceFile');
const File = require('../src/models/File');
const logger = require('../src/utils/logger');
const { processReferenceFile, resumeReferenceFiles, readStoredFile } = require('../src/services/referenceFiles/processing');
const { ReferenceFileError, LIMITS, MESSAGES } = require('../src/services/referenceFiles/policy');
const { ensureReferenceFileIndexes, REFERENCE_FILE_INDEX_NAMES } = require('../scripts/migrateReferenceFileIndexes');
const f = require('./helpers/referenceFileFixtures');

const SECRET_TEXT = 'Unit outline: persuasive essays about local transport, with evidence from two sources.';
const SECRET_NAME = 'Private plan for 9B.docx';
let uploadRoot, previousBase;
const teacher = new mongoose.Types.ObjectId(), klass = new mongoose.Types.ObjectId();

beforeAll(async () => {
  previousBase = process.env.UPLOAD_BASE_PATH;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-files-'));
  process.env.UPLOAD_BASE_PATH = uploadRoot;
  fs.mkdirSync(path.join(uploadRoot, 'references'));
  await connectInMemoryMongo();
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  if (previousBase === undefined) delete process.env.UPLOAD_BASE_PATH; else process.env.UPLOAD_BASE_PATH = previousBase;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});
afterEach(async () => { await clearDatabase(); jest.restoreAllMocks(); });

async function stored(buffer, { kind = 'docx', filename = `${new mongoose.Types.ObjectId()}.${kind}`, type = 'references', ...fields } = {}) {
  fs.writeFileSync(path.join(uploadRoot, 'references', path.basename(filename)), buffer);
  const file = await File.create({ originalName: SECRET_NAME, filename, path: `references/${filename}`, url: 'internal', uploadedBy: teacher,
    role: 'teacher', type, sizeBytes: buffer.length });
  return ReferenceFile.create({ owner: teacher, scope: 'class', class: klass, file: file._id, originalName: SECRET_NAME, kind, sizeBytes: buffer.length,
    requestId: String(new mongoose.Types.ObjectId()), contentHash: 'h'.repeat(64), ...fields });
}
const reload = id => ReferenceFile.findById(id).select('+text +leaseUntil +contentHash').lean();

describe('model and migration', () => {
  test('the index migration creates the named indexes and is idempotent; one stored file per teacher request', async () => {
    await ensureReferenceFileIndexes();
    const indexes = await ensureReferenceFileIndexes();
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining(REFERENCE_FILE_INDEX_NAMES));
    expect(indexes.find(index => index.name === 'reference_file_request_v1')).toEqual(expect.objectContaining({ unique: true }));
    const first = await stored(await f.docx(['x']), { requestId: 'request-1' });
    const { _id, ...copy } = first.toObject();
    await expect(ReferenceFile.create({ ...copy, requestId: 'request-1' })).rejects.toThrow(/duplicate key/u);
    await expect(ReferenceFile.create({ ...copy, owner: new mongoose.Types.ObjectId(), requestId: 'request-1' })).resolves.toBeTruthy(); // per teacher
  });

  test('File accepts the references type; serialized documents never carry text, hash, lease or stored-file id', async () => {
    const reference = await stored(await f.docx(['x']));
    await ReferenceFile.updateOne({ _id: reference._id }, { $set: { text: SECRET_TEXT, leaseUntil: new Date() } });
    const loaded = await ReferenceFile.findById(reference._id).select('+text +contentHash +leaseUntil');
    const json = JSON.stringify(loaded.toJSON());
    for (const hidden of [SECRET_TEXT, 'hhhh', 'leaseUntil', String(reference.file)]) expect(json).not.toContain(hidden);
    expect((await ReferenceFile.findById(reference._id).lean()).text).toBeUndefined();          // not selected by default
  });

  test('the private file route still refuses the references type', async () => {
    const { servePrivateFile } = require('../src/controllers/secureFile.controller');
    const next = jest.fn();
    await servePrivateFile({ params: { type: 'references', filename: 'a.docx' }, user: { _id: teacher, role: 'teacher' } }, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('processing', () => {
  test('a stored DOCX becomes ready with its text cached, through the real worker', async () => {
    const reference = await stored(await f.docx([SECRET_TEXT]));
    const done = await processReferenceFile(reference._id);
    expect(done.status).toBe('ready');
    const saved = await reload(reference._id);
    expect(saved).toEqual(expect.objectContaining({ status: 'ready', text: SECRET_TEXT, textChars: SECRET_TEXT.length, textTruncated: false,
      extractionVersion: 'reference-text-v1', attempts: 1, leaseUntil: null, failureCode: null }));
    expect(await processReferenceFile(reference._id)).toBeNull();                                // never re-extracted
  });

  test('a scanned PDF fails with the clear reason, at once and for good', async () => {
    const reference = await stored(await f.pdf([]), { kind: 'pdf' });
    await processReferenceFile(reference._id);
    expect(await reload(reference._id)).toEqual(expect.objectContaining({ status: 'failed', failureCode: 'REFERENCE_FILE_NO_TEXT_PDF',
      failureMessage: 'No readable text found (scanned PDF).', attempts: 1, leaseUntil: null }));
    expect((await reload(reference._id)).text).toBeUndefined();
  });

  test('a busy or crashed extraction is retried, at most three attempts, then fails', async () => {
    const reference = await stored(await f.docx(['x']));
    const extract = jest.fn().mockRejectedValue(new ReferenceFileError('REFERENCE_FILE_BUSY'));
    await processReferenceFile(reference._id, { extract });
    expect(await reload(reference._id)).toEqual(expect.objectContaining({ status: 'processing', attempts: 1, leaseUntil: null }));
    await processReferenceFile(reference._id, { extract });
    await processReferenceFile(reference._id, { extract });
    expect(await reload(reference._id)).toEqual(expect.objectContaining({ status: 'failed', attempts: LIMITS.maxAttempts,
      failureCode: 'REFERENCE_FILE_BUSY', failureMessage: MESSAGES.REFERENCE_FILE_BUSY }));
    expect(extract).toHaveBeenCalledTimes(3);
    expect(await processReferenceFile(reference._id, { extract })).toBeNull();
  });

  test('two processes at once: only one extracts (lease)', async () => {
    const reference = await stored(await f.docx(['x']));
    let release;
    const extract = jest.fn(() => new Promise(resolve => { release = () => resolve({ text: SECRET_TEXT, chars: SECRET_TEXT.length, truncated: false, units: null }); }));
    const first = processReferenceFile(reference._id, { extract });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await processReferenceFile(reference._id, { extract })).toBeNull();
    release(); await first;
    expect(extract).toHaveBeenCalledTimes(1);
    expect((await reload(reference._id)).status).toBe('ready');
  });

  test('a removed file is not processed, and a file removed during extraction keeps no text', async () => {
    const removed = await stored(await f.docx(['x']), { removedAt: new Date() });
    const extract = jest.fn();
    expect(await processReferenceFile(removed._id, { extract })).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    const reference = await stored(await f.docx(['x']));
    await processReferenceFile(reference._id, { extract: async () => {
      await ReferenceFile.updateOne({ _id: reference._id }, { $set: { removedAt: new Date() } });
      return { text: SECRET_TEXT, chars: 10, truncated: false, units: null };
    } });
    expect((await reload(reference._id)).text).toBeUndefined();
  });

  test('resume picks up waiting files and an expired lease, and fails files that used every attempt', async () => {
    const waiting = await stored(await f.docx([SECRET_TEXT]));
    const crashed = await stored(await f.docx([SECRET_TEXT]), { attempts: 1 });
    await ReferenceFile.updateOne({ _id: crashed._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
    const exhausted = await stored(await f.docx(['x']), { attempts: LIMITS.maxAttempts });
    const leased = await stored(await f.docx(['x']));
    await ReferenceFile.updateOne({ _id: leased._id }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
    const extract = jest.fn(async () => ({ text: SECRET_TEXT, chars: SECRET_TEXT.length, truncated: false, units: null }));
    await resumeReferenceFiles({ extract });
    expect(extract).toHaveBeenCalledTimes(2);
    expect((await reload(waiting._id)).status).toBe('ready');
    expect(await reload(crashed._id)).toEqual(expect.objectContaining({ status: 'ready', attempts: 2 }));
    expect(await reload(exhausted._id)).toEqual(expect.objectContaining({ status: 'failed', failureCode: 'REFERENCE_FILE_EXTRACTION_FAILED' }));
    expect((await reload(leased._id)).status).toBe('processing');
  });

  test('only a references File inside the references folder is read; a stored path cannot point elsewhere', async () => {
    const other = await stored(await f.docx(['x']), { type: 'submissions' });
    await expect(readStoredFile(await reload(other._id))).rejects.toEqual(expect.objectContaining({ code: 'REFERENCE_FILE_EXTRACTION_FAILED' }));
    fs.writeFileSync(path.join(uploadRoot, 'outside.docx'), 'outside');
    const file = await File.create({ originalName: 'x', filename: '../outside.docx', path: '../outside.docx', url: 'internal', uploadedBy: teacher,
      role: 'teacher', type: 'references' });
    await expect(readStoredFile({ file: file._id })).rejects.toEqual(expect.objectContaining({ code: 'REFERENCE_FILE_EXTRACTION_FAILED' }));
  });

  test('logs carry ids, codes and counts only: never the file name or its text', async () => {
    const lines = [];
    jest.spyOn(logger, 'info').mockImplementation(message => lines.push(JSON.stringify(message)));
    jest.spyOn(logger, 'warn').mockImplementation(message => lines.push(JSON.stringify(message)));
    await processReferenceFile((await stored(await f.docx([SECRET_TEXT])))._id);
    await processReferenceFile((await stored(await f.pdf([]), { kind: 'pdf' }))._id);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) { expect(line).not.toContain('persuasive'); expect(line).not.toContain('Private plan'); }
  });
});
