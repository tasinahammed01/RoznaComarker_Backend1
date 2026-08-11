'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const Feedback = require('../models/Feedback');
const AdaptivePracticeSession = require('../models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../models/AdaptivePracticeAttempt');
const Upload = require('../models/Upload');
const File = require('../models/File');
const Notification = require('../models/notification.model');
const User = require('../models/user.model');
const logger = require('../utils/logger');

class SubmissionRemovalError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'SubmissionRemovalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function uniqueIds(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function transactionUnsupported(error) {
  const message = String(error?.message || '');
  return error?.code === 20
    || /transaction numbers are only allowed on a replica set member or mongos/i.test(message)
    || /transactions are not supported/i.test(message);
}

function uploadsRoot() {
  const configured = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.resolve(__dirname, '..', '..', configured);
}

function safeUploadPath(storedPath) {
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const root = uploadsRoot();
  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(__dirname, '..', '..', raw);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

async function physicalFileSize(paths) {
  let bytes = 0;
  for (const filePath of uniqueIds(paths.map(safeUploadPath))) {
    try { bytes += (await fs.promises.stat(filePath)).size || 0; } catch { /* missing files need no usage adjustment */ }
  }
  return bytes;
}

async function cleanupPhysicalFiles(paths, submissionId) {
  const failures = [];
  for (const filePath of uniqueIds(paths.map(safeUploadPath))) {
    try { await fs.promises.unlink(filePath); }
    catch (error) {
      if (error?.code !== 'ENOENT') failures.push({ filePath, code: error?.code || 'UNLINK_FAILED' });
    }
  }
  if (failures.length) logger.warn({ message: 'Submission physical file cleanup incomplete',
    submissionId: String(submissionId), failures });
  return failures;
}

async function loadAuthorizedContext(submissionId, teacherId) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    throw new SubmissionRemovalError(400, 'INVALID_SUBMISSION_ID', 'Invalid submission id.');
  }
  const submission = await Submission.findById(submissionId).lean();
  if (!submission) throw new SubmissionRemovalError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');

  const assignment = await Assignment.findById(submission.assignment).select('_id class teacher').lean();
  const ownsAssignment = assignment && String(assignment.teacher) === String(teacherId);
  const submissionMatchesAssignment = assignment && String(submission.class) === String(assignment.class);
  const classDoc = assignment
    ? await Class.findOne({ _id: assignment.class, teacher: teacherId }).select('_id teacher').lean()
    : null;
  if (!ownsAssignment || !submissionMatchesAssignment || !classDoc) {
    throw new SubmissionRemovalError(403, 'SUBMISSION_REMOVAL_FORBIDDEN', 'You cannot remove this submission.');
  }
  return { submission, assignment, classDoc };
}

async function collectCleanupContext(submission) {
  const feedback = await Feedback.findOne({ submission: submission._id }).select('file').lean();
  const fileIds = uniqueIds([
    submission.file,
    ...(submission.files || []),
    feedback?.file
  ]);
  const [fileDocs, uploadDocs] = await Promise.all([
    fileIds.length ? File.find({ _id: { $in: fileIds } }).select('_id path').lean() : [],
    Upload.find({ submissionId: submission._id }).select('_id originalFilePath processedFilePath').lean()
  ]);
  const physicalPaths = uniqueIds([
    ...fileDocs.map((doc) => doc.path),
    ...uploadDocs.flatMap((doc) => [doc.originalFilePath, doc.processedFilePath])
  ]);
  return { fileIds, physicalPaths, storageBytes: await physicalFileSize(physicalPaths) };
}

async function deleteDatabaseState(context, mongoSession = null) {
  const { submission } = context;
  const options = mongoSession ? { session: mongoSession } : {};
  const sessions = await AdaptivePracticeSession.find({ submissionId: submission._id })
    .select('_id').session(mongoSession || null).lean();
  const sessionIds = sessions.map((item) => item._id);

  await AdaptivePracticeAttempt.deleteMany({ $or: [
    { submissionId: submission._id },
    ...(sessionIds.length ? [{ sessionId: { $in: sessionIds } }] : [])
  ] }, options);
  await AdaptivePracticeSession.deleteMany({ submissionId: submission._id }, options);
  await SubmissionFeedback.deleteMany({ submissionId: submission._id }, options);
  await Feedback.deleteMany({ submission: submission._id }, options);
  await Upload.deleteMany({ submissionId: submission._id }, options);
  await Notification.deleteMany({ 'data.submissionId': String(submission._id) }, options);
  if (context.fileIds.length) await File.deleteMany({ _id: { $in: context.fileIds } }, options);

  const storageMB = Number((context.storageBytes / (1024 * 1024)).toFixed(2));
  await User.updateOne({ _id: submission.student }, [{ $set: {
    'usage.submissions': { $max: [0, { $subtract: [{ $ifNull: ['$usage.submissions', 0] }, 1] }] },
    'usage.storageMB': { $max: [0, { $subtract: [{ $ifNull: ['$usage.storageMB', 0] }, storageMB] }] }
  } }], { ...options, updatePipeline: true });

  const removed = await Submission.deleteOne({ _id: submission._id, student: submission.student,
    assignment: submission.assignment, class: submission.class }, options);
  if (removed.deletedCount !== 1) {
    throw new SubmissionRemovalError(409, 'SUBMISSION_CHANGED', 'Submission changed before it could be removed.');
  }
}

async function removeSubmissionForTeacher(submissionId, teacherId) {
  const authorized = await loadAuthorizedContext(submissionId, teacherId);
  const cleanup = await collectCleanupContext(authorized.submission);
  const context = { ...authorized, ...cleanup };
  const mongoSession = await mongoose.startSession();
  try {
    try {
      await mongoSession.withTransaction(() => deleteDatabaseState(context, mongoSession));
    } catch (error) {
      if (!transactionUnsupported(error)) throw error;
      logger.warn({ message: 'Mongo transactions unavailable; using ordered submission cleanup',
        submissionId: String(submissionId) });
      await deleteDatabaseState(context);
    }
  } finally {
    await mongoSession.endSession();
  }

  const physicalCleanupFailures = await cleanupPhysicalFiles(context.physicalPaths, submissionId);
  return { submissionId: String(submissionId), assignmentId: String(context.assignment._id),
    classId: String(context.classDoc._id), physicalCleanupPending: physicalCleanupFailures.length };
}

module.exports = { SubmissionRemovalError, safeUploadPath, loadAuthorizedContext,
  collectCleanupContext, deleteDatabaseState, cleanupPhysicalFiles, removeSubmissionForTeacher };
