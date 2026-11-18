'use strict';
// Stage 9: a teacher uploads a RECORDING for a student on one of their own speaking assignments. It mirrors the essay teacher upload
// (teacherUpload.service.js, unchanged) wherever the two can behave the same:
// - the same student identities: a typed name and email; an active class member gets a registered submission, anyone else a guest one;
// - the same idempotency (the client's request key, hashed, plus a content hash: the recording's SHA-256), the same per-teacher database lease
//   (shared with the essay uploads, so credits are checked and reserved atomically across both), the same credit rule: one credit available
//   net of uploads saved but not yet charged, checked at upload, before anything is kept and so before any speech-to-text is spent;
// - the same email states (none/queued/sending/sent/failed/held) and "Save and send" semantics: the feedback email is sent by the essay email
//   worker once marking is complete (assessmentStatus 'complete'); work that ends without a result holds its email;
// - the same teacher-facing statuses (uploaded, reading, processing, waiting_credits, marked, failed) plus not_marked (the recording could not
//   be marked: not enough speech, not English, unintelligible, too long); codes only, never provider text.
// Speaking-specific: the recording, its file, its storage and its speech-to-text minutes belong to the teacher; one recording per student
// (new or replace; there are no pages to add). A guest is emailed a private link to the guest speaking page (stage 10), as an essay guest is.
const mongoose = require('mongoose');
const Assignment = require('../../models/assignment.model');
const Class = require('../../models/class.model');
const User = require('../../models/user.model');
const Membership = require('../../models/membership.model');
const Submission = require('../../models/Submission');
const AudioRecording = require('../../models/AudioRecording');
const File = require('../../models/File');
const access = require('../guestAccess.service');
const input = require('../teacherUploadInput.service');
const teacherUploads = require('../teacherUpload.service');
const { withActiveStatus } = require('../classLifecycle.service');
const speakingSubmission = require('./speakingSubmission.service');
const processing = require('./processing');
const logger = require('../../utils/logger');

const CREDIT_BLOCK = 'INSUFFICIENT_ASSESSMENT_CREDITS';
const RESERVED_CAP = 1000;
const LIST_CAP = 500;
const EMAIL_STATUSES_TO_QUEUE = ['none', 'failed'];
const RESEND_COOLDOWN_MS = 60 * 1000;
const REQUEST_ID = /^[a-f0-9-]{36}$/i;
const NO_RESULT = 'This recording has no feedback yet, so there is nothing to email. Retry it first, or upload a new recording.';

function fail(statusCode, message, code, details) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}
const notFound = () => fail(404, 'Assignment not found.', 'NOT_FOUND');
const notAssessable = () => require('./speakingAssessment.service').NOT_CHARGEABLE;

/** The speaking assignment and its active class, only when this teacher owns both; 404 otherwise (never reveals that it exists). */
async function ownedContext(teacherId, assignmentId) {
  if (!mongoose.isValidObjectId(assignmentId)) throw notFound();
  const assignment = await Assignment.findOne({ _id: assignmentId, teacher: teacherId, isActive: true })
    .select('_id title class teacher deadline resourceType speaking').lean();
  if (!assignment) throw notFound();
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: teacherId, isActive: true })).select('_id teacher institutionId').lean();
  if (!classDoc) throw notFound();
  if (assignment.resourceType !== 'speaking') throw fail(400, 'Recordings can only be uploaded for speaking assignments.', 'TEACHER_UPLOAD_NOT_SPEAKING');
  return { assignment, classDoc };
}

/** As the essay flow: a class member gets a registered submission; any other address (with or without an account elsewhere) a guest one. */
async function matchStudent(ctx, email) {
  const user = await User.findOne({ email, role: 'student' }).select('_id').lean();
  if (user && await Membership.exists({ student: user._id, class: ctx.classDoc._id, status: 'active' })) return { kind: 'member', userId: user._id };
  return { kind: 'guest' };
}

const EXISTING_FIELDS = '+teacherUpload +audioRecording _id sourceKind submissionMode evaluationStatus evaluationErrorCode assessmentStatus feedback';
async function existingFor(ctx, match, email) {
  const query = match.kind === 'member'
    ? { assignment: ctx.assignment._id, student: match.userId }
    : { assignment: ctx.assignment._id, submissionMode: 'guest', 'guest.normalizedEmail': email, 'teacherUpload.uploadedBy': { $exists: true } };
  return Submission.findOne(query).select(EXISTING_FIELDS).lean();
}

