'use strict';
// Speaking submissions by class students (audio + speech-to-text, stage 5). The essay flow's rules, for one recording per student:
// - Before the file is read (prepareStudentUpload): an Idempotency-Key, an active speaking assignment in an active class, an active membership,
//   the plan's submission limit (first upload only), the replacement rule, and a courtesy check that the owning teacher still has speech-to-text
//   minutes (read-only; the worker's reservation stays the real guard).
// - After the file passed the upload checks (commitStudentUpload): storage is reserved atomically against the student's quota, then the File,
//   the AudioRecording and the Submission are created (or the submission is pointed at the new recording) and transcription is queued.
//   Every failure after the reservation undoes what was done and releases the storage; the uncommitted file is deleted by the upload middleware.
// - Replacement: allowed before the due date and before marking (no feedback on the submission). The old recording's transcription is
//   cancelled, and its file, audio and storage are released.
// Logs carry ids and codes only; DTOs carry no provider, model, request id, hash, lease, words, transcript or edits.
const fs = require('fs');
const mongoose = require('mongoose');
const Assignment = require('../../models/assignment.model');
const Class = require('../../models/class.model');
const Membership = require('../../models/membership.model');
const Submission = require('../../models/Submission');
const SubmissionFeedback = require('../../models/SubmissionFeedback');
const AudioRecording = require('../../models/AudioRecording');
const File = require('../../models/File');
const User = require('../../models/user.model');
const logger = require('../../utils/logger');
const { withActiveStatus } = require('../classLifecycle.service');
const { ensureActivePlan, getLimit, incrementUsage } = require('../../middlewares/usage.middleware');
const { readLimits, MIN_DURATION_SECONDS } = require('./policy');
const { resolveStoredAudioPath } = require('./storage');
const { effectiveMaxRecordingSeconds } = require('./speakingAssignment');
const usage = require('./usage');
const processing = require('./processing');

const REQUEST_ID = /^[\w-]{16,80}$/;
const UNAVAILABLE_MESSAGE = 'Recording uploads are not available right now. Please try again later or ask your teacher.';

class SpeakingError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
const fail = (statusCode, code, message) => new SpeakingError(statusCode, code, message);
const sameId = (a, b) => a != null && b != null && String(a?._id || a) === String(b?._id || b);
const storageMBFor = bytes => Math.max(0.0001, Number((Number(bytes) / (1024 * 1024)).toFixed(4)));
const log = fields => logger.metric(fields);

// ---- DTOs ---------------------------------------------------------------------------------------------------------------------------------
const STATE = { uploaded: 'processing', queued: 'processing', transcribing: 'processing', ready: 'ready', failed: 'failed', cancelled: 'failed' };
const mediaUrl = submissionId => `/api/audio/submissions/${submissionId}/media`;
const deadlinePassed = (assignment, now) => Boolean(assignment?.deadline && now.getTime() > new Date(assignment.deadline).getTime());

/** What the student (owner) sees. */
/** teacherUploaded (stage 9): the teacher uploaded this recording for the student; only the teacher can replace it. */
function studentView({ submission, recording, assignment, marked = false, teacherUploaded = false, now = new Date() }) {
  return {
    id: String(submission._id), assignmentId: String(submission.assignment), sourceKind: 'audio', status: submission.status,
    submittedAt: submission.submittedAt, isLate: Boolean(submission.isLate),
    canReplace: !marked && !teacherUploaded && !deadlinePassed(assignment, now),
    recording: { state: STATE[recording?.status] || 'failed', durationSeconds: recording?.durationSeconds ?? null, contentType: recording?.contentType || null,
      mediaUrl: mediaUrl(submission._id), canRetry: recording?.status === 'failed' && !recording?.audioDeletedAt }
  };
}

