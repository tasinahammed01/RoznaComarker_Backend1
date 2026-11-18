'use strict';
// Stage 10: guests for speaking assignments. The essay guest flow (controllers/guestSubmission.controller.js, unchanged) mirrored for one
// recording:
// - the assignment's guest link (its qrToken), open only while the teacher allows guests, the assignment is active and its class is active;
// - the same guest identity (guestAccess.identity), Idempotency-Key and request hash (the identity plus the recording's SHA-256), the same
//   unique (assignment, guestRequestKey) index check, the same per-IP limits (routes/speakingGuest.routes.js);
// - checked before the file is read: the link, the key, and the owning teacher's speech-to-text minutes (the worker's reservation stays the real
//   guard); after the upload checks (type, size, duration): the consent, a replay, the teacher's assessment credits (as for essay guests), then
//   storage reserved atomically against the teacher. All of it before anything is kept, so before any speech-to-text is spent. Any refusal
//   after the reservation undoes what was done and releases the storage; the upload middleware deletes the uncommitted file;
// - the recording, its file, storage and minutes belong to the teacher (a guest has no account);
// - the consent: the notice version (config/speakingGuestNotice.js) and the time it was accepted, stored with the submission (never read back
//   unless asked for, never sent to anyone);
// - one recording per guest submission; there is no guest "replace" (the essay guest revise is drafts with resubmission rules a speaking
//   assignment does not have): another recording through the link is another submission, as a second essay upload through the link is.
// Logs carry ids and codes only; DTOs carry no provider, hash, lease, credit, teacher or internal fields.
const mongoose = require('mongoose');
const Assignment = require('../../models/assignment.model');
const Class = require('../../models/class.model');
const User = require('../../models/user.model');
const Submission = require('../../models/Submission');
const AudioRecording = require('../../models/AudioRecording');
const File = require('../../models/File');
const access = require('../guestAccess.service');
const accounting = require('../assessmentCreditRouter.service');
const { ensureActivePlan, getLimit } = require('../../middlewares/usage.middleware');
const { withActiveStatus } = require('../classLifecycle.service');
const { readLimits } = require('./policy');
const { effectiveMaxRecordingSeconds } = require('./speakingAssignment');
const speakingSubmission = require('./speakingSubmission.service');
const processing = require('./processing');
const notice = require('../../config/speakingGuestNotice');
const logger = require('../../utils/logger');

const KEY = /^[\w-]{32,128}$/;
const fail = access.fail;
const unavailable = () => fail(404, 'This assignment is not open to guests. Ask your teacher for a new link, or sign in.', 'ASSIGNMENT_UNAVAILABLE');
const teacherFull = () => fail(403, 'Your teacher cannot receive more uploads right now.', 'TEACHER_STORAGE_FULL');
const guestMediaUrl = submissionId => `/api/guest/speaking/submissions/${submissionId}/media`;

/** The speaking assignment behind a guest link, its active class and its active teacher (a full document: plan and credits read it). */
async function assignmentFor(qrToken) {
  if (typeof qrToken !== 'string' || !qrToken || qrToken.length > 128) throw unavailable();
  const assignment = await Assignment.findOne({ qrToken, isActive: true, allowGuestSubmission: true, resourceType: 'speaking' })
    .select('_id title instructions deadline class teacher qrToken speaking showMarksToStudent').lean();
  if (!assignment) throw unavailable();
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: assignment.teacher, isActive: true })).select('_id name teacher institutionId').lean();
  const owner = classDoc && await User.findOne({ _id: assignment.teacher, role: 'teacher', isActive: { $ne: false } });
  if (!owner) throw unavailable();
  return { assignment, classDoc, owner };
}

/** What the guest page shows before an upload: the task, the recording limits and the notice to accept. Nothing about the teacher or class. */
async function entry(qrToken, env = process.env) {
  const { assignment } = await assignmentFor(qrToken);
  const { limits } = readLimits(env);
  return { kind: 'speaking', title: assignment.title, instructions: assignment.instructions || '', deadline: assignment.deadline, allowGuestSubmission: true,
    limits: { maxRecordingSeconds: effectiveMaxRecordingSeconds(assignment, limits), minDurationSeconds: limits.minDurationSeconds, maxFileBytes: limits.maxFileBytes },
    consent: { version: notice.SPEAKING_GUEST_NOTICE_VERSION, text: notice.SPEAKING_GUEST_NOTICE_TEXT } };
}