// ---- Credits ------------------------------------------------------------------------------------------------------------------------------
/** Not yet charged and not yet started: no marking run yet (the essay reservation counts runs in progress), no final state, and the recording
 *  is still on its way. Each one will need a credit when it is marked. */
const NOT_STARTED = { assessmentStatus: { $exists: false }, evaluationStatus: { $nin: ['completed', 'partial', 'failed', 'blocked'] } };
async function speakingReserved(teacherId, { except = null } = {}) {
  const pending = await Submission.find({ 'teacherUpload.uploadedBy': teacherId, sourceKind: 'audio', ...NOT_STARTED, ...(except ? { _id: { $ne: except } } : {}) })
    .select('+audioRecording _id').limit(RESERVED_CAP).lean();
  if (pending.length >= RESERVED_CAP) logger.warn({ event: 'speaking_teacher_upload_reserved_capped', cap: RESERVED_CAP });
  const ids = pending.map(s => s.audioRecording).filter(Boolean);
  return ids.length ? AudioRecording.countDocuments({ _id: { $in: ids }, status: { $nin: ['failed', 'cancelled'] } }) : 0;
}
/** The essay credit summary (wallet or institution share, minus essay and speaking runs in progress) minus the speaking uploads not yet started. */
async function creditSummary(teacher, ctx, options) {
  const essay = await teacherUploads.creditSummary(teacher, ctx);
  const extra = await speakingReserved(teacher._id, options);
  return { available: Math.max(0, essay.available - extra), reserved: essay.reserved + extra, wallet: essay.wallet };
}
/** Whether this upload already holds a reservation (re-saving it needs no extra credit, as in the essay flow). */
async function isReserved(doc) {
  if (['started', 'processing'].includes(doc.assessmentStatus)) return true;
  if (doc.assessmentStatus || ['completed', 'partial', 'failed', 'blocked'].includes(doc.evaluationStatus)) return false;
  return Boolean(doc.audioRecording && await AudioRecording.exists({ _id: doc.audioRecording, status: { $nin: ['failed', 'cancelled'] } }));
}

// ---- Status -------------------------------------------------------------------------------------------------------------------------------
/** The essay status names for a speaking upload (reading = turning the recording into text), plus not_marked. */
function statusOf(doc, recording) {
  const code = value => String(value || '').slice(0, 64) || null;
  if (!recording || ['uploaded', 'queued'].includes(recording.status)) return { status: 'uploaded' };
  if (recording.status === 'transcribing') return { status: 'reading' };
  if (['failed', 'cancelled'].includes(recording.status)) return { status: 'failed', failureCode: code(recording.lastErrorCode) || 'AUDIO_TRANSCRIPTION_FAILED' };
  if (['completed', 'partial'].includes(doc.evaluationStatus) || doc.assessmentStatus === 'complete') return { status: 'marked' };
  if (doc.evaluationStatus === 'blocked') return doc.evaluationErrorCode === CREDIT_BLOCK ? { status: 'waiting_credits', failureCode: CREDIT_BLOCK }
    : { status: 'failed', failureCode: code(doc.evaluationErrorCode) || 'ASSESSMENT_FAILED' };
  if (doc.evaluationStatus === 'failed') return notAssessable().has(doc.evaluationErrorCode)
    ? { status: 'not_marked', failureCode: code(doc.evaluationErrorCode) } : { status: 'failed', failureCode: code(doc.evaluationErrorCode) || 'ASSESSMENT_FAILED' };
  if (doc.assessmentStatus === 'failed') return { status: 'failed', failureCode: code(doc.assessmentErrorCode) || 'ASSESSMENT_FAILED' };
  return { status: 'processing' };
}

