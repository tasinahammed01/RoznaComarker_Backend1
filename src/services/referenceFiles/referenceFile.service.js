'use strict';
// AI knowledge and reference files: upload, list, status, remove, rubric draft and rubric apply, for the teacher who owns the class or
// assignment. Every lookup is scoped to that teacher, so another teacher always gets 404 (never told the class or file exists).
// Responses are built by present() from an allowlist: never the extracted text, the stored path or file id, or a content hash.
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const ReferenceFile = require('../../models/ReferenceFile');
const File = require('../../models/File');
const Class = require('../../models/class.model');
const Assignment = require('../../models/assignment.model');
const User = require('../../models/user.model');
const logger = require('../../utils/logger');
const { withActiveStatus } = require('../classLifecycle.service');
const { ensureActivePlan, getLimit, bytesToMB } = require('../../middlewares/usage.middleware');
const { normalizeAssignmentRubric } = require('../assignmentRubric.service');
const { LIMITS, ReferenceFileError, safeDisplayName } = require('./policy');
const { checkReferenceFile } = require('./fileCheck');
const { processReferenceFile, resumeReferenceFiles, referencesRoot } = require('./processing');
const { convertTextToRubric, RubricConversionError } = require('./rubricConvert');

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { statusCode: status, code, ...extra });
const notFound = () => fail(404, 'NOT_FOUND', 'Not found.');
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/u;
// Upload refusals: what is wrong with the file (400/413) versus a file that could not be read (422).
const STATUS_FOR = { REFERENCE_FILE_TOO_LARGE: 413, REFERENCE_FILE_PASSWORD: 422, REFERENCE_FILE_CORRUPT: 422, REFERENCE_FILE_ARCHIVE_LIMIT: 422 };

/** The class (active, owned) or the assignment (active, owned, writing) plus its class; 404 otherwise. */
async function ownedScope(teacherId, scope, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  if (scope === 'class') {
    const classDoc = await Class.findOne(withActiveStatus({ _id: id, teacher: teacherId, isActive: true })).select('_id').lean();
    if (!classDoc) throw notFound();
    return { scope, classId: classDoc._id, assignmentId: null };
  }
  const assignment = await Assignment.findOne({ _id: id, teacher: teacherId, isActive: true }).select('_id class resourceType').lean();
  if (!assignment) throw notFound();
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: teacherId, isActive: true })).select('_id').lean();
  if (!classDoc) throw notFound();
  if (assignment.resourceType && assignment.resourceType !== 'essay')
    throw fail(400, 'REFERENCE_FILE_NOT_WRITING', 'Reference files can only be added to writing assignments.');
  return { scope, classId: classDoc._id, assignmentId: assignment._id };
}

const scopeFilter = target => (target.scope === 'class'
  ? { class: target.classId, scope: 'class', removedAt: null } : { assignment: target.assignmentId, scope: 'assignment', removedAt: null });
/** The key of a class or assignment for the unique slot and content indexes. */
const scopeKey = target => (target.scope === 'class' ? `class:${target.classId}` : `assignment:${target.assignmentId}`);
const limitError = target => fail(409, 'REFERENCE_FILE_LIMIT', `You can add up to ${LIMITS.maxFilesPerScope} files to each ${target.scope}. Remove one first.`);
const duplicateError = target => fail(409, 'REFERENCE_FILE_DUPLICATE', `This file is already added to this ${target.scope}.`);
const duplicateKeyField = error => Object.keys(error?.keyPattern || error?.keyValue || {})[0] || null;

/** The teacher-facing view of one file. Allowlist: nothing else ever leaves the server. */
function present(doc) {
  const detection = doc.scope === 'assignment' && doc.status === 'ready' && doc.rubricDetection ? doc.rubricDetection : null;
  return {
    id: String(doc._id), scope: doc.scope, classId: String(doc.class), assignmentId: doc.assignment ? String(doc.assignment) : null,
    name: doc.originalName, kind: doc.kind, sizeBytes: doc.sizeBytes, status: doc.removedAt ? 'removed' : doc.status,
    failureCode: doc.status === 'failed' ? doc.failureCode : null, failureMessage: doc.status === 'failed' ? doc.failureMessage : null,
    pages: doc.kind === 'pdf' ? doc.units ?? null : null, slides: doc.kind === 'pptx' ? doc.units ?? null : null,
    textTrimmed: doc.status === 'ready' ? Boolean(doc.textTruncated) : false,
    markedAsRubric: doc.scope === 'assignment' ? Boolean(doc.markedAsRubric) : false,
    rubricSuggestion: detection ? { looksLikeRubric: Boolean(detection.looksLikeRubric), confidence: detection.confidence } : null,
    rubricAppliedAt: doc.rubricAppliedAt || null, createdAt: doc.createdAt, updatedAt: doc.updatedAt
  };
}

