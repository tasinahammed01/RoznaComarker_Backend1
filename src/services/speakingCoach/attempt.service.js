'use strict';
// Speaking Coach: uploading a practice attempt, reading it, and retrying a failed check.
// - Before the file is read (prepareAttempt): an Idempotency-Key, the owner (404 for anyone else), the session open, the task active, no other
//   attempt in progress, the attempt cap, and a courtesy check that the teacher still has practice minutes (the worker's reservation stays the
//   real guard).
// - After the upload checks (commitAttempt): the attempt slot is taken atomically on the session (the cap and "one in progress" are exact), then
//   the File, the practice AudioRecording (no submission, no storage charge: its audio is deleted once transcribed, D1) and the attempt are
//   created, and transcription is queued. Any failure undoes what was done and gives the slot back.
// - A guest's recording belongs to the teacher (as the guest's graded recording does); the minutes are the teacher's practice minutes.
// Logs carry ids, codes and numbers only.
const mongoose = require('mongoose');
const Assignment = require('../../models/assignment.model');
const Class = require('../../models/class.model');
const File = require('../../models/File');
const AudioRecording = require('../../models/AudioRecording');
const SpeakingPracticeSession = require('../../models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../../models/SpeakingPracticeAttempt');
const accessContext = require('../submissionAccessContext.service');
const logger = require('../../utils/logger');
const usage = require('../audio/usage');
const processing = require('../audio/processing');
const { MIN_DURATION_SECONDS } = require('../audio/policy');
const { CoachError } = require('./generation.service');

const REQUEST_ID = /^[\w-]{16,80}$/;
const fail = (statusCode, code, message) => new CoachError(statusCode, code, message);
const notFound = () => fail(404, 'NOT_FOUND', 'Not found.');
const MESSAGES = Object.freeze({
  COACH_SESSION_NOT_OPEN: 'This practice has ended.',
  COACH_TASK_NOT_ACTIVE: 'This task is not open yet.',
  COACH_ATTEMPT_IN_PROGRESS: 'Your last recording is still being checked. Please wait a moment.',
  COACH_MINUTES_UNAVAILABLE: 'Practice recordings are not available right now. Please try again later.'
});
const refuse = (statusCode, code) => fail(statusCode, code, MESSAGES[code]);

/** The session if the actor owns it (student, or the guest of its submission). 404 otherwise. */
async function loadOwnedSession(sessionId, actor) {
  if (!mongoose.isValidObjectId(sessionId)) throw notFound();
  const session = await SpeakingPracticeSession.findById(sessionId).lean();
  if (!session || !accessContext.ownsSession(session, actor)) throw notFound();
  return session;
}

/** Everything checked before the file is read. Returns the context for commitAttempt, or { replay } for a request already stored. */
async function prepareAttempt({ sessionId, taskId, actor, requestId, env = process.env }) {
  if (!REQUEST_ID.test(String(requestId || ''))) throw fail(400, 'COACH_REQUEST_ID_REQUIRED', 'Send an Idempotency-Key header (16 to 80 letters, digits, - or _).');
  const session = await loadOwnedSession(sessionId, actor);
  const replay = await SpeakingPracticeAttempt.findOne({ sessionId: session._id, requestId }).lean();
  if (replay) return { replay };
  if (session.status !== 'ready' || session.attemptsUsed >= session.settings.attemptCap) throw refuse(409, 'COACH_SESSION_NOT_OPEN');
  const task = session.tasks.find(item => item.taskId === taskId);
  if (!task || task.status !== 'active' || session.currentTaskId !== taskId) throw refuse(409, 'COACH_TASK_NOT_ACTIVE');
  if (session.activeAttemptId) throw refuse(409, 'COACH_ATTEMPT_IN_PROGRESS');
  const assignment = await Assignment.findById(session.assignmentId).select('_id teacher class').lean();
  if (!assignment?.teacher) throw notFound();
  const classDoc = await Class.findById(assignment.class).select('_id institutionId').lean();
  if (await usage.minutesLeft(assignment.teacher, { env, purpose: usage.PRACTICE }) < MIN_DURATION_SECONDS) {
    logger.metric({ event: 'speaking_coach_minutes_unavailable', sessionId: String(session._id) });
    throw refuse(429, 'COACH_MINUTES_UNAVAILABLE');
  }
  return { session, task, assignment, institutionId: classDoc?.institutionId || null, requestId, maxSeconds: task.maxSeconds };
}