const LIST_FIELDS = '+teacherUpload +guest.normalizedEmail +audioRecording _id submissionMode student guest.displayName evaluationStatus evaluationErrorCode assessmentStatus assessmentErrorCode createdAt';
function dto(doc, recording) {
  const email = doc.teacherUpload?.email || {};
  const { status, failureCode } = statusOf(doc, recording);
  return { submissionId: String(doc._id), kind: 'speaking',
    name: doc.teacherUpload?.typedName || (doc.submissionMode === 'guest' ? doc.guest?.displayName : doc.student?.displayName || ''),
    email: doc.submissionMode === 'guest' ? doc.guest?.normalizedEmail : doc.student?.email || '',
    account: doc.submissionMode === 'guest' ? 'guest' : 'member', uploadedByTeacher: true, pages: 1, status, ...(failureCode ? { failureCode } : {}),
    emailStatus: email.status || 'none', emailSentAt: email.sentAt || null, emailFailedAt: email.failedAt || null,
    emailDeliveryUncertain: email.status === 'failed' && email.lastErrorCode === 'DELIVERY_UNCERTAIN',
    uploadedAt: doc.teacherUpload?.uploadedAt || doc.createdAt };
}
async function recordingsFor(docs) {
  const ids = docs.map(d => d.audioRecording).filter(Boolean);
  const list = ids.length ? await AudioRecording.find({ _id: { $in: ids } }).select('_id status lastErrorCode').lean() : [];
  return new Map(list.map(r => [String(r._id), r]));
}
async function itemFor(submissionId, teacherId) {
  const doc = await Submission.findOne({ _id: submissionId, 'teacherUpload.uploadedBy': teacherId, sourceKind: 'audio' }).select(LIST_FIELDS)
    .populate('student', 'displayName email').lean();
  if (!doc) throw notFound();
  return dto(doc, (await recordingsFor([doc])).get(String(doc.audioRecording)));
}

// ---- Check and list -----------------------------------------------------------------------------------------------------------------------
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
      row.errors = { email: 'This student already submitted their own recording for this assignment. Open it from the submissions list.' };
      continue;
    }
    row.existing = { submissionId: String(existing._id), pages: 1 };
  }
  const credits = await creditSummary(teacher, ctx);
  return { students: rows, credits: { needed: rows.filter(row => !row.errors).length, available: credits.available } };
}

/** Every recording this teacher uploaded for this assignment, newest first (sorted here, not in the database; capped and logged). */
async function list({ teacher, assignmentId }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  const docs = await Submission.find({ assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id, sourceKind: 'audio' })
    .select(LIST_FIELDS).populate('student', 'displayName email').limit(LIST_CAP + 1).lean();
  if (docs.length > LIST_CAP) logger.warn({ event: 'speaking_teacher_upload_list_capped', cap: LIST_CAP });
  const recordings = await recordingsFor(docs);
  const items = docs.slice(0, LIST_CAP).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(doc => dto(doc, recordings.get(String(doc.audioRecording))));
  return { items, credits: await creditSummary(teacher, ctx) };
}

// ---- Save ---------------------------------------------------------------------------------------------------------------------------------
/** Before the file is read: the assignment is this teacher's, and their speech-to-text minutes allow at least the shortest recording. */
async function prepare({ teacher, assignmentId }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  if (!await speakingSubmission.teacherHasMinutes(ctx.assignment.teacher)) {
    logger.metric({ event: 'audio_upload_minutes_unavailable', assignmentId: String(ctx.assignment._id) });
    throw fail(429, speakingSubmission.UNAVAILABLE_MESSAGE, 'AUDIO_UPLOADS_UNAVAILABLE');
  }
  return ctx;
}

/**
 * Saves one student's recording (req.audioUpload: already type-, size- and duration-checked by the upload middleware). Returns { item, duplicate }
 * where duplicate means a retried request answered with the submission it already created. Nothing is kept on any refusal.
 */