/** Starts extraction now, in the background; a failure here only delays it (resume picks it up). */
function startProcessing(id) {
  setImmediate(() => processReferenceFile(id).catch(error =>
    logger.warn({ message: 'Reference file processing could not start', code: 'REFERENCE_FILE_START_FAILED', referenceFileId: String(id), errorName: error?.name })));
}
let resuming = null;
/** Picks up files left waiting (restart, busy worker); at most one sweep at a time per process. */
function resumeInBackground() {
  if (resuming) return resuming;
  resuming = resumeReferenceFiles().catch(error => logger.warn({ message: 'Reference file resume failed', code: 'REFERENCE_FILE_RESUME_FAILED', errorName: error?.name }))
    .finally(() => { resuming = null; });
  return resuming;
}

async function reserveStorage(teacher, megabytes) {
  const limit = getLimit(await ensureActivePlan(teacher), 'storageMB');
  const reserved = limit === null ? { modifiedCount: 0 } : await User.updateOne({ _id: teacher._id,
    $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, megabytes] }, limit] } }, { $inc: { 'usage.storageMB': megabytes } });
  if (!reserved.modifiedCount) throw fail(413, 'REFERENCE_FILE_STORAGE_FULL', 'Your storage is full. Free up space or upgrade your plan to add more files.');
}
const releaseStorage = (teacherId, megabytes) => (megabytes > 0 ? User.updateOne({ _id: teacherId },
  [{ $set: { 'usage.storageMB': { $max: [0, { $subtract: [{ $ifNull: ['$usage.storageMB', 0] }, megabytes] }] } } }], { updatePipeline: true }) : null);

/** Same request, same target: the stored file again. Same request id for another target: refused. */
async function replay(teacherId, requestId, target) {
  const existing = await ReferenceFile.findOne({ owner: teacherId, requestId }).lean();
  if (!existing) return null;
  const same = target.scope === existing.scope && String(existing.class) === String(target.classId)
    && String(existing.assignment || '') === String(target.assignmentId || '');
  if (!same) throw fail(409, 'REFERENCE_FILE_REQUEST_REUSED', 'This upload was already used for another class or assignment. Please add the file again.');
  return { duplicate: true, file: present(existing) };
}

/**
 * Uploads one file to a class or assignment. Order: ownership (before this runs), request id, idempotent replay, per-scope count, file
 * checks, duplicate content, storage reservation, then store and start extraction. Every refusal leaves nothing stored.
 */
