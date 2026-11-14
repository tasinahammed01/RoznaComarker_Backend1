'use strict';
// "Teacher uploads students' handwritten work": a teacher saves photos of each student's pages as a normal submission on one of
// their own essay assignments. A class member gets a registered submission; anyone else gets a guest submission whose feedback
// link is emailed only when the teacher asks. Every save runs the existing OCR and AI marking pipeline.
//
// Guarantees: only the assignment's own teacher (on an active class) gets past ownedContext (404 otherwise); every input is
// re-validated here; a retried request (same idempotency key) never creates a second submission; a teacher's saves are
// serialised by a database lease so credits and storage are checked and reserved atomically, even with parallel uploads;
// a send request moves the email status from none/failed to queued exactly once.
const crypto = require('crypto');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const User = require('../models/user.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const File = require('../models/File');
const Lease = require('../models/SubmissionUploadLease');
const access = require('./guestAccess.service');
const accounting = require('./assessmentCreditRouter.service');
const input = require('./teacherUploadInput.service');
const { pendingAnalysisState } = require('./submissionAnalysisLifecycle.service');
const { scheduleSubmissionAnalysis } = require('./assessmentRecovery.service');
const { withActiveStatus } = require('./classLifecycle.service');
const { ensureActivePlan, getLimit, bytesToMB } = require('../middlewares/usage.middleware');
const logger = require('../utils/logger');

const MAX_PAGES_PER_STUDENT = 20;
const LEASE_MS = 2 * 60 * 1000;          // a crashed save releases the teacher's lock after this
const LEASE_WAIT_MS = 20 * 1000;         // a save waits this long for the teacher's other saves before answering "busy"
const PENDING_CHARGE = ['started', 'processing'];   // saved but not yet charged: credits are consumed when marking completes
const EMAIL_STATUSES_TO_QUEUE = ['none', 'failed'];
// "Resend email" on an email that was already sent: at most once a minute per submission (on top of the route's rate limit and
// the per-teacher email limit), and idempotent on the client's request id.
const RESEND_COOLDOWN_MS = 60 * 1000;
const REQUEST_ID = /^[a-f0-9-]{36}$/i;
const CREDIT_BLOCK = 'INSUFFICIENT_ASSESSMENT_CREDITS';
const RESTART_GRACE_MS = 2 * 60 * 1000;  // a (re)start whose dispatch has not claimed it yet counts as requested for this long

function fail(statusCode, message, code, details) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}
const notFound = () => fail(404, 'Assignment not found.', 'NOT_FOUND');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The assignment and its active class, only when this teacher owns both; 404 otherwise (never reveals that it exists). */
async function ownedContext(teacherId, assignmentId) {
  if (!mongoose.isValidObjectId(assignmentId)) throw notFound();
  const assignment = await Assignment.findOne({ _id: assignmentId, teacher: teacherId, isActive: true })
    .select('_id title class teacher deadline resourceType').lean();
  if (!assignment) throw notFound();
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: teacherId, isActive: true })).select('_id teacher').lean();
  if (!classDoc) throw notFound();
  if (assignment.resourceType && assignment.resourceType !== 'essay')
    throw fail(400, 'Student work can only be uploaded for writing assignments.', 'TEACHER_UPLOAD_NOT_WRITING');
  return { assignment, classDoc };
}

/** Credits this teacher can still spend: the wallet (or institution share) minus uploads saved but not yet charged. */
async function creditSummary(teacher, ctx) {
  const state = await accounting.canRunAssessment({ teacherUserId: teacher._id, assignmentId: ctx.assignment._id, user: teacher });
  let available = Math.max(0, Number(state.availableCredits) || 0);
  if (state.myLimit != null) available = Math.min(available, Math.max(0, Number(state.myLimit) - Number(state.myUsage || 0)));
  const reserved = await Submission.countDocuments({ 'teacherUpload.uploadedBy': teacher._id, assessmentStatus: { $in: PENDING_CHARGE } });
  return { available: Math.max(0, available - reserved), reserved, wallet: available };
}

/** A class member gets a registered submission; any other address (with or without an account elsewhere) a guest one. */
async function matchStudent(ctx, email) {
  const user = await User.findOne({ email, role: 'student' }).select('_id').lean();
  if (user && await Membership.exists({ student: user._id, class: ctx.classDoc._id, status: 'active' })) return { kind: 'member', userId: user._id };
  return { kind: 'guest' };
}

