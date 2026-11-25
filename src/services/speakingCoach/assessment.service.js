'use strict';
// Speaking Coach: checking one practice attempt. Never the graded speaking assessment: its own queue and lease on the attempt, its own prompt
// (checkPrompt.js), and it writes only the attempt and its practice session (never the Submission, SubmissionFeedback, AssessmentRun or
// credits: D2).
// - When a practice recording's transcript is stored (the audio worker calls onPracticeTranscribed), its audio file is deleted (D1) and the
//   attempt is queued here. The sweep (run by the audio worker after the graded work) also catches a transcription that ended without the hook.
// - Decided without AI: not enough speech, mostly not English, too long. The model picks a level of the ONE practised criterion; pass or not
//   is decided in code: the pass rule (policy.isPassingLevel, D3) on the session's settings, on task, and for a vocabulary swap the target words
//   used. The fluency comparison with the previous attempt is computed in code.
// - Passed: the task is passed and the next one opens; every task passed: the session is completed and the teacher is notified once.
//   Not passed or not assessable: the attempt counts; at the cap the session ends as capped.
// - A failed check (after one retry) leaves the attempt failed and counted; the student can retry it without using the cap. A transcription
//   that fails for good gives the attempt back.
// Logs carry ids, codes and numbers only.
const fs = require('fs');
const crypto = require('crypto');
const AudioRecording = require('../../models/AudioRecording');
const File = require('../../models/File');
const Assignment = require('../../models/assignment.model');
const SpeakingPracticeSession = require('../../models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../../models/SpeakingPracticeAttempt');
const logger = require('../../utils/logger');
const { resolveStoredAudioPath } = require('../audio/storage');
const { countWords, nonLatinShare } = require('../audio/speakingAssessment.service');
const { readSettings, isPassingLevel } = require('./policy');
const prompt = require('./checkPrompt');
const { forbiddenTitles } = require('./prompt');
const { retryLine } = require('./coachText');