/** What the owning teacher sees: the job state too (codes and counts, never provider fields). studentName: the display name only (stage 7e). */
function teacherView({ submission, recording, studentName = null }) {
  return {
    id: String(submission._id), assignmentId: String(submission.assignment), studentId: submission.student ? String(submission.student) : null, studentName,
    sourceKind: 'audio', status: submission.status, submittedAt: submission.submittedAt, isLate: Boolean(submission.isLate),
    recording: recording ? { status: recording.status, attempts: recording.attempts, lastErrorCode: recording.lastErrorCode || null,
      durationSeconds: recording.durationSeconds ?? null, sizeBytes: recording.sizeBytes, contentType: recording.contentType, queuedAt: recording.queuedAt,
      readyAt: recording.readyAt, failedAt: recording.failedAt, cancelledAt: recording.cancelledAt, wordTimingsAvailable: recording.wordTimingsAvailable ?? null,
      audioAvailable: !recording.audioDeletedAt, mediaUrl: mediaUrl(submission._id), downloadUrl: `/api/audio/submissions/${submission._id}/download` } : null
  };
}

const RECORDING_FIELDS = '_id status attempts lastErrorCode durationSeconds sizeBytes contentType queuedAt readyAt failedAt cancelledAt wordTimingsAvailable audioDeletedAt audioFileId submissionId owner storageChargedTo storageChargedMB';
const SUBMISSION_FIELDS = '_id student assignment class sourceKind status submittedAt isLate feedback submissionMode guest.displayName +audioRecording';
const loadRecording = id => (id ? AudioRecording.findById(id).select(RECORDING_FIELDS).lean() : null);
/** Whether a teacher uploaded this submission for the student (stage 9). */
const uploadedByTeacher = async id => Boolean(id && await Submission.exists({ _id: id, 'teacherUpload.uploadedBy': { $exists: true } }));

/** Who made the recording, for the owning teacher's page: the display name (a guest's display name for a guest). Never an email. */
async function studentNameFor(submission) {
  if (submission?.submissionMode === 'guest') return String(submission.guest?.displayName || 'Guest').slice(0, 120);
  const user = submission?.student ? await User.findById(submission.student).select('displayName').lean() : null;
  return String(user?.displayName || 'Student').slice(0, 120);
}

// Marked = a result exists (an assessed or teacher-overridden result, or legacy feedback). The empty feedback document the assessor creates when
// a run starts, a failed run, or "not enough speech" are not marked: the student can still replace the recording.
async function isMarked(submission) {
  if (submission.feedback) return true;
  return Boolean(await SubmissionFeedback.exists({ submissionId: submission._id,
    $or: [{ evaluationStatus: { $in: ['completed', 'partial', 'stale'] } }, { overriddenByTeacher: true }] }));
}

// ---- Context ------------------------------------------------------------------------------------------------------------------------------
async function speakingAssignmentFor(assignmentId) {
  if (!mongoose.isValidObjectId(assignmentId)) return null;
  const assignment = await Assignment.findOne({ _id: assignmentId, isActive: true, resourceType: 'speaking' })
    .select('_id class teacher deadline speaking').lean();
  if (!assignment) return null;
  const classDoc = await Class.findOne(withActiveStatus({ _id: assignment.class, teacher: assignment.teacher, isActive: true })).select('_id teacher institutionId').lean();
  return classDoc ? { assignment, classDoc } : null;
}

/** The minutes left today and this month for the owning teacher are enough for at least the shortest recording. */
async function teacherHasMinutes(teacherId, env) {
  const { limits } = readLimits(env);
  const used = await usage.readUsage(teacherId);
  if (used.capped) return false;
  const left = Math.min(limits.dailyMinutesPerTeacher * 60 - used.daySeconds, limits.monthlyMinutesPerTeacher * 60 - used.monthSeconds);
  return left >= MIN_DURATION_SECONDS;
}