async function existingFor(ctx, match, email) {
  const query = match.kind === 'member'
    ? { assignment: ctx.assignment._id, student: match.userId }
    : { assignment: ctx.assignment._id, submissionMode: 'guest', 'guest.normalizedEmail': email, 'teacherUpload.uploadedBy': { $exists: true } };
  return Submission.findOne(query).select('+teacherUpload _id files assessmentStatus submissionMode').lean();
}

/** Validates a list of students for step 1 and the review step: errors per row, account kind, existing work, credits. */
async function check({ teacher, assignmentId, students }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  const rows = input.validateStudents(students);
  for (const row of rows) {
    if (row.errors) continue;
    const match = await matchStudent(ctx, row.email);
    row.account = match.kind;
    const existing = await existingFor(ctx, match, row.email);
    if (!existing) continue;
    if (!existing.teacherUpload) {
      row.errors = { email: 'This student already submitted their own work for this assignment. Open it from the submissions list.' };
      continue;
    }
    row.existing = { submissionId: String(existing._id), pages: (existing.files || []).length };
  }
  const credits = await creditSummary(teacher, ctx);
  return { students: rows, credits: { needed: rows.filter(row => !row.errors).length, available: credits.available } };
}

async function withTeacherLease(teacherId, fn) {
  const id = `teacher-upload:${teacherId}`, owner = crypto.randomUUID();
  try { await Lease.updateOne({ _id: id }, { $setOnInsert: { until: new Date(0) } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const giveUpAt = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    const locked = await Lease.findOneAndUpdate({ _id: id, until: { $lte: new Date() } },
      { $set: { owner, until: new Date(Date.now() + LEASE_MS) } }, { returnDocument: 'after' });
    if (locked) break;
    if (Date.now() > giveUpAt) throw fail(409, 'Another upload is still being saved. Please try again.', 'TEACHER_UPLOAD_BUSY');
    await sleep(100);
  }
  try { return await fn(); }
  finally { await Lease.updateOne({ _id: id, owner }, { $set: { until: new Date(0) } }).catch(() => {}); }
}

async function reserveStorage(teacher, totalMB) {
  const plan = await ensureActivePlan(teacher);
  const limit = getLimit(plan, 'storageMB');
  const reserved = limit === null ? { modifiedCount: 0 } : await User.updateOne({ _id: teacher._id,
    $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, totalMB] }, limit] } }, { $inc: { 'usage.storageMB': totalMB } });
  if (!reserved.modifiedCount) throw fail(413, 'Your storage is full. Free up space or upgrade your plan to upload more work.', 'STORAGE_LIMIT');
}
const releaseStorage = (teacherId, totalMB) => totalMB > 0
  ? User.updateOne({ _id: teacherId }, [{ $set: { 'usage.storageMB': { $max: [0, { $subtract: [{ $ifNull: ['$usage.storageMB', 0] }, totalMB] }] } } }], { updatePipeline: true })
  : null;

async function discardTemporaryUploads(req) {
  await Promise.all((req.files || []).map(file => file.path ? fs.unlink(file.path).catch(() => {}) : null));
  req.files = [];
}

async function deleteStoredFiles(fileDocs) {
  if (!fileDocs.length) return;
  const { safeUploadPath } = require('./submissionRemoval.service');
  await File.deleteMany({ _id: { $in: fileDocs.map(file => file._id) } });
  await Promise.all(fileDocs.map(file => {
    const absolute = safeUploadPath(file.path);      // only ever inside the uploads root
    return absolute ? fs.unlink(absolute).catch(() => {}) : null;
  }));
}

/** $set the defined analysis-reset fields and $unset the undefined ones (pendingAnalysisState uses undefined to clear). */
function analysisReset(ocrJobId, now) {
  const $set = {}, $unset = {};
  for (const [key, value] of Object.entries(pendingAnalysisState({ ocrJobId, now }))) {
    if (value === undefined) $unset[key] = 1; else $set[key] = value;
  }
  return { $set, $unset };
}

/**
 * Saves one student's pages. `req` carries the multer files (already type- and signature-checked by the route). Returns
 * { item, duplicate } where duplicate means a retried request answered with the submission it already created.
 */