async function save({ req, teacher, ctx, now = () => new Date() }) {
  const body = req.body || {};
  const upload = req.audioUpload;
  const key = access.hash(input.requestKey(body.requestKey));
  const batchId = input.batchId(body.batchId);
  let mode = input.mode(body.mode);
  if (mode === 'add_pages') throw fail(400, 'A speaking submission has one recording. Choose to replace it instead.', 'TEACHER_UPLOAD_MODE_INVALID');
  const [row] = input.validateStudents([{ name: body.name, email: body.email }]);
  if (row.errors) throw fail(400, row.errors.name || row.errors.email, 'TEACHER_UPLOAD_STUDENT_INVALID', row.errors);
  const sendEmail = body.send === true || body.send === 'true';
  const contentHash = upload.sha256;

  const replay = async () => {
    const prior = await Submission.findOne({ assignment: ctx.assignment._id, 'teacherUpload.requestKey': key }).select('+teacherUpload').lean();
    if (!prior) return null;
    if (prior.teacherUpload.contentHash !== contentHash)
      throw fail(409, 'This upload reference was already used for a different recording. Please try again.', 'TEACHER_UPLOAD_KEY_REUSED');
    return { item: await itemFor(prior._id, teacher._id), duplicate: true };
  };
  const retried = await replay();
  if (retried) return retried;

  return teacherUploads.withTeacherLease(teacher._id, async () => {
    const raced = await replay();
    if (raced) return raced;
    const match = await matchStudent(ctx, row.email);
    const existing = await existingFor(ctx, match, row.email);
    if (existing && (!existing.teacherUpload || existing.sourceKind !== 'audio'))
      throw fail(409, 'This student already submitted their own recording for this assignment.', 'STUDENT_ALREADY_SUBMITTED');
    if (existing && mode === 'new')
      throw fail(409, 'A recording for this student is already uploaded. Choose whether to replace it.', 'TEACHER_UPLOAD_EXISTS',
        { submissionId: String(existing._id), pages: 1 });
    if (!existing) mode = 'new';
    if (!(existing && await isReserved(existing))) {
      const credits = await creditSummary(teacher, ctx);
      if (credits.available < 1) throw fail(402, 'You have no assessment credits left. Add credits to upload more recordings.', 'INSUFFICIENT_CREDITS', { available: 0 });
    }

    const megabytes = speakingSubmission.storageMBFor(upload.sizeBytes);
    await speakingSubmission.reserveStorage(teacher, megabytes);
    const undo = [() => speakingSubmission.releaseStorage(teacher._id, megabytes)];
    try {
      const file = await File.create({ originalName: `recording${upload.extension}`, filename: upload.filename, path: upload.storedPath,
        url: `internal:audio/${upload.filename}`, uploadedBy: teacher._id, role: 'teacher', type: 'audio', sizeBytes: upload.sizeBytes });
      undo.push(() => File.deleteOne({ _id: file._id }));
      let recording;
      try {
        recording = await AudioRecording.create({ owner: teacher._id, requestId: key.slice(0, 64), audioFileId: file._id, contentType: upload.contentType,
          sizeBytes: upload.sizeBytes, durationSeconds: upload.durationSeconds, audioSha256: upload.sha256, storageChargedTo: teacher._id, storageChargedMB: megabytes,
          minutesChargedTo: ctx.assignment.teacher, institutionId: ctx.classDoc.institutionId || null, status: 'uploaded' });
      } catch (error) {
        if (error?.code === 11000) throw fail(409, 'This upload was already saved.', 'TEACHER_UPLOAD_DUPLICATE');
        throw error;
      }
      undo.push(() => AudioRecording.deleteOne({ _id: recording._id }));
      await processing.enqueue(recording._id, { now });

      const at = now();
      const emailState = sendEmail ? { status: 'queued', requestedAt: at, attempts: 0 } : { status: 'none', attempts: 0 };
      let submissionId;
      if (mode === 'new') {
        submissionId = new mongoose.Types.ObjectId();
        try {
          await Submission.create({ _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id, sourceKind: 'audio', audioRecording: recording._id,
            files: [], ...(match.kind === 'member' ? { submissionMode: 'registered', student: match.userId }
              : { submissionMode: 'guest', guest: { displayName: row.name, normalizedEmail: row.email } }),
            // The teacher hands in work the class did; it is never marked late (as in the essay flow).
            submittedAt: at, status: 'submitted', isLate: false,
            teacherUpload: { uploadedBy: teacher._id, batchId, requestKey: key, contentHash, uploadedAt: at, typedName: row.name, email: emailState } });
        } catch (error) {
          if (error?.code === 11000) throw fail(409, 'This upload was already saved.', 'TEACHER_UPLOAD_DUPLICATE');
          throw error;
        }
        undo.push(() => Submission.deleteOne({ _id: submissionId, audioRecording: recording._id }));
      } else {
        const queueEmail = (sendEmail && EMAIL_STATUSES_TO_QUEUE.includes(existing.teacherUpload.email?.status)) || existing.teacherUpload.email?.status === 'held';
        // The new recording starts over: transcription, then marking (one credit), as a new essay upload's analysis does.
        const switched = await Submission.updateOne({ _id: existing._id, audioRecording: existing.audioRecording, 'teacherUpload.uploadedBy': teacher._id }, {
          $set: { audioRecording: recording._id, submittedAt: at, evaluationStatus: 'pending', evaluationErrorCode: null, evaluationError: null,
            'teacherUpload.batchId': batchId, 'teacherUpload.requestKey': key, 'teacherUpload.contentHash': contentHash, 'teacherUpload.typedName': row.name,
            'teacherUpload.uploadedAt': at, ...(queueEmail ? { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': at } : {}) },
          $unset: { assessmentStatus: 1, assessmentErrorCode: 1, assessmentCompletedAt: 1, evaluationJobId: 1 } });
        if (!switched.matchedCount) throw fail(409, 'This student\'s recording changed while saving. Please try again.', 'TEACHER_UPLOAD_CHANGED');
        submissionId = existing._id;
      }
      await AudioRecording.updateOne({ _id: recording._id }, { $set: { submissionId } });
      upload.commit();
      if (mode === 'replace') await speakingSubmission.discardRecording(await speakingSubmission.loadRecording(existing.audioRecording));
      processing.kickAudioWorker();
      logger.info({ event: 'speaking_teacher_upload_saved', submissionId: String(submissionId), mode, account: match.kind, sizeBytes: upload.sizeBytes,
        durationSeconds: Math.round(upload.durationSeconds) });
      return { item: await itemFor(submissionId, teacher._id), duplicate: false };
    } catch (error) {
      for (const step of undo.reverse()) await Promise.resolve().then(step).catch(() => {});
      throw error;
    }
  });
}

// ---- Email --------------------------------------------------------------------------------------------------------------------------------
/** Whether marking ended without feedback to send (the recording failed, could not be marked, or marking failed). */
async function withoutResult(doc) {
  if (doc.evaluationStatus === 'failed' || doc.assessmentStatus === 'failed') return true;
  return Boolean(doc.audioRecording && await AudioRecording.exists({ _id: doc.audioRecording, status: { $in: ['failed', 'cancelled'] } }));
}

/** Send, or Resend: the essay flow's rules (teacherUpload.service requestSend) for a speaking upload, members and guests alike. */
async function requestSend({ teacher, assignmentId, submissionId, resend = false, requestId = null, now = new Date() }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  if (!mongoose.isValidObjectId(submissionId)) throw notFound();
  const owned = { _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id, sourceKind: 'audio' };
  const doc = await Submission.findOne(owned).select('+audioRecording +teacherUpload _id submissionMode evaluationStatus assessmentStatus').lean();
  if (!doc) throw notFound();
  if (await withoutResult(doc)) throw fail(409, NO_RESULT, 'TEACHER_UPLOAD_MARKING_FAILED');
  if (resend === true) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw fail(400, 'A valid request id is required.', 'TEACHER_UPLOAD_INVALID_REQUEST');
    const again = await Submission.updateOne({ ...owned, 'teacherUpload.email.status': 'sent', 'teacherUpload.email.resendRequestId': { $ne: requestId },
      'teacherUpload.email.sentAt': { $lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) } }, {
      $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': now, 'teacherUpload.email.attempts': 0, 'teacherUpload.email.resendRequestId': requestId },
      $unset: { 'teacherUpload.email.nextAttemptAt': 1, 'teacherUpload.email.failedAt': 1, 'teacherUpload.email.lastErrorCode': 1 } });
    if (again.modifiedCount) return { item: await itemFor(submissionId, teacher._id), alreadyRequested: false };
    const state = doc.teacherUpload?.email || {};
    if (state.resendRequestId === requestId || ['queued', 'sending'].includes(state.status)) return { item: await itemFor(submissionId, teacher._id), alreadyRequested: true };
    if (state.status === 'sent') {
      const waitMs = new Date(state.sentAt).getTime() + RESEND_COOLDOWN_MS - now.getTime();
      if (waitMs > 0) throw fail(429, 'The email was just sent. Wait a minute before sending it again.', 'TEACHER_UPLOAD_RESEND_COOLDOWN', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }
  const queued = await Submission.updateOne({ ...owned, 'teacherUpload.email.status': { $in: EMAIL_STATUSES_TO_QUEUE } }, {
    $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': new Date(), 'teacherUpload.email.attempts': 0 },
    $unset: { 'teacherUpload.email.nextAttemptAt': 1, 'teacherUpload.email.failedAt': 1, 'teacherUpload.email.lastErrorCode': 1 } });
  return { item: await itemFor(submissionId, teacher._id), alreadyRequested: !queued.modifiedCount };
}

/** A held email goes back to the queue (after a retry or a new recording): it is sent once, when the new marking succeeds. Never throws. */
async function requeueHeldEmail(submissionId, now = new Date()) {
  try {
    await Submission.updateOne({ _id: submissionId, sourceKind: 'audio', 'teacherUpload.email.status': 'held' },
      { $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.requestedAt': now }, $unset: { 'teacherUpload.email.nextAttemptAt': 1 } });
  } catch (error) {
    logger.warn({ event: 'speaking_teacher_upload_requeue_failed', errorName: String(error?.name || 'Error').slice(0, 60) });
  }
}

/** For the email worker: a queued speaking email whose recording ended without a result is held (the essay worker holds failed marking). */
async function holdEmailsWithoutResult({ limit = 200 } = {}) {
  const held = { $set: { 'teacherUpload.email.status': 'held' }, $unset: { 'teacherUpload.email.nextAttemptAt': 1 } };
  const first = await Submission.updateMany({ 'teacherUpload.email.status': 'queued', sourceKind: 'audio', evaluationStatus: 'failed' }, held);
  const queued = await Submission.find({ 'teacherUpload.email.status': 'queued', sourceKind: 'audio' }).select('+audioRecording _id').limit(limit).lean();
  const ids = queued.map(s => s.audioRecording).filter(Boolean);
  const failed = ids.length ? await AudioRecording.find({ _id: { $in: ids }, status: { $in: ['failed', 'cancelled'] } }).select('_id submissionId').lean() : [];
  const second = failed.length
    ? await Submission.updateMany({ _id: { $in: failed.map(r => r.submissionId).filter(Boolean) }, 'teacherUpload.email.status': 'queued' }, held) : { modifiedCount: 0 };
  const count = first.modifiedCount + second.modifiedCount;
  if (count) logger.info({ event: 'speaking_teacher_upload_email_held', count });
  return count;
}

// ---- Retry --------------------------------------------------------------------------------------------------------------------------------
/**
 * "Retry" for a speaking upload: transcription again when the recording failed, marking again when marking failed or waited for credits.
 * Like the essay retryMarking: needs one credit (charged only when marking succeeds), leaves live work alone (alreadyRequested), and queues a
 * held email again. A recording that could not be marked (not enough speech, not English) cannot be retried: upload a new one.
 */
async function retry({ teacher, assignmentId, submissionId }) {
  const ctx = await ownedContext(teacher._id, assignmentId);
  if (!mongoose.isValidObjectId(submissionId)) throw notFound();
  const owned = { _id: submissionId, assignment: ctx.assignment._id, class: ctx.classDoc._id, 'teacherUpload.uploadedBy': teacher._id, sourceKind: 'audio' };
  const doc = await Submission.findOne(owned).select('+audioRecording _id student assignment class evaluationStatus evaluationErrorCode assessmentStatus').lean();
  if (!doc) throw notFound();
  const recording = await speakingSubmission.loadRecording(doc.audioRecording);
  const already = async () => ({ item: await itemFor(submissionId, teacher._id), alreadyRequested: true });
  const transcriptionFailed = recording && ['failed', 'cancelled'].includes(recording.status);
  const markingStopped = recording?.status === 'ready' && ['failed', 'blocked'].includes(doc.evaluationStatus);
  if (markingStopped && notAssessable().has(doc.evaluationErrorCode))
    throw fail(409, 'This recording could not be marked, so it cannot be retried. Upload a new recording instead.', 'ASSESSMENT_NOT_RETRYABLE');
  if (!transcriptionFailed && !markingStopped) return already();
  const credits = await creditSummary(teacher, ctx, { except: doc._id });
  if (credits.available < 1) throw fail(402, 'You have no assessment credits left. Add credits to retry.', 'INSUFFICIENT_CREDITS', { available: 0 });
  if (transcriptionFailed) {
    if (recording.audioDeletedAt) throw fail(409, 'This recording is no longer available. Upload it again.', 'TEACHER_UPLOAD_FILE_UNAVAILABLE');
    const { retried } = await processing.retryAudioRecording(recording._id);
    if (!retried) return already();
    processing.kickAudioWorker();
  } else {
    await require('./speakingAssessment.service').retryAssessment({ context: { submission: doc, recording } });
  }
  await requeueHeldEmail(submissionId);
  logger.info({ event: 'speaking_teacher_upload_retried', submissionId: String(submissionId), kind: transcriptionFailed ? 'transcription' : 'marking' });
  return { item: await itemFor(submissionId, teacher._id), alreadyRequested: false };
}

module.exports = { ownedContext, check, list, prepare, save, requestSend, retry, requeueHeldEmail, holdEmailsWithoutResult, statusOf, creditSummary,
  speakingReserved };
