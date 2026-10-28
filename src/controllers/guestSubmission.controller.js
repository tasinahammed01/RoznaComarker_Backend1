'use strict';
const correctionShadowStagingHook = require('../services/correctionShadow/stagingHook');
const mongoose = require('mongoose');
const fs = require('fs/promises');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const User = require('../models/user.model');
const Submission = require('../models/Submission');
const File = require('../models/File');
const Feedback = require('../models/SubmissionFeedback');
const access = require('../services/guestAccess.service');
const uploads = require('./submission.controller');
const accounting = require('../services/assessmentCreditRouter.service');
const { pendingAnalysisState } = require('../services/submissionAnalysisLifecycle.service');
const { scheduleSubmissionAnalysis } = require('../services/assessmentRecovery.service');
const { ensureActivePlan, getLimit, bytesToMB } = require('../middlewares/usage.middleware');
const { showMarksToStudent, redactStudentMarks } = require('../services/assignmentAccessPolicy.service');
const email = require('../services/email.service');
const logger = require('../utils/logger');
const { withActiveStatus } = require('../services/classLifecycle.service');

const ok = (res, data) => res.json({ success: true, data });
async function clean(req, documents = []) {
  if (req.guestRevisionLease) {
    const lease = req.guestRevisionLease; req.guestRevisionLease = null;
    await Submission.updateOne({ _id: req.params.submissionId, 'guestRevisionLease.owner': lease }, { $unset: { guestRevisionLease: 1 } });
  }
  if (req.guestCommitted || req.guestPreserveUncertainFiles) return;
  await Promise.all((req.files || []).map(file => file.path ? fs.unlink(file.path).catch(() => {}) : null));
  const persisted = [...documents, ...(req.guestPersistedFiles || [])];
  if (persisted.length) await File.deleteMany({ _id: { $in: persisted.map(file => file._id) } });
  req.guestPersistedFiles = [];
  if (req.guestStorageReservation && !req.guestCommitted) {
    const reservation = req.guestStorageReservation;
    req.guestStorageReservation = null;
    await User.updateOne({ _id: reservation.ownerId }, { $inc: { 'usage.storageMB': -reservation.totalMB } });
  }
}
function endpoint(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (error) {
      await clean(req).catch(() => {});
      // Never log request bodies, URLs, emails, provider errors or tokens.
      logger.warn({ event: 'guest_request_failed', code: error.code || 'GUEST_REQUEST_FAILED' });
      res.status(error.statusCode || error.status || 503).json({ success: false,
        message: error.statusCode || error.status ? error.message : 'Temporarily unavailable. Please retry.', code: error.code });
    }
  };
}
async function assignmentFor(qrToken) {
  if (typeof qrToken !== 'string' || qrToken.length > 128) throw access.fail(404, 'Assignment unavailable.');
  const assignment = await Assignment.findOne({ qrToken, isActive: true, allowGuestSubmission: true });
  if (!assignment || (assignment.resourceType && assignment.resourceType !== 'essay')) throw access.fail(404, 'Guest submission is unavailable. Sign in to continue.');
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: assignment.teacher, isActive: true }));
  const owner = classDoc && await User.findOne({ _id: assignment.teacher, role: 'teacher', isActive: { $ne: false } });
  if (!owner) throw access.fail(404, 'Assignment unavailable.');
  return { assignment, classDoc, owner };
}
const entry = endpoint(async (req, res) => {
  const { assignment } = await assignmentFor(req.params.qrToken);
  ok(res, { title: assignment.title, instructions: assignment.instructions || '',
    deadline: assignment.deadline, allowGuestSubmission: true });
});