async function save({ req, teacher, assignmentId }) {
  const body = req.body || {};
  let committed = false, storageMB = 0, persisted = [];
  try {
    const ctx = await ownedContext(teacher._id, assignmentId);
    const key = access.hash(input.requestKey(body.requestKey));
    const batchId = input.batchId(body.batchId);
    let mode = input.mode(body.mode);
    const [row] = input.validateStudents([{ name: body.name, email: body.email }]);
    if (row.errors) throw fail(400, row.errors.name || row.errors.email, 'TEACHER_UPLOAD_STUDENT_INVALID', row.errors);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) throw fail(400, 'Add at least one image of the student\'s pages.', 'TEACHER_UPLOAD_NO_FILES');
    if (files.length > MAX_PAGES_PER_STUDENT) throw fail(400, `Add up to ${MAX_PAGES_PER_STUDENT} images per student.`, 'TEACHER_UPLOAD_TOO_MANY_FILES');
    const contentHash = await require('../controllers/submission.controller').fileContentIdentity(req);
    const sendEmail = body.send === true || body.send === 'true';

    const replay = async () => {
      const prior = await Submission.findOne({ assignment: ctx.assignment._id, 'teacherUpload.requestKey': key }).select('+teacherUpload').lean();
      if (!prior) return null;
      if (prior.teacherUpload.contentHash !== contentHash)
        throw fail(409, 'This upload reference was already used for different pages. Please try again.', 'TEACHER_UPLOAD_KEY_REUSED');
      return { item: await itemFor(prior._id, teacher._id), duplicate: true };
    };
    const retried = await replay();
    if (retried) { await discardTemporaryUploads(req); return retried; }

    return await withTeacherLease(teacher._id, async () => {
      const raced = await replay();                       // a parallel retry may have committed while this one waited
      if (raced) { await discardTemporaryUploads(req); return raced; }
      const match = await matchStudent(ctx, row.email);
      const existing = await existingFor(ctx, match, row.email);
      if (existing && !existing.teacherUpload)
        throw fail(409, 'This student already submitted their own work for this assignment.', 'STUDENT_ALREADY_SUBMITTED');
      if (existing && mode === 'new')
        throw fail(409, 'Work for this student is already uploaded. Choose whether to replace the pages or add to them.', 'TEACHER_UPLOAD_EXISTS',
          { submissionId: String(existing._id), pages: (existing.files || []).length });
      if (!existing) mode = 'new';
      if (mode === 'add_pages' && (existing.files || []).length + files.length > MAX_PAGES_PER_STUDENT)
        throw fail(400, `A student can have up to ${MAX_PAGES_PER_STUDENT} pages.`, 'TEACHER_UPLOAD_TOO_MANY_FILES');
      // Re-marking work whose marking has not been charged yet needs no extra credit (it is already counted as reserved).
      const needsCredit = !(existing && PENDING_CHARGE.includes(existing.assessmentStatus));
      if (needsCredit) {
        const credits = await creditSummary(teacher, ctx);
        if (credits.available < 1)
          throw fail(402, 'You have no assessment credits left. Add credits to upload more work.', 'INSUFFICIENT_CREDITS', { available: 0 });
      }
      storageMB = files.reduce((sum, file) => sum + bytesToMB(file.size), 0);
      await reserveStorage(teacher, storageMB);
      req.uploadOwner = { _id: teacher._id, role: 'teacher' };
      const stored = await require('../controllers/submission.controller').persistUploadedFiles(req, 'submissions', file => persisted.push(file));
      if (stored.error) throw fail(stored.error.statusCode || 400, stored.error.message, 'TEACHER_UPLOAD_STORE_FAILED');

      const now = new Date(), ocrJobId = new mongoose.Types.ObjectId().toString();
      const emailState = sendEmail ? { status: 'queued', requestedAt: now, attempts: 0 } : { status: 'none', attempts: 0 };
      let submissionId, replacedFiles = [];
      if (mode === 'new') {
        submissionId = new mongoose.Types.ObjectId();
        await Submission.create({ _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id,
          ...(match.kind === 'member' ? { submissionMode: 'registered', student: match.userId }
            : { submissionMode: 'guest', guest: { displayName: row.name, normalizedEmail: row.email } }),
          files: persisted.map(file => file._id), file: persisted[0]._id,
          fileOrder: persisted.map((file, order) => ({ fileId: file._id, order })),
          fileUrls: stored.urls, fileUrl: stored.urls[0], fileContentIdentity: contentHash,
          // The teacher hands in work the class did; it is never marked late.
          submittedAt: now, status: 'submitted', isLate: false,
          teacherUpload: { uploadedBy: teacher._id, batchId, requestKey: key, contentHash, uploadedAt: now, typedName: row.name, email: emailState },
          ...pendingAnalysisState({ ocrJobId, now }) });
      } else {
        const current = await Submission.findOne({ _id: existing._id }).select('files fileOrder fileUrls').lean();
        const keep = mode === 'add_pages' ? current.files || [] : [];
        const keepUrls = mode === 'add_pages' ? current.fileUrls || [] : [];
        const fileIds = [...keep, ...persisted.map(file => file._id)], urls = [...keepUrls, ...stored.urls];
        const reset = analysisReset(ocrJobId, now);
        const updated = await Submission.updateOne({ _id: existing._id, 'teacherUpload.uploadedBy': teacher._id }, {
          $set: { ...reset.$set, files: fileIds, file: fileIds[0], fileOrder: fileIds.map((fileId, order) => ({ fileId, order })),
            fileUrls: urls, fileUrl: urls[0], fileContentIdentity: contentHash, submittedAt: now,
            'teacherUpload.batchId': batchId, 'teacherUpload.requestKey': key, 'teacherUpload.contentHash': contentHash, 'teacherUpload.typedName': row.name,
            'teacherUpload.uploadedAt': now, ...((sendEmail && EMAIL_STATUSES_TO_QUEUE.includes(existing.teacherUpload.email?.status))
              || existing.teacherUpload.email?.status === 'held'   // held for failed marking: sent once the new marking succeeds
              ? { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': now } : {}) },
          ...(Object.keys(reset.$unset).length ? { $unset: reset.$unset } : {}) });
        if (!updated.matchedCount) throw fail(409, 'This student\'s work changed while saving. Please try again.', 'TEACHER_UPLOAD_CHANGED');
        submissionId = existing._id;
        if (mode === 'replace') replacedFiles = await File.find({ _id: { $in: current.files || [] } }).select('_id path sizeBytes').lean();
      }
      committed = true;
      req.files = [];
      if (replacedFiles.length) {
        await deleteStoredFiles(replacedFiles).catch(error => logger.warn({ event: 'teacher_upload_replaced_files_cleanup_failed', code: error.code }));
        await releaseStorage(teacher._id, replacedFiles.reduce((sum, file) => sum + bytesToMB(file.sizeBytes || 0), 0));
      }
      scheduleSubmissionAnalysis(submissionId, ocrJobId);
      logger.info({ event: 'teacher_upload_saved', mode, pages: persisted.length, account: match.kind });
      logTransition(submissionId, 'uploaded', null, mode);
      return { item: await itemFor(submissionId, teacher._id), duplicate: false };
    });
  } catch (error) {
    if (!committed) {
      await discardTemporaryUploads(req);
      if (persisted.length) await deleteStoredFiles(persisted).catch(() => {});
      if (storageMB > 0 && error.code !== 'STORAGE_LIMIT') await releaseStorage(teacher._id, storageMB);
      if (error.code === 11000) throw fail(409, 'This upload was already saved.', 'TEACHER_UPLOAD_DUPLICATE');
    }
    throw error;
  }
}

/**
 * Teacher-facing status of one upload. Every stored state maps to one of these, so nothing is ever shown as "processing" for good:
 *   uploaded        saved, waiting for the marking run to pick it up
 *   reading         a run is reading the handwriting (OCR)
 *   processing      read; corrections and marking are running
 *   waiting_credits marking stopped because there were no assessment credits (Retry marking once there are)
 *   marked          finished
 *   failed          marking stopped with a reason code (Retry marking)
 */
function statusOf(doc) {
  if (doc.assessmentStatus === 'complete') return 'marked';
  if (doc.assessmentStatus === 'failed') return 'failed';
  if (doc.evaluationStatus === 'blocked') return doc.evaluationErrorCode === CREDIT_BLOCK ? 'waiting_credits' : 'failed';
  if (doc.ocrStatus === 'pending' || doc.ocrStatus === 'processing') return doc.analysisLeaseOwner ? 'reading' : 'uploaded';
  return 'processing';
}
/** The reason code shown with a stopped upload (a code, never provider text). */
function failureCodeOf(doc) {
  const status = statusOf(doc);
  if (status === 'waiting_credits') return CREDIT_BLOCK;
  if (status !== 'failed') return null;
  const code = doc.assessmentStatus === 'failed' ? doc.assessmentErrorCode : doc.evaluationErrorCode;
  return String(code || 'ASSESSMENT_FAILED').slice(0, 64);
}
/** One line per status change: ids, status and codes only (no names, emails, text or provider details). */
function logTransition(submissionId, status, code, reason) {
  logger.info({ event: 'teacher_upload_status', submissionId: String(submissionId), status,
    ...(code ? { code: String(code).slice(0, 64) } : {}), ...(reason ? { reason: String(reason).slice(0, 32) } : {}) });
}
/** Logs the current status of a teacher upload after a marking run or a watchdog decision. Never throws. */
async function logCurrentStatus(submissionId, reason) {
  try {
    const doc = await Submission.findOne({ _id: submissionId, 'teacherUpload.uploadedBy': { $exists: true } })
      .select('_id ocrStatus assessmentStatus assessmentErrorCode evaluationStatus evaluationErrorCode analysisLeaseOwner').lean();
    if (doc) logTransition(doc._id, statusOf(doc), failureCodeOf(doc), reason);
  } catch { /* logging must never change the outcome */ }
}
const LIST_FIELDS = '+teacherUpload +guest.normalizedEmail _id submissionMode student guest.displayName files ocrStatus assessmentStatus assessmentErrorCode evaluationStatus evaluationErrorCode analysisLeaseOwner createdAt';
function dto(doc) {
  const email = doc.teacherUpload?.email || {};
  const failureCode = failureCodeOf(doc);
  // The name and email the teacher typed (a member's email is the account email the typed address matched).
  return { submissionId: String(doc._id), name: doc.teacherUpload?.typedName || (doc.submissionMode === 'guest' ? doc.guest?.displayName : doc.student?.displayName || ''),
    email: doc.submissionMode === 'guest' ? doc.guest?.normalizedEmail : doc.student?.email || '',
    account: doc.submissionMode === 'guest' ? 'guest' : 'member', uploadedByTeacher: true, pages: (doc.files || []).length,
    status: statusOf(doc), ...(failureCode ? { failureCode } : {}),
    emailStatus: email.status || 'none', emailSentAt: email.sentAt || null, emailFailedAt: email.failedAt || null,
    // Only this one reason is shown: the server stopped mid-send, so the email may already have arrived (Resend may duplicate it).
    emailDeliveryUncertain: email.status === 'failed' && email.lastErrorCode === 'DELIVERY_UNCERTAIN',
    uploadedAt: doc.teacherUpload?.uploadedAt || doc.createdAt };
}
async function itemFor(submissionId, teacherId) {
  const doc = await Submission.findOne({ _id: submissionId, 'teacherUpload.uploadedBy': teacherId }).select(LIST_FIELDS)
    .populate('student', 'displayName email').lean();
  if (!doc) throw notFound();
  return dto(doc);
}

async function list({ teacher, assignmentId }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  const docs = await Submission.find({ assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id })
    .select(LIST_FIELDS).populate('student', 'displayName email').sort({ createdAt: -1 }).lean();
  return { items: docs.map(dto), credits: await creditSummary(teacher, ctx) };
}

/** Queues the feedback email for one upload. Idempotent: only none/failed move to queued; anything else is answered as-is.
 *  Work whose marking failed is refused: there is no feedback to send until "Retry marking" succeeds.
 *  An email already sent is sent again only on an explicit Resend (resend: true with a request id), at most once a minute;
 *  the same request id again changes nothing. */
async function requestSend({ teacher, assignmentId, submissionId, resend = false, requestId = null, now = new Date() }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  if (!mongoose.isValidObjectId(submissionId)) throw notFound();
  const owned = { _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id };
  if (await Submission.exists({ ...owned, assessmentStatus: 'failed' }))
    throw fail(409, 'Marking failed, so there is no feedback to email yet. Retry marking first.', 'TEACHER_UPLOAD_MARKING_FAILED');
  if (resend === true) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw fail(400, 'A valid request id is required.', 'TEACHER_UPLOAD_INVALID_REQUEST');
    const again = await Submission.updateOne({ ...owned, assessmentStatus: { $ne: 'failed' }, 'teacherUpload.email.status': 'sent',
      'teacherUpload.email.resendRequestId': { $ne: requestId }, 'teacherUpload.email.sentAt': { $lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) } }, {
      $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': now, 'teacherUpload.email.attempts': 0,
        'teacherUpload.email.resendRequestId': requestId },
      $unset: { 'teacherUpload.email.nextAttemptAt': 1, 'teacherUpload.email.failedAt': 1, 'teacherUpload.email.lastErrorCode': 1 } });
    if (again.modifiedCount) {
      logger.info({ event: 'teacher_upload_email_resend_requested', submissionId: String(submissionId), teacherId: String(teacher._id) });
      return { item: await itemFor(submissionId, teacher._id), alreadyRequested: false };
    }
    const current = await Submission.findOne(owned).select('+teacherUpload').lean();
    if (!current) throw notFound();
    const state = current.teacherUpload?.email || {};
    if (state.resendRequestId === requestId || state.status !== 'sent') {
      // The same click again, or the email is already on its way (queued or sending): nothing new.
      if (state.resendRequestId === requestId || ['queued', 'sending'].includes(state.status)) return { item: await itemFor(submissionId, teacher._id), alreadyRequested: true };
    } else {
      const waitMs = new Date(state.sentAt).getTime() + RESEND_COOLDOWN_MS - now.getTime();
      if (waitMs > 0) throw fail(429, 'The email was just sent. Wait a minute before sending it again.', 'TEACHER_UPLOAD_RESEND_COOLDOWN',
        { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }
  const queued = await Submission.updateOne({ ...owned, assessmentStatus: { $ne: 'failed' }, 'teacherUpload.email.status': { $in: EMAIL_STATUSES_TO_QUEUE } }, {
    // A Resend starts over: a fresh attempt count, no pending backoff.
    $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': new Date(), 'teacherUpload.email.attempts': 0 },
    $unset: { 'teacherUpload.email.nextAttemptAt': 1, 'teacherUpload.email.failedAt': 1, 'teacherUpload.email.lastErrorCode': 1 } });
  if (!queued.matchedCount && !await Submission.exists(owned)) throw notFound();
  return { item: await itemFor(submissionId, teacher._id), alreadyRequested: !queued.modifiedCount };
}

const exactSourceMode = () => require('./hybridSource/contract').mode() === 'gpt_vision_exact';
/** The handwriting-check owner, exactly as the student and guest flows bind it: the member's id, or the guest's hashed email. */
const sourceOwner = (member, email) => member ? String(member) : `guest:${require('./gptVisionExact/contract').sha(email)}`;
async function fullAssignment(id) {
  // The check is bound to the assignment text (the reader's reference), so it needs the whole assignment, as OCR loads it.
  const assignment = await Assignment.findById(id).lean();
  if (!assignment) throw notFound();
  return assignment;
}

/**
 * The handwriting-check context for one student's pages (used by the page check and by the save): the same binding the student
 * flow uses, with this teacher as the uploader and the student (member id or hashed guest email) as the owner. 404 unless this
 * teacher owns the assignment; the student's details are validated as the save validates them.
 */
async function sourceFor({ teacher, assignmentId, body }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  const [row] = input.validateStudents([{ name: body?.name, email: body?.email }]);
  if (row.errors) throw fail(400, row.errors.name || row.errors.email, 'TEACHER_UPLOAD_STUDENT_INVALID', row.errors);
  const match = await matchStudent(ctx, row.email);
  return { assignment: await fullAssignment(ctx.assignment._id), ownerId: sourceOwner(match.kind === 'member' && match.userId, row.email),
    uploaderId: String(teacher._id) };
}

/**
 * Restartable: not complete and no run holding it, and either stopped (failed, or blocked e.g. for credits) or quiet for the grace
 * period (an unfinished state nothing has touched for a while is stalled; a recent one is still on its way, e.g. a fresh dispatch).
 */
function restartableQuery(now) {
  return { assessmentStatus: { $ne: 'complete' }, $and: [
    { $or: [{ analysisLeaseExpiresAt: { $exists: false } }, { analysisLeaseExpiresAt: null }, { analysisLeaseExpiresAt: { $lte: now } }] },
    { $or: [{ assessmentStatus: 'failed' }, { evaluationStatus: 'blocked' }, { updatedAt: { $lte: new Date(now.getTime() - RESTART_GRACE_MS) } }] }] };
}

/**
 * "Retry marking" for an upload in ANY state that is not finished: failed, waiting for credits, or stalled (uploaded, reading or
 * marking with no run holding it). A run that is live, or was (re)started moments ago, is left alone (alreadyRequested), so a
 * double click or a retry during a run never restarts twice. Needs one credit, counted once: work still waiting to be charged
 * already holds its own reservation. Credits are only charged when marking succeeds, once per run, by the normal pipeline.
 * Pages saved without a handwriting check (uploads made before the check existed) are checked now, from the stored files.
 * A held email goes back to the queue and is sent once, after marking succeeds.
 */
async function retryMarking({ teacher, assignmentId, submissionId }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  if (!mongoose.isValidObjectId(submissionId)) throw notFound();
  const owned = { _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id };
  const doc = await Submission.findOne(owned).select('+teacherUpload +guest.normalizedEmail _id student submissionMode files assessmentStatus').lean();
  if (!doc) throw notFound();
  const already = async () => ({ item: await itemFor(submissionId, teacher._id), alreadyRequested: true });
  if (!await Submission.exists({ ...owned, ...restartableQuery(new Date()) })) return already();
  const noCredit = () => fail(402, 'You have no assessment credits left. Add credits to retry marking.', 'INSUFFICIENT_CREDITS', { available: 0 });
  const enoughCredit = async () => {
    const credits = await creditSummary(teacher, ctx);
    const selfReserved = await Submission.exists({ ...owned, assessmentStatus: { $in: PENDING_CHARGE } });
    return credits.wallet - (credits.reserved - (selfReserved ? 1 : 0)) >= 1;
  };
  if (!await enoughCredit()) throw noCredit();

  if (exactSourceMode()) {
    // The check reuses accepted evidence for pages already read, so only pages that were never checked cost a read.
    const source = require('./gptVisionExact/preflight');
    const { safeUploadPath } = require('./submissionRemoval.service');
    const context = { assignment: await fullAssignment(ctx.assignment._id), uploaderId: String(teacher._id),
      ownerId: sourceOwner(doc.submissionMode !== 'guest' && doc.student, doc.guest?.normalizedEmail) };
    const files = await File.find({ _id: { $in: doc.files || [] } }).select('_id path uploadedBy').lean();
    if (files.length !== (doc.files || []).length) throw fail(409, 'A page of this work is unavailable. Upload the pages again.', 'TEACHER_UPLOAD_FILE_UNAVAILABLE');
    for (const file of files) {
      const absolute = safeUploadPath(file.path);
      if (!absolute || String(file.uploadedBy) !== String(teacher._id))
        throw fail(409, 'A page of this work is unavailable. Upload the pages again.', 'TEACHER_UPLOAD_FILE_UNAVAILABLE');
      let proof;
      try { proof = await source.checkPages(await source.pagesFor({ path: absolute }), context, { run: true }); }
      catch (error) {
        const state = source.ui(error);
        throw fail(state.sourceReadStatus === 'FAILED_IMAGE' ? 422 : 503, state.message, state.sourceReadErrorCode);
      }
      await File.updateOne({ _id: file._id }, { $set: { gptSourcePreflight: proof } });
    }
  }

  return withTeacherLease(teacher._id, async () => {
    if (!await enoughCredit()) throw noCredit();   // re-checked under the lease: parallel retries cannot overspend
    const now = new Date(), ocrJobId = new mongoose.Types.ObjectId().toString(), reset = analysisReset(ocrJobId, now);
    // Atomic: only one of two parallel retries matches; a run that started meanwhile keeps its lease and is not restarted.
    const restarted = await Submission.updateOne({ ...owned, ...restartableQuery(now) },
      { $set: reset.$set, ...(Object.keys(reset.$unset).length ? { $unset: reset.$unset } : {}) });
    if (!restarted.modifiedCount) return already();
    await Submission.updateOne({ ...owned, 'teacherUpload.email.status': 'held' },
      { $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': now }, $unset: { 'teacherUpload.email.nextAttemptAt': 1 } });
    scheduleSubmissionAnalysis(submissionId, ocrJobId);
    logger.info({ event: 'teacher_upload_marking_retried' });
    logTransition(submissionId, 'uploaded', null, 'retry');
    return { item: await itemFor(submissionId, teacher._id), alreadyRequested: false };
  });
}

module.exports = { MAX_PAGES_PER_STUDENT, RESEND_COOLDOWN_MS, ownedContext, creditSummary, check, save, list, requestSend, retryMarking, sourceFor, statusOf,
  failureCodeOf, logTransition, logCurrentStatus, CREDIT_BLOCK };