/** After the upload checks (req.audioUpload). Returns the attempt (lean). Throws CoachError; nothing is kept on any failure. */
async function commitAttempt({ context, upload, actor, now = () => new Date() }) {
  const { session, task, assignment, institutionId, requestId } = context;
  const attemptId = new mongoose.Types.ObjectId();
  const slot = await SpeakingPracticeSession.findOneAndUpdate(
    { _id: session._id, status: 'ready', currentTaskId: task.taskId, activeAttemptId: null, attemptsUsed: { $lt: session.settings.attemptCap } },
    { $set: { activeAttemptId: attemptId }, $inc: { attemptsUsed: 1, 'tasks.$[t].attemptCount': 1, revision: 1 } },
    { arrayFilters: [{ 't.taskId': task.taskId }], returnDocument: 'after' }).lean();
  if (!slot) {
    const replay = await SpeakingPracticeAttempt.findOne({ sessionId: session._id, requestId }).lean();
    if (replay) return replay;
    const current = await SpeakingPracticeSession.findById(session._id).select('status activeAttemptId attemptsUsed settings').lean();
    throw refuse(409, current?.status === 'ready' && current.activeAttemptId ? 'COACH_ATTEMPT_IN_PROGRESS' : 'COACH_SESSION_NOT_OPEN');
  }
  const undo = [() => SpeakingPracticeSession.updateOne({ _id: session._id, activeAttemptId: attemptId },
    { $set: { activeAttemptId: null }, $inc: { attemptsUsed: -1, 'tasks.$[t].attemptCount': -1, revision: 1 } }, { arrayFilters: [{ 't.taskId': task.taskId }] })];
  const guest = accessContext.isGuest(actor);
  const owner = guest ? assignment.teacher : actor;
  try {
    const file = await File.create({ originalName: `practice${upload.extension}`, filename: upload.filename, path: upload.storedPath,
      url: `internal:audio/${upload.filename}`, uploadedBy: owner, role: guest ? 'teacher' : 'student', type: 'audio', sizeBytes: upload.sizeBytes });
    undo.push(() => File.deleteOne({ _id: file._id }));
    const recording = await AudioRecording.create({ owner, requestId: `practice-${attemptId}`, audioFileId: file._id, contentType: upload.contentType,
      sizeBytes: upload.sizeBytes, durationSeconds: upload.durationSeconds, audioSha256: upload.sha256, minutesChargedTo: assignment.teacher, institutionId,
      storageChargedTo: null, storageChargedMB: 0, status: 'uploaded', purpose: 'practice', practiceAttemptId: attemptId, submissionId: null });
    undo.push(() => AudioRecording.deleteOne({ _id: recording._id }));
    let attempt;
    try {
      attempt = await SpeakingPracticeAttempt.create({ _id: attemptId, sessionId: session._id, submissionId: session.submissionId, ...accessContext.ownerFields(actor),
        taskId: task.taskId, attemptNumber: slot.attemptsUsed, requestId, recordingId: recording._id, status: 'transcribing' });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      for (const step of undo.reverse()) await Promise.resolve().then(step).catch(() => {});
      undo.length = 0;
      const replay = await SpeakingPracticeAttempt.findOne({ sessionId: session._id, requestId }).lean();
      if (replay) return replay;
      throw refuse(409, 'COACH_ATTEMPT_IN_PROGRESS');
    }
    undo.push(() => SpeakingPracticeAttempt.deleteOne({ _id: attempt._id }));
    await processing.enqueue(recording._id, { now });
    upload.commit();
    processing.kickAudioWorker();
    logger.metric({ event: 'speaking_coach_attempt_uploaded', sessionId: String(session._id), attemptId: String(attempt._id), taskId: task.taskId,
      attemptNumber: attempt.attemptNumber, durationSeconds: Math.round(Number(upload.durationSeconds) || 0), sizeBytes: upload.sizeBytes, guest });
    return attempt.toObject();
  } catch (error) {
    for (const step of undo.reverse()) await Promise.resolve().then(step).catch(() => {});
    throw error;
  }
}

/** { session, attempt } for the owner of the session; 404 for anyone else or an attempt of another session. */
async function getAttempt({ sessionId, attemptId, actor }) {
  const session = await loadOwnedSession(sessionId, actor);
  if (!mongoose.isValidObjectId(attemptId)) throw notFound();
  const attempt = await SpeakingPracticeAttempt.findOne({ _id: attemptId, sessionId: session._id }).lean();
  if (!attempt) throw notFound();
  return { session, attempt };
}

/**
 * A failed check, re-queued without using the cap: only the latest attempt of the open task, and only when no other attempt is in progress.
 * Returns { session, attempt }.
 */
async function retryCheck({ sessionId, attemptId, actor, now = () => new Date() }) {
  const { session, attempt } = await getAttempt({ sessionId, attemptId, actor });
  const latest = await SpeakingPracticeAttempt.findOne({ sessionId: session._id }).sort({ attemptNumber: -1 }).select('_id').lean();
  if (attempt.status !== 'failed' || attempt.errorCode !== 'COACH_CHECK_FAILED' || session.status !== 'ready' || session.currentTaskId !== attempt.taskId
    || String(latest?._id) !== String(attempt._id)) throw fail(409, 'COACH_RETRY_NOT_ALLOWED', 'This recording cannot be checked again. Record a new answer instead.');
  const held = await SpeakingPracticeSession.updateOne({ _id: session._id, status: 'ready', activeAttemptId: null }, { $set: { activeAttemptId: attempt._id }, $inc: { revision: 1 } });
  if (!held.modifiedCount) throw refuse(409, 'COACH_ATTEMPT_IN_PROGRESS');
  await SpeakingPracticeAttempt.updateOne({ _id: attempt._id, status: 'failed' }, { $set: { status: 'assessing', errorCode: null, assessmentQueue: true,
    assessmentAttempts: 0, assessmentNextAttemptAt: now(), assessmentLeaseUntil: null } });
  processing.kickAudioWorker();
  logger.metric({ event: 'speaking_coach_check_retry_requested', sessionId: String(session._id), attemptId: String(attempt._id) });
  return getAttempt({ sessionId, attemptId, actor });
}

module.exports = { REQUEST_ID, loadOwnedSession, prepareAttempt, commitAttempt, getAttempt, retryCheck };