const MAX_CHECK_RUNS = 2;
const RETRY_DELAY_MS = 30000;
const LEASE_MS = 5 * 60 * 1000;
const SWEEP_CAP = 10;
const MAX_ANSWER_CHARS = 6000;
const CHECK_TIMEOUT_MS = 45000;
const log = fields => logger.metric(fields);
const safeCode = error => String(error?.validationCode || error?.finalFailureCode || error?.code || 'COACH_CHECK_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64);

// ---- Audio (D1) --------------------------------------------------------------------------------------------------------------------------
/** Deletes a practice recording's audio file and marks it deleted. The transcript (on the recording) is kept. Best effort on the disk. */
async function deletePracticeAudio(recording, reason, now = () => new Date()) {
  if (!recording || recording.audioDeletedAt) return;
  const file = recording.audioFileId ? await File.findById(recording.audioFileId).select('_id path').lean() : null;
  const absolute = file ? resolveStoredAudioPath(file.path) : null;
  if (file) await File.deleteOne({ _id: file._id });
  await AudioRecording.updateOne({ _id: recording._id, purpose: 'practice', audioDeletedAt: null }, { $set: { audioDeletedAt: now(), audioDeletionReason: reason } });
  if (absolute) await fs.promises.unlink(absolute).catch(error => { if (error?.code !== 'ENOENT') logger.warn({ event: 'speaking_coach_audio_delete_failed', recordingId: String(recording._id) }); });
}

const RECORDING_FIELDS = '_id purpose practiceAttemptId audioFileId audioDeletedAt status';

/** The audio worker stored the transcript of a practice recording: delete its audio and queue the attempt's check. */
async function onPracticeTranscribed(recordingId, { now = () => new Date() } = {}) {
  const recording = await AudioRecording.findById(recordingId).select(RECORDING_FIELDS).lean();
  if (!recording || recording.purpose !== 'practice' || recording.status !== 'ready') return { queued: false };
  await deletePracticeAudio(recording, 'practice_transcribed', now);
  const queued = await SpeakingPracticeAttempt.updateOne({ _id: recording.practiceAttemptId, recordingId: recording._id, status: 'transcribing' },
    { $set: { status: 'assessing', assessmentQueue: true, assessmentNextAttemptAt: now(), assessmentAttempts: 0, assessmentLeaseUntil: null } });
  if (queued.modifiedCount) require('../audio/processing').kickAudioWorker();
  return { queued: queued.modifiedCount === 1 };
}

/** A transcription that ended for good without a transcript: the attempt fails and is given back; its audio is deleted. */
async function onTranscriptionFailed(attempt, recording, now = () => new Date()) {
  const changed = await SpeakingPracticeAttempt.updateOne({ _id: attempt._id, status: 'transcribing' },
    { $set: { status: 'failed', errorCode: 'COACH_TRANSCRIPTION_FAILED' } });
  if (!changed.modifiedCount) return;
  await SpeakingPracticeSession.updateOne({ _id: attempt.sessionId, activeAttemptId: attempt._id },
    { $set: { activeAttemptId: null }, $inc: { attemptsUsed: -1, 'tasks.$[t].attemptCount': -1, revision: 1 } }, { arrayFilters: [{ 't.taskId': attempt.taskId }] });
  await deletePracticeAudio(recording, 'practice_transcription_failed', now);
  log({ event: 'speaking_coach_transcription_failed', attemptId: String(attempt._id), sessionId: String(attempt.sessionId), code: recording?.lastErrorCode || null });
}

/** Attempts still transcribing whose recording is ready or ended for good (a hook that never ran, or the worker's bulk exhaustion). */
async function reconcileTranscriptions(now) {
  const waiting = await SpeakingPracticeAttempt.find({ status: 'transcribing' }).select('_id sessionId taskId recordingId').limit(SWEEP_CAP).lean();
  let reconciled = 0;
  for (const attempt of waiting) {
    const recording = attempt.recordingId ? await AudioRecording.findById(attempt.recordingId).select(`${RECORDING_FIELDS} lastErrorCode`).lean() : null;
    if (recording?.status === 'ready') { if ((await onPracticeTranscribed(recording._id, { now })).queued) reconciled++; }
    else if (!recording || ['failed', 'cancelled'].includes(recording.status)) { await onTranscriptionFailed(attempt, recording, now); reconciled++; }
  }
  return reconciled;
}

// ---- Queue -------------------------------------------------------------------------------------------------------------------------------
const due = at => ({ assessmentQueue: true, assessmentAttempts: { $lt: MAX_CHECK_RUNS },
  $and: [{ $or: [{ assessmentNextAttemptAt: null }, { assessmentNextAttemptAt: { $lte: at } }] },
    { $or: [{ assessmentLeaseUntil: null }, { assessmentLeaseUntil: { $lte: at } }] }] });

async function claim(attemptId, at) {
  return SpeakingPracticeAttempt.findOneAndUpdate({ _id: attemptId, ...due(at) },
    { $set: { assessmentLeaseUntil: new Date(at.getTime() + LEASE_MS), assessmentAttemptKey: crypto.randomUUID() }, $inc: { assessmentAttempts: 1 } },
    { returnDocument: 'after' }).select('+assessmentLeaseUntil +assessmentAttemptKey').lean();
}

/** One sweep: reconcile transcriptions, fail exhausted checks, then run due checks one at a time (oldest first, sorted in Node). */
async function sweepPracticeChecks({ now = () => new Date(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const at = now();
  const reconciled = await reconcileTranscriptions(now);
  const exhausted = await SpeakingPracticeAttempt.find({ assessmentQueue: true, assessmentAttempts: { $gte: MAX_CHECK_RUNS },
    $or: [{ assessmentLeaseUntil: null }, { assessmentLeaseUntil: { $lte: at } }] }).select('_id sessionId').limit(SWEEP_CAP).lean();
  for (const attempt of exhausted) await failCheck({ _id: attempt._id }, attempt, 'COACH_CHECK_FAILED');
  const found = await SpeakingPracticeAttempt.find(due(at)).select({ _id: 1, assessmentNextAttemptAt: 1, createdAt: 1 }).limit(SWEEP_CAP + 1).lean();
  const order = doc => (doc.assessmentNextAttemptAt || doc.createdAt || at).getTime();
  const batch = found.sort((a, b) => order(a) - order(b) || String(a._id).localeCompare(String(b._id))).slice(0, SWEEP_CAP);
  let processed = 0;
  for (const doc of batch) if ((await runPracticeCheck(doc._id, { now, env, fetchImpl })).status !== 'skipped') processed++;
  log({ event: 'speaking_coach_check_sweep', found: batch.length, processed, reconciled, exhausted: exhausted.length });
  return { found: batch.length, processed, reconciled, exhausted: exhausted.length };
}

// ---- Session progress --------------------------------------------------------------------------------------------------------------------
/** After a checked (or not assessable) attempt: the task, the next task, completion or the cap; the attempt in progress is released. */
async function advanceSession(sessionId, attemptId, taskId, passed, now) {
  const session = await SpeakingPracticeSession.findOne({ _id: sessionId, activeAttemptId: attemptId }).lean();
  if (!session) return null;
  const at = now();
  const tasks = session.tasks.map(task => ({ ...task }));
  const set = { activeAttemptId: null };
  if (passed) {
    const task = tasks.find(item => item.taskId === taskId);
    if (task) { task.status = 'passed'; task.passedAt = at; }
    const next = tasks.filter(item => item.status === 'locked').sort((a, b) => a.order - b.order)[0];
    if (next) { next.status = 'active'; set.currentTaskId = next.taskId; }
    else Object.assign(set, { status: 'completed', completedAt: at, endedAt: at, endedReason: 'completed', currentTaskId: null });
  }
  if (set.status !== 'completed' && session.attemptsUsed >= session.settings.attemptCap) {
    Object.assign(set, { status: 'capped', endedAt: at, endedReason: 'capped' });
  }
  const stored = await SpeakingPracticeSession.updateOne({ _id: session._id, activeAttemptId: attemptId, revision: session.revision },
    { $set: { ...set, tasks }, $inc: { revision: 1 } });
  if (!stored.modifiedCount) return null;
  if (set.status === 'completed') await notifyTeacher(session);
  return set.status || 'ready';
}

/** The teacher is told once that the student finished speaking practice (the essay completion notification type). Never fails the check. */
async function notifyTeacher(session) {
  try {
    const assignment = await Assignment.findById(session.assignmentId).select('_id teacher title class').lean();
    if (!assignment?.teacher) return;
    let name = 'A student';
    if (session.studentId) name = (await require('../../models/user.model').findById(session.studentId).select('displayName').lean())?.displayName || name;
    else name = `${(await require('../../models/Submission').findById(session.submissionId).select('guest.displayName').lean())?.guest?.displayName || 'A guest'} (Guest)`;
    await require('../notification.service').createSmartNotification({ recipientId: assignment.teacher, actorId: session.studentId || undefined,
      type: 'adaptive_completed', title: 'Speaking practice completed', description: `${name} completed speaking practice for ${assignment.title || 'an assignment'}.`,
      idempotencyKey: `speaking-coach:${session._id}:completed`, data: { sessionId: String(session._id), assignmentId: String(assignment._id),
        classId: String(assignment.class || ''), submissionId: String(session.submissionId), route: { path: '/teacher/my-classes/detail/speaking-submission',
          params: [String(session.submissionId)], queryParams: { classId: String(assignment.class || '') } } } });
  } catch { logger.warn({ event: 'speaking_coach_notification_failed', sessionId: String(session._id) }); }
}

async function failCheck(mine, attempt, code) {
  const failed = await SpeakingPracticeAttempt.updateOne(mine, { $set: { status: 'failed', errorCode: code, assessmentLeaseUntil: null, assessmentNextAttemptAt: null },
    $unset: { assessmentQueue: 1 } });
  if (!failed.modifiedCount) return;
  await SpeakingPracticeSession.updateOne({ _id: attempt.sessionId, activeAttemptId: attempt._id }, { $set: { activeAttemptId: null }, $inc: { revision: 1 } });
  log({ event: 'speaking_coach_check_failed', attemptId: String(attempt._id), sessionId: String(attempt.sessionId), code });
}

/** Phrase used in the answer: whole words, any case. */
const usedIn = (text, phrase) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/** The fluency figures kept on an attempt, in the stored (raw) shape, so the next attempt compares like with like. */
const storedFluency = fluency => (fluency ? { available: true, wordsPerMinute: fluency.wordsPerMinute, fillersPer100Words: fluency.fillersPer100Words,
  pausesOverThreshold: fluency.pausesOverThreshold, longestPauseSeconds: fluency.longestPauseSeconds, repetitionCount: fluency.repetitionCount } : null);

/** Fewer long pauses, fewer fillers, a shorter longest pause, against the figures before (null when either side has none). */
function fluencyChange(before, now) {
  const b = prompt.figures(before); const n = prompt.figures(now);
  if (b.available === false || n.available === false) return undefined;
  return { fewerLongPauses: n.pausesOverOneSecond < b.pausesOverOneSecond, fewerFillers: n.fillersPer100Words < b.fillersPer100Words,
    shorterLongestPause: n.longestPauseSeconds < b.longestPauseSeconds };
}

// ---- One check ---------------------------------------------------------------------------------------------------------------------------
/** One check run for one attempt. Returns { status }: ready, not_assessable, queued (retry later), failed, discarded or skipped. */
async function runPracticeCheck(attemptId, { now = () => new Date(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const at = now();
  const claimed = await claim(attemptId, at);
  if (!claimed) return { status: 'skipped' };
  const mine = { _id: claimed._id, assessmentAttemptKey: claimed.assessmentAttemptKey };
  const context = { attemptId: String(claimed._id), sessionId: String(claimed.sessionId), run: claimed.assessmentAttempts };
  const session = await SpeakingPracticeSession.findById(claimed.sessionId).lean();
  const task = session?.tasks?.find(item => item.taskId === claimed.taskId);
  const criterion = session?.sourceSnapshot?.criteria?.find(item => item.criterionId === task?.criterionId);
  if (!session || !task || !criterion || session.status !== 'ready' || String(session.activeAttemptId) !== String(claimed._id)) {
    await failCheck(mine, claimed, 'COACH_ATTEMPT_DISCARDED');
    return { status: 'discarded' };
  }
  const recording = await AudioRecording.findById(claimed.recordingId).select('_id +derived').lean();
  const answer = String(recording?.derived?.assessorText || '').trim();
  const nowFluency = recording?.derived?.fluency?.available ? recording.derived.fluency : null;
  const wordCount = countWords(answer);
  const finishAs = async (status, fields, passed) => {
    const stored = await SpeakingPracticeAttempt.updateOne(mine, { $set: { status, wordCount, fluency: storedFluency(nowFluency), readyAt: now(),
      assessmentLeaseUntil: null, assessmentNextAttemptAt: null, errorCode: null, ...fields }, $unset: { assessmentQueue: 1 } });
    if (!stored.modifiedCount) return { status: 'discarded' };
    const sessionState = await advanceSession(session._id, claimed._id, task.taskId, passed, now);
    return { status, sessionState };
  };
  const notAssessable = async reason => {
    const out = await finishAs('not_assessable', { notAssessableReason: reason }, false);
    log({ event: 'speaking_coach_attempt_checked', ...context, outcome: 'not_assessable', reason, aiCall: false, wordCount });
    return out;
  };
  const { settings } = readSettings(env);
  if (wordCount < settings.minWords) return notAssessable('not_enough_speech');
  if (nonLatinShare(answer) > 0.3) return notAssessable('not_english');
  if (answer.length > MAX_ANSWER_CHARS) return notAssessable('too_long');

  const previous = await SpeakingPracticeAttempt.findOne({ sessionId: session._id, taskId: task.taskId, status: 'ready', _id: { $ne: claimed._id } })
    .sort({ attemptNumber: -1 }).select('result fluency').lean();
  const before = previous ? { levelReached: previous.result?.levelTitle, notes: previous.result?.feedback?.stillWeak || [], fluency: previous.fluency }
    : { levelReached: criterion.levelTitle, notes: [criterion.comment], fluency: session.sourceSnapshot?.fluency };
  const assignment = await Assignment.findById(session.assignmentId).select('title instructions').lean();
  const levelTitles = criterion.levels.map(level => level.title);
  const forbiddenWords = forbiddenTitles(session.sourceSnapshot.criteria);
  const messages = prompt.checkMessages(prompt.checkInput({ assignment, task, criterion, before, nowFluency, answer, wordsNotToUse: forbiddenWords }));
  const system = messages[0].content;
  let brokenRule = null;
  const validate = raw => { try { return prompt.validateCheck(raw, { levelTitles, forbiddenWords }); } catch (error) { brokenRule = error?.code || null; throw error; } };
  const onAttempt = ({ attemptNumber }) => { const line = attemptNumber > 1 ? retryLine(brokenRule) : ''; messages[0].content = line ? `${system}\n${line}` : system; brokenRule = null; };

  let result;
  try {
    const gateway = require('../aiGateway.service');
    const base = gateway.getAssessmentAIConfig(env);
    result = await gateway.generate({ feature: prompt.CHECK_FEATURE, env, fetchImpl, messages, onAttempt, validate,
      config: { ...base, attemptTimeoutMs: Math.min(base.attemptTimeoutMs || CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS), primaryRetries: 1, fallbackRetries: 0 },
      maxOutputTokens: settings.maxOutputTokens, temperature: 0, responseFormat: 'json', responseSchema: prompt.checkSchema(levelTitles), schemaName: prompt.CHECK_FEATURE,
      retryableSameModelCodes: ['AI_OUTPUT_VALIDATION_FAILED'], metadata: { attemptId: String(claimed._id), purpose: prompt.CHECK_FEATURE } });
  } catch (error) {
    const code = safeCode(error);
    if (claimed.assessmentAttempts < MAX_CHECK_RUNS) {
      await SpeakingPracticeAttempt.updateOne(mine, { $set: { assessmentLeaseUntil: null, assessmentNextAttemptAt: new Date(at.getTime() + RETRY_DELAY_MS) } });
      log({ event: 'speaking_coach_check_retry_scheduled', ...context, code });
      return { status: 'queued', code };
    }
    await failCheck(mine, claimed, 'COACH_CHECK_FAILED');
    return { status: 'failed', code };
  }

  const value = result.value;
  if (!value.assessable) return notAssessable(value.reason);
  const levelPercent = criterion.levels.find(level => level.title === value.level)?.percent;
  const vocab = task.type === 'vocab_swap' ? { used: task.targets.filter(target => usedIn(answer, target)), missing: task.targets.filter(target => !usedIn(answer, target)) } : undefined;
  const vocabOk = !vocab || vocab.used.length >= Math.min(2, task.targets.length);
  const passed = isPassingLevel(levelPercent, criterion.levels, session.settings.passPercent) && value.onTask && vocabOk;
  const usage = result.usage || {};
  const out = await finishAs('ready', { result: { levelTitle: value.level, levelPercent, passed, onTask: value.onTask, ...(vocab ? { vocab } : {}),
    fluencyChange: fluencyChange(before.fluency, nowFluency),
    feedback: { improved: value.improved, stillWeak: value.stillWeak, nextTip: value.nextTip } },
  assessing: { provider: result.provider, model: result.model, promptVersion: prompt.CHECK_PROMPT_VERSION, completedAt: now(),
    inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, costUsd: typeof usage.cost === 'number' ? usage.cost : null } }, passed);
  log({ event: 'speaking_coach_attempt_checked', ...context, outcome: 'ready', taskType: task.type, passed, onTask: value.onTask, sessionState: out.sessionState || null,
    wordCount, inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, costUsd: typeof usage.cost === 'number' ? usage.cost : null });
  return out;
}

module.exports = { MAX_CHECK_RUNS, SWEEP_CAP, onPracticeTranscribed, onTranscriptionFailed, reconcileTranscriptions, sweepPracticeChecks, runPracticeCheck,
  advanceSession, deletePracticeAudio, fluencyChange, usedIn };