// Fail closed until the explicitly managed indexes have been installed.
async function requireIndexes() {
  const indexes = await Submission.collection.indexes();
  const student = indexes.find(i => Object.keys(i.key).length === 2 && i.key.student === 1 && i.key.assignment === 1 && i.unique);
  const guest = indexes.find(i => Object.keys(i.key).length === 2 && i.key.assignment === 1 && i.key.guestRequestKey === 1 && i.unique);
  if (JSON.stringify(student?.partialFilterExpression) !== JSON.stringify({ student: { $type: 'objectId' } })
      || JSON.stringify(guest?.partialFilterExpression) !== JSON.stringify({ guestRequestKey: { $type: 'string' } })) {
    throw access.fail(503, 'Guest submission is awaiting setup.', 'GUEST_INDEX_SETUP_REQUIRED');
  }
}
const prepare = endpoint(async (req, res, next) => {
  const context = await assignmentFor(req.params.qrToken);
  await requireIndexes();
  req.guestContext = context;
  next();
});
async function revisionContext(req, enforceAdaptive = false) {
  const context = await assignmentFor(req.guestSubmission.qrToken);
  if (!context.assignment.allowResubmission) throw access.fail(403, 'Another draft is not allowed for this assignment.', 'RESUBMISSION_NOT_ALLOWED');
  if (context.assignment.deadline && new Date() > context.assignment.deadline && !context.assignment.allowLateResubmission) throw access.fail(403, 'Deadline passed.');
  if (enforceAdaptive && context.assignment.requireAdaptiveBeforeResubmission) {
    const completion = await require('../services/adaptivePractice.service').getAdaptiveCompletionForResubmission(req.guestSubmission._id, req.guestAccessContext);
    if (!completion.completed) throw access.fail(403, 'Complete adaptive practice before submitting another draft.', 'ADAPTIVE_PRACTICE_REQUIRED');
  }
  req.guestContext = context;
  const identity = await Submission.findById(req.guestSubmission._id).select('+guest.normalizedEmail');
  req.guestStoredIdentity = identity.guest;
  return context;
}
const prepareRevisionPreview = endpoint(async (req, _res, next) => { await revisionContext(req, true); next(); });
const bindRevisionIdentity = (req, _res, next) => {
  req.body.name = req.guestStoredIdentity.displayName;
  req.body.email = req.guestStoredIdentity.normalizedEmail;
  next();
};
const prepareRevision = endpoint(async (req, res, next) => {
  await revisionContext(req);
  const key = req.get('Idempotency-Key');
  if (!/^[\w-]{32,128}$/.test(key || '')) throw access.fail(400, 'A valid submission reference is required.');
  req.guestRevisionKey = access.hash(key);
  const lease = require('crypto').randomUUID();
  const claimed = await Submission.findOneAndUpdate({ _id: req.guestSubmission._id,
    $or: [{ 'guestRevisionLease.until': { $exists: false } }, { 'guestRevisionLease.until': { $lte: new Date() } }] },
  { $set: { guestRevisionLease: { owner: lease, until: new Date(Date.now() + 15 * 60 * 1000) } } }, { returnDocument: 'after' })
    .select('+guestAcceptedRevisionKey');
  if (!claimed) throw access.fail(409, 'Another draft upload is in progress. Please retry shortly.');
  req.guestRevisionLease = lease;
  req.guestSubmission = claimed;
  res.once('finish', () => { void clean(req).catch(() => {}); });
  next();
});
const revise = endpoint(async (req, res) => {
  const { assignment, owner } = await revisionContext(req);
  if (!req.files?.length) throw access.fail(400, 'Choose between 1 and 20 files.');
  const contentHash = await uploads.fileContentIdentity(req);
  const Request = require('../models/GuestRevisionRequest');
  const receiptId = `${req.guestSubmission._id}:${req.guestRevisionKey}`;
  const receipt = await Request.findOneAndUpdate({ _id: receiptId }, { $setOnInsert: {
    submissionId: req.guestSubmission._id, contentHash } }, { upsert: true, returnDocument: 'after' });
  if (receipt.contentHash !== contentHash) throw access.fail(409, 'This submission reference was used for different content.');
  if (receipt.status === 'complete' || req.guestSubmission.guestAcceptedRevisionKey === req.guestRevisionKey) {
    await Request.updateOne({ _id: receiptId }, { $set: { status: 'complete' } });
    await clean(req);
    return ok(res, { received: true, duplicate: true, returnUrl: access.returnUrl(req.guestSubmission._id, req.get('X-Guest-Token')) });
  }
  await revisionContext(req, true);
  const renewed = await Submission.updateOne({ _id: req.guestSubmission._id, 'guestRevisionLease.owner': req.guestRevisionLease },
    { $set: { 'guestRevisionLease.until': new Date(Date.now() + 15 * 60 * 1000) } });
  if (!renewed.modifiedCount) throw access.fail(409, 'This upload session expired. Please retry.');
  if (['pending', 'processing'].includes(req.guestSubmission.ocrStatus) || ['started', 'processing'].includes(req.guestSubmission.assessmentStatus)) {
    throw access.fail(409, 'Wait for the current assessment to finish before uploading another draft.');
  }
  const credit = await accounting.canRunAssessment({ teacherUserId: owner._id, assignmentId: assignment._id, user: owner });
  if (!credit.allowed) throw access.fail(403, 'Your teacher has no assessment credits available.', 'INSUFFICIENT_ASSESSMENT_CREDITS');
  const totalMB = req.files.reduce((sum, file) => sum + bytesToMB(file.size), 0);
  const limit = getLimit(await ensureActivePlan(owner), 'storageMB');
  if (limit === null) throw access.fail(403, 'Your teacher cannot receive more uploads right now.');
  const reserved = await User.updateOne({ _id: owner._id,
    $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, totalMB] }, limit] } }, { $inc: { 'usage.storageMB': totalMB } });
  if (!reserved.modifiedCount) throw access.fail(403, 'Your teacher cannot receive more uploads right now.');
  req.guestStorageReservation = { ownerId: owner._id, totalMB };
  req.uploadOwner = { _id: owner._id, role: 'teacher' }; req.guestPersistedFiles = [];
  const json = res.json.bind(res);
  res.json = async body => {
    res.json = json;
    if (!body.success) { await clean(req); return json(body); }
    await Request.updateOne({ _id: receiptId }, { $set: { status: 'complete', draftNumber: body.data?.draftNumber } });
    await clean(req);
    const link = access.returnUrl(req.guestSubmission._id, req.get('X-Guest-Token'));
    const delivery = await email.sendGuestSubmissionEmail({ to: req.guestStoredIdentity.normalizedEmail, assignmentTitle: assignment.title, returnUrl: link });
    if (email.sendTeacherSubmissionEmail) await email.sendTeacherSubmissionEmail({ to: owner.email, assignmentTitle: assignment.title, studentName: req.guestStoredIdentity.displayName });
    return json({ success: true, data: { received: true, returnUrl: link, emailSent: delivery.success } });
  };
  await uploads.upsertSubmission({ req, res, assignment, qrToken: assignment.qrToken });
});
// The presentation DTO is intentionally explicit: guest access never exposes
// teacher accounts, rosters, storage paths, or bearer material.
const presentation = endpoint(async (req, res) => {
  const doc = req.guestSubmission;
  const assignment = req.guestAssignment;
  const fields = ['_id', 'submittedAt', 'status', 'isLate', 'draftNumber', 'ocrJobId',
    'transcriptText', 'combinedOcrText', 'ocrText', 'ocrStatus', 'correctionStatus', 'semanticStatus',
    'evaluationStatus', 'assessmentStatus', 'assessmentCompletedAt', 'correctionSourceHash',
    'evaluationSourceHash', 'transcriptLayoutVersion', 'correctionStatistics'];
  const submission = Object.fromEntries(fields.filter(key => doc[key] != null).map(key => [key, doc[key]]));
  const files = await File.find({ _id: { $in: doc.files?.length ? doc.files : [doc.file] } }).lean();
  const byId = new Map(files.map(file => [String(file._id), file]));
  submission.files = (doc.files?.length ? doc.files : [doc.file]).map(id => byId.get(String(id))).filter(Boolean)
    .map(file => ({ _id: String(file._id), originalName: file.originalName,
      url: `/api/guest/submissions/${doc._id}/media/${file._id}/${encodeURIComponent(file.originalName)}` }));
  submission.ocrPages = (doc.toJSON().ocrPages || []).map(({ studentSourceEvidence, pageImageUrl, ...page }) => ({ ...page,
    ...(page.derivedImageFileId ? { pageImageUrl: `/api/guest/submissions/${doc._id}/media/${page.derivedImageFileId}/page.png` } : {}) }));
  submission.file = submission.files[0];
  submission.fileUrls = submission.files.map(file => file.url);
  submission.fileUrl = submission.fileUrls[0];
  submission.assignment = String(assignment._id);
  submission.class = String(assignment.class);
  submission.submissionMode = 'guest';
  const source = require('../utils/sourceFidelity').payload(doc);
  if (source) submission.sourceFidelity = source;
  const assignmentDto = Object.fromEntries(['_id', 'title', 'instructions', 'deadline', 'rubric', 'rubrics',
    'showMarksToStudent', 'allowResubmission', 'requireAdaptiveBeforeResubmission', 'qrToken']
    .filter(key => assignment[key] != null).map(key => [key, assignment[key]]));
  ok(res, { submission, assignment: assignmentDto,
    classSummary: { name: req.guestClass.name, gradingScale: req.guestClass.gradingScale } });
});
const media = endpoint(async (req, res) => {
  const doc = req.guestSubmission;
  if (![...(doc.files || []), doc.file, ...(doc.ocrPages || []).map(page => page.derivedImageFileId)]
    .some(id => id && String(id) === req.params.fileId)) throw access.fail(404, 'File unavailable.');
  const file = await File.findById(req.params.fileId);
  if (!file) throw access.fail(404, 'File unavailable.');
  const path = require('path');
  res.sendFile(path.resolve(__dirname, '../..', file.path));
});
const attempts = endpoint(async (req, res) => {
  ok(res, await require('../services/adaptivePracticeAttempt.service').listAttempts(req.params.sessionId,
    req.guestAccessContext, req.query.activityId, req.query.questionId));
});
const submit = endpoint(async (req, res) => {
  // Upload/preflight can take time; apply current availability and ownership again.
  const { assignment, classDoc, owner } = await assignmentFor(req.params.qrToken);
  const guest = access.identity(req.body);
  const key = req.get('Idempotency-Key');
  if (!/^[\w-]{32,128}$/.test(key || '')) throw access.fail(400, 'A valid submission reference is required.');
  if (!req.files?.length || req.files.length > 20) throw access.fail(400, 'Choose between 1 and 20 files.');
  const contentIdentity = await uploads.fileContentIdentity(req);
  const requestHash = access.hash(JSON.stringify([guest, contentIdentity]));
  const guestRequestKey = access.hash(key);
  const existing = await Submission.findOne({ assignment: assignment._id, guestRequestKey }).select('+guest.requestHash');
  if (existing) {
    await clean(req);
    if (existing.guest?.requestHash !== requestHash) throw access.fail(409, 'This submission reference was already used for different content.');
    return ok(res, { received: true, duplicate: true,
      message: 'Your submission was already received. Use the emailed link or request a new link.' });
  }
  const credit = await accounting.canRunAssessment({ teacherUserId: owner._id, assignmentId: assignment._id, user: owner });
  if (!credit.allowed) throw access.fail(403, 'Your teacher has no assessment credits available. Please contact your teacher.', 'INSUFFICIENT_ASSESSMENT_CREDITS');
  const totalMB = req.files.reduce((sum, f) => sum + bytesToMB(f.size), 0);
  const plan = await ensureActivePlan(owner);
  const storageLimit = getLimit(plan, 'storageMB');
  if (storageLimit === null || Number(owner.usage?.storageMB || 0) + totalMB > storageLimit) {
    throw access.fail(403, 'Your teacher cannot receive more uploads right now.');
  }
  const issued = access.issueToken();
  const id = new mongoose.Types.ObjectId();
  const link = access.returnUrl(id, issued.token); // validate configuration before persistence
  const reserved = await User.updateOne({ _id: owner._id,
    $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, totalMB] }, storageLimit] } },
  { $inc: { 'usage.storageMB': totalMB } });
  if (!reserved.modifiedCount) throw access.fail(403, 'Your teacher cannot receive more uploads right now.');
  req.guestStorageReservation = { ownerId: owner._id, totalMB };
  // Storage belongs to the real assignment owner; no guest User or Firebase UID.
  req.uploadOwner = { _id: owner._id, role: 'teacher' };
  req.guestPersistedFiles = [];
  const persisted = await uploads.persistUploadedFiles(req, 'submissions', file => req.guestPersistedFiles.push(file));
  if (persisted.error) throw access.fail(persisted.error.statusCode, persisted.error.message);
  let created;
  try {
    const now = new Date();
    const isLate = Boolean(assignment.deadline && now > assignment.deadline);
    // Existing first submissions accept late work and label it late; preserve that policy.
    created = await Submission.create({ _id: id, submissionMode: 'guest', assignment: assignment._id,
      class: classDoc._id, guestRequestKey, fileContentIdentity: contentIdentity,
      guest: { ...guest, requestHash, accessHash: issued.accessHash, expiresAt: issued.expiresAt },
      files: persisted.files.map(file => file._id), file: persisted.files[0]._id,
      fileOrder: persisted.files.map((file, order) => ({ fileId: file._id, order })),
      fileUrls: persisted.urls, fileUrl: persisted.urls[0],
      submittedAt: now, status: isLate ? 'late' : 'submitted', isLate,
      qrToken: assignment.qrToken,
      ...pendingAnalysisState({ ocrJobId: new mongoose.Types.ObjectId().toString(), now }) });
  } catch (error) {
    if (error.code === 11000) {
      await clean(req, persisted.files);
      const winner = await Submission.findOne({ assignment: assignment._id, guestRequestKey }).select('+guest.requestHash');
      if (winner?.guest?.requestHash === requestHash) return ok(res, { received: true, duplicate: true });
      throw access.fail(409, 'This submission reference has already been used.');
    }
    // A lost database acknowledgement does not prove the insert failed. Retain
    // source/storage reservations until its outcome can be established.
    req.guestPreserveUncertainFiles = true;
    created = await Submission.findById(id).catch(() => null);
    if (!created) {
      logger.warn({ event: 'guest_upload_commit_reconciliation_required', submissionId: String(id) });
      throw error;
    }
  }
  // Once committed, upload cleanup must never remove the assessment's source files.
  req.guestCommitted = true;
  req.files = [];
  if (correctionShadowStagingHook.enabled()) correctionShadowStagingHook.trackResponse(created._id, created.ocrJobId, res);
  scheduleSubmissionAnalysis(created._id, created.ocrJobId);
  // Only the unique insert winner reaches this accepted-submission boundary.
  try {
    await require('../services/notification.service').createNotification({ recipientId: owner._id,
      type: 'assignment_submitted', title: 'Assignment submitted',
      description: `${guest.displayName} (Guest) submitted ${assignment.title}`,
      idempotencyKey: `submission:${created._id}:submitted`, data: {
        classId: String(classDoc._id), assignmentId: String(assignment._id), submissionId: String(created._id),
        draftNumber: 1, waitingReviewAdded: true, route: {
          path: '/teacher/my-classes/detail/student-submissions', params: ['guest'],
          queryParams: { classId: String(classDoc._id), assignmentId: String(assignment._id), submissionId: String(created._id) }
        } } });
  } catch { logger.warn({ event: 'guest_teacher_notification_failed' }); }
  if (email.sendTeacherSubmissionEmail) await email.sendTeacherSubmissionEmail({ to: owner.email,
    assignmentTitle: assignment.title, studentName: guest.displayName });
  const delivery = await email.sendGuestSubmissionEmail({ to: guest.normalizedEmail,
    assignmentTitle: assignment.title, returnUrl: link });
  ok(res, { received: true, returnUrl: link, emailSent: delivery.success,
    message: delivery.success ? 'Submission received. Your return link has been emailed.'
      : 'Submission received. Save your return link; email delivery failed. You can request another link later.' });
});
const results = endpoint(async (req, res) => {
  const doc = req.guestSubmission;
  const assignment = await Assignment.findById(doc.assignment);
  if (!assignment?.isActive) throw access.fail(404, 'Results unavailable.');
  const feedback = await Feedback.findOne({ submissionId: doc._id }).lean();
  const state = require('../services/canonicalResultState.service').buildCanonicalResultState({ submission: doc, feedback });
  const ready = doc.assessmentStatus === 'complete' && state.evaluationCurrent && state.detailedFeedbackCurrent;
  const failed = [doc.assessmentStatus, doc.ocrStatus, doc.correctionStatus, doc.semanticStatus, doc.evaluationStatus].includes('failed');
  const status = ready ? 'complete' : failed ? 'failed' : doc.evaluationStatus === 'blocked' ? 'blocked' : 'processing';
  const publicFeedback = ready ? { overallScore: state.score, rubricScores: feedback.rubricScores,
    detailedFeedback: feedback.detailedFeedback, teacherComments: feedback.teacherComments || '' } : null;
  const data = { title: assignment.title, name: doc.guest.displayName, submittedAt: doc.submittedAt,
    ...(require('../utils/sourceFidelity').payload(doc)?{sourceFidelity:require('../utils/sourceFidelity').payload(doc)}:{}),
    status, ocrStatus: doc.ocrStatus,
    processingMessage: status === 'blocked'
      ? doc.evaluationErrorCode === 'INSUFFICIENT_ASSESSMENT_CREDITS'
        ? 'Assessment is waiting for your teacher to add credits. Please contact your teacher.'
        : 'Assessment cannot continue yet. Please contact your teacher.'
      : status === 'failed' ? 'Processing could not finish. Please contact your teacher.' : undefined,
    transcript: doc.transcriptText || doc.combinedOcrText || doc.ocrText || '',
    feedback: publicFeedback, marksVisible: showMarksToStudent(assignment),
    allowResubmission: assignment.allowResubmission === true,
    requireAdaptiveBeforeResubmission: assignment.requireAdaptiveBeforeResubmission === true };
  ok(res, data.marksVisible ? data : redactStudentMarks(data));
});
const recover = endpoint(async (req, res) => {
  // Always acknowledge before lookup/provider work; no timing or existence oracle.
  ok(res, { message: 'If a matching submission exists, a new link will be emailed.' });
  setImmediate(async () => {
    try {
      const guest = access.identity({ name: 'Recovery', email: req.body?.email });
      let qrToken = req.params.qrToken;
      if (req.params.submissionId) {
        if (!mongoose.isValidObjectId(req.params.submissionId)) return;
        const original = await Submission.findOne({ _id: req.params.submissionId, submissionMode: 'guest',
          'guest.normalizedEmail': guest.normalizedEmail, 'guest.revokedAt': null }).select('qrToken');
        if (!original) return;
        qrToken = original.qrToken;
      }
      const { assignment } = await assignmentFor(qrToken);
      const cutoff = new Date(Date.now() - 15 * 60 * 1000);
      // Recover only the latest submission. Rotation is atomic and throttled per submission.
      const candidate = await Submission.findOne({ ...(req.params.submissionId ? { _id: req.params.submissionId } : {}), assignment: assignment._id, submissionMode: 'guest',
        'guest.normalizedEmail': guest.normalizedEmail, 'guest.revokedAt': null }).sort({ submittedAt: -1 }).select('_id');
      if (!candidate) return;
      const issued = access.issueToken();
      const link = access.returnUrl(candidate._id, issued.token);
      const rotated = await Submission.findOneAndUpdate({ _id: candidate._id, 'guest.revokedAt': null,
        $or: [{ 'guest.recoveredAt': { $exists: false } }, { 'guest.recoveredAt': { $lte: cutoff } }] },
      { $set: { 'guest.accessHash': issued.accessHash, 'guest.expiresAt': issued.expiresAt, 'guest.recoveredAt': new Date() },
        $unset: { 'guest.resultAccessHash': 1, 'guest.resultExpiresAt': 1 } });
      if (rotated) await email.sendGuestSubmissionEmail({ to: guest.normalizedEmail, assignmentTitle: assignment.title, returnUrl: link });
    } catch { logger.warn({ event: 'guest_recovery_failed' }); }
  });
});
const practice = endpoint(async (req, res) => {
  const service = require('../services/adaptivePractice.service');
  ok(res, await (req.method === 'POST' ? service.generateSession(req.guestSubmission._id, req.guestAccessContext, { retry: req.body?.retry === true })
    : service.getCurrentSession(req.guestSubmission._id, req.guestAccessContext)));
});
const attempt = endpoint(async (req, res) => {
  ok(res, await require('../services/adaptivePracticeAttempt.service').checkResponse(req.params.sessionId,
    req.params.activityId, req.guestAccessContext, req.body));
});
const drafts = endpoint(async (req, res) => {
  ok(res, await require('../services/draftComparison.service').comparisonForSubmission(String(req.guestSubmission._id), req.guestAccessContext));
});
const revoke = endpoint(async (req, res) => {
  const submission = await Submission.findOne({ _id: req.params.submissionId, submissionMode: 'guest' });
  if (!submission) throw access.fail(404, 'Submission unavailable.');
  await require('../services/upload.service').assertTeacherOwnsClassOrThrow(req.user._id, submission.class);
  await Submission.updateOne({ _id: submission._id }, { $set: { 'guest.revokedAt': new Date() }, $unset: { 'guest.accessHash': 1 } });
  ok(res, { revoked: true });
});
module.exports = { entry, prepare, prepareRevision, prepareRevisionPreview, bindRevisionIdentity, revise, submit, results, recover, practice, attempt, attempts, presentation, media, drafts, revoke, assignmentFor, requireIndexes };