/** Everything checked before the upload is read. Returns { assignment, classDoc, existing, requestId, replay? }. Throws SpeakingError. */
async function prepareStudentUpload({ user, assignmentId, requestId, env = process.env }) {
  if (!REQUEST_ID.test(String(requestId || ''))) {
    throw fail(400, 'SPEAKING_REQUEST_ID_REQUIRED', 'Send an Idempotency-Key header (16 to 80 letters, digits, - or _) with each upload.');
  }
  const found = await speakingAssignmentFor(assignmentId);
  if (!found) throw fail(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
  const { assignment, classDoc } = found;
  if (!await Membership.exists({ student: user._id, class: classDoc._id, status: 'active' })) throw fail(403, 'NOT_CLASS_MEMBER', 'Not class member');

  // The same request again: its stored result (no file is read or kept).
  const previous = await AudioRecording.findOne({ owner: user._id, requestId }).select('_id submissionId').lean();
  if (previous) {
    const submission = previous.submissionId ? await Submission.findById(previous.submissionId).select(SUBMISSION_FIELDS).lean() : null;
    if (!submission || !sameId(submission.assignment, assignment._id)) throw fail(409, 'SPEAKING_REQUEST_ID_REUSED', 'This upload reference was already used. Please try again.');
    return { assignment, classDoc, replay: submission };
  }

  const existing = await Submission.findOne({ student: user._id, assignment: assignment._id }).select(SUBMISSION_FIELDS).lean();
  if (existing) {
    if (existing.sourceKind !== 'audio') throw fail(409, 'SPEAKING_UPLOAD_CONFLICT', 'This submission cannot take a recording.');
    if (await isMarked(existing)) throw fail(409, 'SPEAKING_ALREADY_MARKED', 'Your teacher has already marked this recording, so it can no longer be replaced.');
    if (await uploadedByTeacher(existing._id)) throw fail(409, 'SPEAKING_UPLOADED_BY_TEACHER', 'Your teacher uploaded this recording for you, so only your teacher can replace it.');
    if (deadlinePassed(assignment, new Date())) throw fail(403, 'DEADLINE_PASSED', 'Deadline passed');
  } else {
    const limit = getLimit(await ensureActivePlan(user), 'submissions');
    const current = typeof user.usage?.submissions === 'number' ? user.usage.submissions : 0;
    if (typeof limit === 'number' && current + 1 > limit) throw fail(403, 'SUBMISSION_LIMIT', 'Limit exceeded: submissions');
  }
  if (!await teacherHasMinutes(assignment.teacher, env)) {
    log({ event: 'audio_upload_minutes_unavailable', assignmentId: String(assignment._id) });
    throw fail(429, 'AUDIO_UPLOADS_UNAVAILABLE', UNAVAILABLE_MESSAGE);
  }
  return { assignment, classDoc, existing, requestId };
}

// ---- Storage ------------------------------------------------------------------------------------------------------------------------------
async function reserveStorage(user, megabytes) {
  const limit = getLimit(await ensureActivePlan(user), 'storageMB');
  const reserved = limit === null ? { modifiedCount: 0 } : await User.updateOne({ _id: user._id,
    $expr: { $lte: [{ $add: [{ $ifNull: ['$usage.storageMB', 0] }, megabytes] }, limit] } }, { $inc: { 'usage.storageMB': megabytes } });
  if (!reserved.modifiedCount) throw fail(413, 'SPEAKING_STORAGE_FULL', 'Your storage is full. Free up space and upload the recording again.');
}
const releaseStorage = (userId, megabytes) => (userId && megabytes > 0 ? User.updateOne({ _id: userId },
  [{ $set: { 'usage.storageMB': { $max: [0, { $subtract: [{ $ifNull: ['$usage.storageMB', 0] }, megabytes] }] } } }], { updatePipeline: true }) : null);

/** Deletes a recording that is no longer used (replaced): cancels its transcription, then its File, audio, storage and document. Best effort. */
async function discardRecording(recording) {
  if (!recording) return;
  try {
    await processing.cancelAudioRecording(recording._id);
    const file = recording.audioFileId ? await File.findById(recording.audioFileId).select('_id path').lean() : null;
    const absolute = file ? resolveStoredAudioPath(file.path) : null;
    if (file) await File.deleteOne({ _id: file._id });
    await releaseStorage(recording.storageChargedTo, Number(recording.storageChargedMB) || 0);
    await AudioRecording.deleteOne({ _id: recording._id });
    if (absolute) await fs.promises.unlink(absolute).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  } catch (error) {
    logger.warn({ event: 'audio_recording_discard_incomplete', recordingId: String(recording._id), errorName: String(error?.name || 'Error').slice(0, 60) });
  }
}

// ---- Commit -------------------------------------------------------------------------------------------------------------------------------
/** After the upload checks passed. Returns { created, submission, recording }. Throws SpeakingError (or an unexpected error, after undoing). */
async function commitStudentUpload({ user, context, upload, now = () => new Date() }) {
  const { assignment, classDoc, existing, requestId } = context;
  const megabytes = storageMBFor(upload.sizeBytes);
  await reserveStorage(user, megabytes);
  const undo = [() => releaseStorage(user._id, megabytes)];
  try {
    const file = await File.create({ originalName: `recording${upload.extension}`, filename: upload.filename, path: upload.storedPath,
      url: `internal:audio/${upload.filename}`, uploadedBy: user._id, role: 'student', type: 'audio', sizeBytes: upload.sizeBytes });
    undo.push(() => File.deleteOne({ _id: file._id }));
    let recording;
    try {
      recording = await AudioRecording.create({ owner: user._id, requestId, audioFileId: file._id, contentType: upload.contentType, sizeBytes: upload.sizeBytes,
        durationSeconds: upload.durationSeconds, audioSha256: upload.sha256, storageChargedTo: user._id, storageChargedMB: megabytes,
        minutesChargedTo: assignment.teacher, institutionId: classDoc.institutionId || null, status: 'uploaded' });
    } catch (error) {
      if (error?.code === 11000) throw fail(409, 'SPEAKING_UPLOAD_CONFLICT', 'This upload is already being saved. Please wait a moment.');
      throw error;
    }
    undo.push(() => AudioRecording.deleteOne({ _id: recording._id }));
    await processing.enqueue(recording._id, { now });

    const at = now();
    const isLate = deadlinePassed(assignment, at);
    const state = { submittedAt: at, status: isLate ? 'late' : 'submitted', isLate };
    let submission;
    if (existing) {
      // Only if nobody replaced or marked it meanwhile.
      const switched = await Submission.updateOne({ _id: existing._id, audioRecording: existing.audioRecording, feedback: existing.feedback ?? null },
        { $set: { audioRecording: recording._id, ...state } });
      if (!switched.modifiedCount) throw fail(409, 'SPEAKING_UPLOAD_CONFLICT', 'This recording was changed meanwhile. Please reload and try again.');
      undo.push(() => Submission.updateOne({ _id: existing._id, audioRecording: recording._id }, { $set: { audioRecording: existing.audioRecording } }));
      submission = { ...existing, ...state, audioRecording: recording._id };
    } else {
      try {
        const created = await Submission.create({ student: user._id, assignment: assignment._id, class: classDoc._id, sourceKind: 'audio',
          audioRecording: recording._id, files: [], ...state });
        submission = created.toObject();
      } catch (error) {
        if (error?.code === 11000) throw fail(409, 'SPEAKING_UPLOAD_CONFLICT', 'Another upload for this assignment is being saved. Please wait a moment.');
        throw error;
      }
      undo.push(() => Submission.deleteOne({ _id: submission._id, audioRecording: recording._id }));
    }
    await AudioRecording.updateOne({ _id: recording._id }, { $set: { submissionId: submission._id } });
    if (!existing) await incrementUsage(user._id, { submissions: 1 });
    upload.commit();
    log({ event: existing ? 'speaking_recording_replaced' : 'speaking_submission_created', submissionId: String(submission._id), recordingId: String(recording._id),
      sizeBytes: upload.sizeBytes, durationSeconds: Math.round(upload.durationSeconds) });

    if (existing) await discardRecording(await loadRecording(existing.audioRecording));
    processing.kickAudioWorker();
    return { created: !existing, submission, recording: await loadRecording(recording._id) };
  } catch (error) {
    for (const step of undo.reverse()) await Promise.resolve().then(step).catch(() => {});
    throw error;
  }
}

// ---- Reads and actions by submission id ---------------------------------------------------------------------------------------------------
/**
 * The speaking submission and who the caller is to it: 'student' (the student who owns it) or 'teacher' (the teacher who owns its assignment
 * and class). null for anyone else, and for anything that is not a speaking submission.
 */
async function accessFor(submissionId, user) {
  if (!user?._id || !/^[a-f\d]{24}$/i.test(String(submissionId || ''))) return null;
  const submission = await Submission.findOne({ _id: submissionId, sourceKind: 'audio' }).select(SUBMISSION_FIELDS).lean();
  if (!submission) return null;
  let role = null;
  if (user.role === 'student' && sameId(submission.student, user._id)) role = 'student';
  else if (user.role === 'teacher') {
    const assignment = await Assignment.findOne({ _id: submission.assignment, teacher: user._id }).select('_id class').lean();
    if (assignment && sameId(assignment.class, submission.class) && await Class.exists({ _id: submission.class, teacher: user._id })) role = 'teacher';
  }
  if (!role) return null;
  const assignment = await Assignment.findById(submission.assignment).select('_id deadline speaking teacher showMarksToStudent').lean();
  return { role, submission, assignment, recording: await loadRecording(submission.audioRecording) };
}

/** The student's own status for one speaking assignment, and the limits that apply to it. */
async function studentStatus({ user, assignmentId, env = process.env }) {
  const found = await speakingAssignmentFor(assignmentId);
  if (!found) throw fail(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
  if (!await Membership.exists({ student: user._id, class: found.classDoc._id, status: 'active' })) throw fail(403, 'NOT_CLASS_MEMBER', 'Not class member');
  const { limits } = readLimits(env);
  const submission = await Submission.findOne({ student: user._id, assignment: found.assignment._id, sourceKind: 'audio' }).select(SUBMISSION_FIELDS).lean();
  const limitsOut = { maxRecordingSeconds: effectiveMaxRecordingSeconds(found.assignment, limits), minDurationSeconds: limits.minDurationSeconds, maxFileBytes: limits.maxFileBytes };
  if (!submission) return { submission: null, limits: limitsOut };
  return { submission: studentView({ submission, recording: await loadRecording(submission.audioRecording), assignment: found.assignment,
    marked: await isMarked(submission), teacherUploaded: await uploadedByTeacher(submission._id) }), limits: limitsOut };
}

/** Requeues a failed transcription (the owning student or teacher). */
async function retryTranscription({ user, submissionId }) {
  const context = await accessFor(submissionId, user);
  if (!context) throw fail(404, 'NOT_FOUND', 'Not found.');
  if (!context.recording || context.recording.status !== 'failed' || context.recording.audioDeletedAt) {
    throw fail(409, 'TRANSCRIPTION_NOT_FAILED', 'Only a failed transcription can be retried.');
  }
  const { retried } = await processing.retryAudioRecording(context.recording._id);
  if (!retried) throw fail(409, 'TRANSCRIPTION_NOT_FAILED', 'Only a failed transcription can be retried.');
  processing.kickAudioWorker();
  const recording = await loadRecording(context.recording._id);
  return context.role === 'teacher' ? teacherView({ submission: context.submission, recording })
    : studentView({ submission: context.submission, recording, assignment: context.assignment, marked: await isMarked(context.submission),
      teacherUploaded: await uploadedByTeacher(context.submission._id) });
}

module.exports = { SpeakingError, REQUEST_ID, UNAVAILABLE_MESSAGE, prepareStudentUpload, commitStudentUpload, accessFor, studentStatus, retryTranscription,
  studentView, teacherView, studentNameFor, isMarked, storageMBFor, releaseStorage, loadRecording,
  // Shared with the teacher upload (stage 9): storage on the uploader, removal of a replaced recording, the teacher's minutes.
  reserveStorage, discardRecording, teacherHasMinutes };