async function uploadReferenceFile({ teacher, target, file, requestId, markedAsRubric }) {
  if (!REQUEST_ID.test(String(requestId || ''))) throw fail(400, 'REFERENCE_FILE_REQUEST_ID', 'Missing or invalid request id. Please try again.');
  if (target.scope === 'class' && markedAsRubric) throw fail(400, 'REFERENCE_FILE_RUBRIC_CLASS', 'Only files added to an assignment can be used as a rubric.');
  const replayed = await replay(teacher._id, requestId, target);
  if (replayed) return replayed;
  if (!file?.buffer) throw fail(400, 'REFERENCE_FILE_MISSING', 'Choose a file to upload.');
  // Fast path for a clear answer; the unique slot index below is what makes the limit hold under simultaneous uploads.
  if (await ReferenceFile.countDocuments(scopeFilter(target)) >= LIMITS.maxFilesPerScope) throw limitError(target);
  let checked;
  try { checked = await checkReferenceFile(file.buffer, file.originalname); } catch (error) {
    if (error instanceof ReferenceFileError) throw fail(STATUS_FOR[error.code] || 400, error.code, error.safeMessage);
    throw error;
  }
  const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  if (await ReferenceFile.exists({ ...scopeFilter(target), contentHash })) throw duplicateError(target);

  // bytesToMB rounds to 0.01 MB, so a small file would count as 0: every file counts at least 0.01 MB.
  const megabytes = Math.max(0.01, bytesToMB(file.buffer.length));
  await reserveStorage(teacher, megabytes);
  const filename = `${crypto.randomUUID()}${checked.extension}`;
  const absolute = path.join(referencesRoot(), filename);
  let fileDoc = null;
  try {
    await fs.mkdir(referencesRoot(), { recursive: true });
    await fs.writeFile(absolute, file.buffer, { flag: 'wx' });
    const name = safeDisplayName(file.originalname, checked.kind);
    fileDoc = await File.create({ originalName: name, filename, path: path.relative(path.resolve(__dirname, '../../..'), absolute).split(path.sep).join('/'),
      url: 'internal:reference-file', uploadedBy: teacher._id, role: 'teacher', type: 'references', sizeBytes: file.buffer.length });
    // Atomic limits: take the first free slot of this class or assignment. A taken slot (another upload won it) moves on to the next; a
    // taken content key means the same file is already active here. Both checks are unique indexes, so no race can pass them.
    const key = scopeKey(target);
    let doc = null;
    for (let slot = 0; slot < LIMITS.maxFilesPerScope && !doc; slot += 1) {
      try {
        doc = await ReferenceFile.create({ owner: teacher._id, scope: target.scope, class: target.classId, assignment: target.assignmentId,
          file: fileDoc._id, originalName: name, kind: checked.kind, sizeBytes: file.buffer.length, requestId, contentHash,
          markedAsRubric: target.scope === 'assignment' && Boolean(markedAsRubric), activeSlot: `${key}:${slot}`, activeContentKey: `${key}:${contentHash}` });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const field = duplicateKeyField(error);
        if (field === 'activeSlot') continue;
        if (field === 'activeContentKey') throw duplicateError(target);
        throw error;                                   // the request id: handled below (replay)
      }
    }
    if (!doc) throw limitError(target);
    logger.info({ message: 'Reference file stored', code: 'REFERENCE_FILE_STORED', referenceFileId: String(doc._id), scope: target.scope, kind: checked.kind,
      sizeBytes: file.buffer.length });
    startProcessing(doc._id);
    return { duplicate: false, file: present(doc.toObject()) };
  } catch (error) {
    await fs.unlink(absolute).catch(() => {});
    if (fileDoc) await File.deleteOne({ _id: fileDoc._id }).catch(() => {});
    await releaseStorage(teacher._id, megabytes);
    if (error?.code === 11000) {                       // the same request raced in: answer with the one that won
      const raced = await replay(teacher._id, requestId, target);
      if (raced) return raced;
    }
    throw error;
  }
}

/** The files of a class, or of an assignment plus (read-only) the class files that also apply to it. */
async function listReferenceFiles(target) {
  const order = { createdAt: 1, _id: 1 };
  const files = await ReferenceFile.find(scopeFilter(target)).sort(order).lean();
  const classFiles = target.scope === 'assignment'
    ? await ReferenceFile.find({ class: target.classId, scope: 'class', removedAt: null }).sort(order).lean() : [];
  if ([...files, ...classFiles].some(doc => doc.status === 'processing')) void resumeInBackground();
  return { files: files.map(present), ...(target.scope === 'assignment' ? { classFiles: classFiles.map(present) } : {}),
    limits: { maxFiles: LIMITS.maxFilesPerScope, maxFileBytes: LIMITS.maxFileBytes } };
}

/** One file of this teacher whose class/assignment is still owned and active; 404 otherwise (including after removal, unless allowed). */
async function ownedFile(teacherId, id, { includeRemoved = false, select = '' } = {}) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const doc = await ReferenceFile.findOne({ _id: id, owner: teacherId, ...(includeRemoved ? {} : { removedAt: null }) }).select(select).lean();
  if (!doc) throw notFound();
  await ownedScope(teacherId, doc.scope, doc.scope === 'class' ? doc.class : doc.assignment).catch(error => {
    throw error.statusCode === 404 ? notFound() : error;
  });
  return doc;
}

async function getReferenceFile(teacherId, id) {
  const doc = await ownedFile(teacherId, id);
  if (doc.status === 'processing') void resumeInBackground();
  return { file: present(doc) };
}

/** Soft delete: the file stops applying to future marking at once. Idempotent: removing a removed file answers the same. */
async function removeReferenceFile(teacherId, id) {
  const doc = await ownedFile(teacherId, id, { includeRemoved: true });
  if (doc.removedAt) return { removed: true, file: present(doc) };
  const updated = await ReferenceFile.findOneAndUpdate({ _id: doc._id, owner: teacherId, removedAt: null },
    // Frees the file's slot and content key: the limit and the duplicate check count only active files.
    { $set: { removedAt: new Date(), removedBy: teacherId }, $unset: { activeSlot: 1, activeContentKey: 1 } }, { new: true }).lean();
  logger.info({ message: 'Reference file removed', code: 'REFERENCE_FILE_REMOVED', referenceFileId: String(doc._id), scope: doc.scope });
  return { removed: true, file: present(updated || { ...doc, removedAt: new Date() }) };
}