/** Before the file is read. Returns the context for the upload checks and commit. */
async function prepare({ qrToken, idempotencyKey, env = process.env }) {
  const context = await assignmentFor(qrToken);
  await require('../../controllers/guestSubmission.controller').requireIndexes();
  if (!KEY.test(String(idempotencyKey || ''))) throw fail(400, 'A valid submission reference is required.', 'GUEST_REQUEST_KEY_REQUIRED');
  if (!await speakingSubmission.teacherHasMinutes(context.assignment.teacher, env)) {
    logger.metric({ event: 'audio_upload_minutes_unavailable', assignmentId: String(context.assignment._id) });
    throw fail(429, speakingSubmission.UNAVAILABLE_MESSAGE, 'AUDIO_UPLOADS_UNAVAILABLE');
  }
  return { ...context, guestRequestKey: access.hash(idempotencyKey) };
}

const consented = body => (body?.consent === true || body?.consent === 'true') && body?.consentVersion === notice.SPEAKING_GUEST_NOTICE_VERSION;

/**
 * After the upload checks (req.audioUpload). Returns { duplicate: true } for a replay, or { duplicate: false, submissionId, link, emailSent }.
 * Throws fail(status, message, code); nothing is kept on any refusal.
 */
async function commit({ context, body, upload, now = () => new Date() }) {
  const { assignment, classDoc, owner, guestRequestKey } = context;
  const guest = access.identity(body);
  if (!consented(body)) throw fail(400, 'Read the notice and tick the box to agree before you upload.', 'SPEAKING_CONSENT_REQUIRED');
  const requestHash = access.hash(JSON.stringify([guest, upload.sha256]));
  const replay = async () => {
    const prior = await Submission.findOne({ assignment: assignment._id, guestRequestKey }).select('+guest.requestHash').lean();
    if (!prior) return null;
    if (prior.guest?.requestHash !== requestHash) throw fail(409, 'This submission reference was already used for a different recording.', 'GUEST_REQUEST_KEY_REUSED');
    return { duplicate: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const credit = await accounting.canRunAssessment({ teacherUserId: owner._id, assignmentId: assignment._id, user: owner });
  if (!credit.allowed) throw fail(403, 'Your teacher has no assessment credits available. Please contact your teacher.', 'INSUFFICIENT_ASSESSMENT_CREDITS');
  const megabytes = speakingSubmission.storageMBFor(upload.sizeBytes);
  const storageLimit = getLimit(await ensureActivePlan(owner), 'storageMB');
  if (storageLimit === null) throw teacherFull();
  const issued = access.issueToken();
  const id = new mongoose.Types.ObjectId();
  const link = access.speakingReturnUrl(id, issued.token);   // the frontend URL is validated before anything is stored
  const reserved = await User.updateOne({ _id: owner._id, $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, megabytes] }, storageLimit] } },
    { $inc: { 'usage.storageMB': megabytes } });
  if (!reserved.modifiedCount) throw teacherFull();
  const undo = [() => speakingSubmission.releaseStorage(owner._id, megabytes)];
  const undoAll = async () => { for (const step of undo.reverse()) await Promise.resolve().then(step).catch(() => {}); };
  try {
    const file = await File.create({ originalName: `recording${upload.extension}`, filename: upload.filename, path: upload.storedPath,
      url: `internal:audio/${upload.filename}`, uploadedBy: owner._id, role: 'teacher', type: 'audio', sizeBytes: upload.sizeBytes });
    undo.push(() => File.deleteOne({ _id: file._id }));
    let recording;
    try {
      recording = await AudioRecording.create({ owner: owner._id, requestId: `guest-${access.hash(`${assignment._id}:${guestRequestKey}`).slice(0, 58)}`,
        audioFileId: file._id, contentType: upload.contentType, sizeBytes: upload.sizeBytes, durationSeconds: upload.durationSeconds, audioSha256: upload.sha256,
        storageChargedTo: owner._id, storageChargedMB: megabytes, minutesChargedTo: assignment.teacher, institutionId: classDoc.institutionId || null, status: 'uploaded' });
    } catch (error) {
      if (error?.code === 11000) throw fail(409, 'This recording is already being saved. Please wait a moment.', 'GUEST_UPLOAD_IN_PROGRESS');
      throw error;
    }
    undo.push(() => AudioRecording.deleteOne({ _id: recording._id }));
    await processing.enqueue(recording._id, { now });
    const at = now();
    const isLate = Boolean(assignment.deadline && at.getTime() > new Date(assignment.deadline).getTime());
    try {
      // As for essay guests: late work is accepted and labelled late.
      await Submission.create({ _id: id, submissionMode: 'guest', assignment: assignment._id, class: classDoc._id, sourceKind: 'audio', audioRecording: recording._id,
        files: [], guestRequestKey, qrToken: assignment.qrToken, submittedAt: at, status: isLate ? 'late' : 'submitted', isLate,
        guest: { ...guest, requestHash, accessHash: issued.accessHash, expiresAt: issued.expiresAt,
          consent: { version: notice.SPEAKING_GUEST_NOTICE_VERSION, acceptedAt: at } } });
    } catch (error) {
      if (error?.code === 11000) {
        await undoAll();
        undo.length = 0;
        const winner = await replay();
        if (winner) return winner;
        throw fail(409, 'This submission reference has already been used.', 'GUEST_REQUEST_KEY_REUSED');
      }
      throw error;
    }
    undo.push(() => Submission.deleteOne({ _id: id, audioRecording: recording._id }));
    await AudioRecording.updateOne({ _id: recording._id }, { $set: { submissionId: id } });
    upload.commit();
  } catch (error) {
    await undoAll();
    throw error;
  }
  processing.kickAudioWorker();
  logger.info({ event: 'speaking_guest_submission_created', submissionId: String(id), sizeBytes: upload.sizeBytes, durationSeconds: Math.round(upload.durationSeconds) });
  await notifyTeacher({ owner, assignment, classDoc, submissionId: id, displayName: guest.displayName });
  const email = require('../email.service');
  if (email.sendTeacherSubmissionEmail) await email.sendTeacherSubmissionEmail({ to: owner.email, assignmentTitle: assignment.title, studentName: guest.displayName });
  const delivery = await email.sendGuestSubmissionEmail({ to: guest.normalizedEmail, assignmentTitle: assignment.title, returnUrl: link, kind: 'speaking' });
  return { duplicate: false, submissionId: String(id), link, emailSent: Boolean(delivery?.success) };
}

