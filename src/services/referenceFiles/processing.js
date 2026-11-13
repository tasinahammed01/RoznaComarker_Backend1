'use strict';
// Asynchronous text extraction for stored reference files: processing -> ready, or failed with a teacher-facing reason. A lease stops two
// processes from extracting the same file; a file left in "processing" (crash, restart, busy worker) is picked up again by resumeReferenceFiles,
// at most LIMITS.maxAttempts times. Logs carry ids and codes only, never names or text.
const fs = require('fs/promises');
const path = require('path');
const ReferenceFile = require('../../models/ReferenceFile');
const File = require('../../models/File');
const logger = require('../../utils/logger');
const { LIMITS, EXTRACTION_VERSION, ReferenceFileError } = require('./policy');
const { runExtraction } = require('./extractRunner');
const { detectRubric } = require('./rubricDetect');
const { markingExcerpt } = require('./markingContext');

const referencesRoot = () => path.resolve(__dirname, '../../..', process.env.UPLOAD_BASE_PATH || 'uploads', 'references');

/** The stored bytes of a reference file. Only a File of type 'references' inside the references folder is read. */
async function readStoredFile(reference) {
  const file = await File.findById(reference.file).select('path filename type').lean();
  if (!file || file.type !== 'references') throw new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED');
  const root = referencesRoot();
  const absolute = path.resolve(root, path.basename(String(file.filename || file.path || '')));
  if (path.dirname(absolute) !== root) throw new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED');
  try { return await fs.readFile(absolute); } catch { throw new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED'); }
}

const leaseFree = now => ({ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] });

/** Extracts one file if it is still processing and not leased. Returns the updated document, or null when there was nothing to do. */
async function processReferenceFile(id, { read = readStoredFile, extract = runExtraction, now = () => new Date() } = {}) {
  const start = now();
  const lease = new Date(start.getTime() + LIMITS.leaseMs + LIMITS.extractionTimeoutMs + LIMITS.extractionQueueTimeoutMs);
  const claimed = await ReferenceFile.findOneAndUpdate(
    { _id: id, status: 'processing', removedAt: null, attempts: { $lt: LIMITS.maxAttempts }, ...leaseFree(start) },
    { $set: { leaseUntil: lease }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!claimed) return null;
  const mine = { _id: claimed._id, status: 'processing', leaseUntil: lease };
  try {
    const result = await extract(await read(claimed), claimed.kind);
    // Rubric detection (deterministic) only for assignment files: class files are background context only.
    const detection = claimed.scope === 'assignment' ? { rubricDetection: detectRubric(result.text) } : {};
    const done = await ReferenceFile.findOneAndUpdate({ ...mine, removedAt: null }, { $set: { ...detection, status: 'ready', text: result.text, markingText: markingExcerpt(result.text), textChars: result.chars,
      textTruncated: Boolean(result.truncated), units: Number.isFinite(result.units) ? result.units : null, extractionVersion: EXTRACTION_VERSION,
      extractedAt: now(), failureCode: null, failureMessage: null, leaseUntil: null } }, { new: true });
    logger.info({ message: 'Reference file ready', code: 'REFERENCE_FILE_READY', referenceFileId: String(claimed._id), kind: claimed.kind,
      chars: result.chars, truncated: Boolean(result.truncated) });
    return done;
  } catch (caught) {
    const error = caught instanceof ReferenceFileError ? caught : new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED');
    const retry = error.retryable && claimed.attempts < LIMITS.maxAttempts;
    logger.warn({ message: 'Reference file extraction failed', code: error.code, referenceFileId: String(claimed._id), kind: claimed.kind,
      attempt: claimed.attempts, willRetry: retry, ...(caught instanceof ReferenceFileError ? {} : { errorName: String(caught?.name || 'Error').slice(0, 60) }) });
    const update = retry ? { $set: { leaseUntil: null } }
      : { $set: { status: 'failed', failureCode: error.code, failureMessage: error.safeMessage, leaseUntil: null } };
    return ReferenceFile.findOneAndUpdate(mine, update, { new: true });
  }
}

/**
 * Picks up files still waiting: never started, released for a retry, or whose lease ran out (the process stopped mid-way). A file that used
 * all its attempts without finishing is marked failed so it never stays "processing" for ever.
 */
async function resumeReferenceFiles({ limit = 20, now = () => new Date(), ...options } = {}) {
  const at = now();
  await ReferenceFile.updateMany({ status: 'processing', removedAt: null, attempts: { $gte: LIMITS.maxAttempts }, ...leaseFree(at) },
    { $set: { status: 'failed', failureCode: 'REFERENCE_FILE_EXTRACTION_FAILED',
      failureMessage: new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED').safeMessage, leaseUntil: null } });
  const waiting = await ReferenceFile.find({ status: 'processing', removedAt: null, attempts: { $lt: LIMITS.maxAttempts }, ...leaseFree(at) })
    .select('_id').sort({ createdAt: 1 }).limit(limit).lean();
  const results = [];
  for (const { _id } of waiting) results.push(await processReferenceFile(_id, { now, ...options }));
  return results.filter(Boolean);
}

module.exports = { processReferenceFile, resumeReferenceFiles, readStoredFile, referencesRoot };