async function rubricFile(teacherId, id, select = '') {
  const doc = await ownedFile(teacherId, id, { select });
  if (doc.scope !== 'assignment') throw fail(400, 'REFERENCE_RUBRIC_ASSIGNMENT_ONLY', 'Only files added to an assignment can be used as a rubric.');
  if (doc.status !== 'ready') throw fail(409, 'REFERENCE_FILE_NOT_READY', doc.status === 'failed' ? doc.failureMessage : 'This file is still being read. Please wait a moment.');
  return doc;
}

/** A rubric draft (designer format) for the teacher to review; nothing is saved. Free. */
async function draftRubric(teacherId, id, { parse } = {}) {
  const doc = await rubricFile(teacherId, id, '+text');
  const assignment = await Assignment.findById(doc.assignment).select('title rubric rubrics').lean();
  try {
    const { rubricDesigner, notes } = await convertTextToRubric(doc.text, { fallbackTitle: `${assignment?.title || 'Assignment'} rubric`.slice(0, 120), parse });
    logger.info({ message: 'Reference rubric drafted', code: 'REFERENCE_RUBRIC_DRAFTED', referenceFileId: String(doc._id), criteria: rubricDesigner.criteria.length,
      levels: rubricDesigner.levels.length });
    return { rubricDesigner, notes, hasExistingRubric: normalizeAssignmentRubric(assignment || {}).status !== 'absent' };
  } catch (error) {
    if (!(error instanceof RubricConversionError)) throw error;
    logger.warn({ message: 'Reference rubric draft failed', code: error.code, referenceFileId: String(doc._id), issues: error.issues.length });
    throw fail(error.code === 'REFERENCE_RUBRIC_AI_UNAVAILABLE' ? 503 : 422, error.code, error.message,
      error.code === 'REFERENCE_RUBRIC_CONVERSION_FAILED' ? { details: { issues: error.issues } } : {});
  }
}

/**
 * Applies the reviewed rubric to the assignment through the existing rubric save (assignment.controller updateAssignmentRubrics), so
 * validation, normalization and feedback refresh are exactly those of a rubric saved in the editor. An existing rubric is replaced only
 * with replace: true.
 */
async function applyRubric({ teacherId, id, rubricDesigner, replace, req, save = require('../../controllers/assignment.controller').updateAssignmentRubrics }) {
  const doc = await rubricFile(teacherId, id);
  if (!rubricDesigner || typeof rubricDesigner !== 'object' || Array.isArray(rubricDesigner))
    throw fail(400, 'REFERENCE_RUBRIC_INVALID', 'The rubric is missing. Review it and try again.');
  const issues = require('../assignmentRubric.service').validateAssignmentRubricInput(rubricDesigner, true);
  if (issues.length) throw fail(400, 'REFERENCE_RUBRIC_INVALID', issues.join(' '), { details: { issues } });
  const assignment = await Assignment.findById(doc.assignment).select('rubric rubrics').lean();
  const hadRubric = normalizeAssignmentRubric(assignment || {}).status !== 'absent';
  if (hadRubric && replace !== true)
    throw fail(409, 'REFERENCE_RUBRIC_EXISTS', 'This assignment already has a rubric. Confirm that you want to replace it.');
  const result = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; } };
    Promise.resolve(save(Object.assign(Object.create(req), { params: { id: String(doc.assignment) }, body: { rubricDesigner } }), res)).catch(reject);
  });
  if (result.status >= 400) throw fail(result.status, 'REFERENCE_RUBRIC_APPLY_FAILED', result.body?.message || 'The rubric could not be saved.');
  await ReferenceFile.updateOne({ _id: doc._id }, { $set: { rubricAppliedAt: new Date(), rubricAppliedBy: teacherId } });
  logger.info({ message: 'Reference rubric applied', code: 'REFERENCE_RUBRIC_APPLIED', referenceFileId: String(doc._id), replaced: hadRubric });
  return { applied: true, replaced: hadRubric, assignmentId: String(doc.assignment) };
}

module.exports = { ownedScope, uploadReferenceFile, listReferenceFiles, getReferenceFile, removeReferenceFile, draftRubric, applyRubric, present, resumeInBackground };