/** The teacher's notification, as for an essay guest; it opens the speaking submission page. Never fails the upload. */
async function notifyTeacher({ owner, assignment, classDoc, submissionId, displayName }) {
  try {
    await require('../notification.service').createNotification({ recipientId: owner._id, type: 'assignment_submitted', title: 'Assignment submitted',
      description: `${displayName} (Guest) submitted ${assignment.title}`, idempotencyKey: `submission:${submissionId}:submitted`, data: {
        classId: String(classDoc._id), assignmentId: String(assignment._id), submissionId: String(submissionId), draftNumber: 1, waitingReviewAdded: true,
        route: { path: '/teacher/my-classes/detail/speaking-submission', params: [String(submissionId)], queryParams: { classId: String(classDoc._id) } } } });
  } catch { logger.warn({ event: 'guest_teacher_notification_failed' }); }
}

/** The guest's own result (req.guestSubmission and req.guestAssignment from the guest access check). The student DTO, field by field. */
async function result({ submission: doc, assignment }) {
  const submission = await Submission.findById(doc._id).select('_id assignment status submittedAt isLate feedback +audioRecording +teacherUpload').lean();
  const recording = await speakingSubmission.loadRecording(submission.audioRecording);
  const view = speakingSubmission.studentView({ submission, recording, assignment, teacherUploaded: true });
  const { submissionId, ...read } = await require('./speakingResult.service').readResult({ role: 'student', submission, assignment, recording });
  void submissionId;
  return { kind: 'speaking', title: assignment.title, instructions: assignment.instructions || '', deadline: assignment.deadline || null,
    name: doc.guest?.displayName || '', submittedAt: submission.submittedAt, isLate: Boolean(submission.isLate),
    uploadedByTeacher: Boolean(submission.teacherUpload?.uploadedBy),
    recording: { state: view.recording.state, durationSeconds: view.recording.durationSeconds, contentType: view.recording.contentType, mediaUrl: guestMediaUrl(doc._id) },
    result: read };
}

module.exports = { assignmentFor, entry, prepare, commit, result, guestMediaUrl, consented, KEY };
