'use strict';
// Speaking Coach handlers: /api/speaking-coach (students; the owning teacher's progress) and the guest routes in routes/speakingGuest.routes.js.
// Thin: the rules live in services/speakingCoach. The actor is the signed-in student, or the guest context set by the guest access check
// (never read from the request). Errors: 404 is the hidden-feature body (nothing told apart); other refusals { success: false, code, message };
// anything unexpected is a 503 with a fixed text. Logs carry codes only (never the body, the token or a file name).
const coach = require('../services/speakingCoach/generation.service');
const attempts = require('../services/speakingCoach/attempt.service');
const teacher = require('../services/speakingCoach/teacherProgress.service');
const views = require('../services/speakingCoach/views');
const { speakingCoachEnabled } = require('../services/speakingCoach/policy');
const SpeakingPracticeAttempt = require('../models/SpeakingPracticeAttempt');
const accessContext = require('../services/submissionAccessContext.service');
const notice = require('../config/speakingGuestNotice');
const { withoutInternal } = require('../services/studentTeacherIdentity.service');
const logger = require('../utils/logger');

const NOT_FOUND = Object.freeze({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
const UNAVAILABLE = 'Speaking practice is temporarily unavailable. Please try again.';
const actorOf = req => req.guestAccessContext || req.user?._id;
const sendStudent = (res, status, data) => res.status(status).json({ success: true, data: withoutInternal(data) });

function handleError(res, error) {
  const status = Number(error?.statusCode || error?.status);
  if (status === 404) return res.status(404).json(NOT_FOUND);
  const known = Number.isInteger(status) && status >= 400 && status < 500;
  logger.warn({ event: 'speaking_coach_request_failed', code: /^[A-Z_]{1,60}$/.test(error?.code || '') ? error.code : 'SPEAKING_COACH_FAILED' });
  return res.status(known ? status : 503).json({ success: false, code: known ? error.code || 'COACH_REQUEST_INVALID' : 'SPEAKING_COACH_UNAVAILABLE',
    message: known ? error.message : UNAVAILABLE });
}

/** The hidden-feature 404 while SPEAKING_COACH_ENABLED is off (used on the guest routes; the student router has its own). */
function requireEnabled(_req, res, next) { return speakingCoachEnabled() ? next() : res.status(404).json(NOT_FOUND); }

const attemptsOf = sessionId => SpeakingPracticeAttempt.find({ sessionId }).select('_id taskId attemptNumber status notAssessableReason errorCode result createdAt').lean();

/** { state, session, overview[, notice] } for the student or guest. */
async function sessionPayload(out, actor) {
  const data = { state: out.state, session: out.session ? views.studentSession(out.session, await attemptsOf(out.session._id)) : null,
    overview: coach.overviewOf(out) };
  if (accessContext.isGuest(actor)) {
    data.notice = { version: notice.SPEAKING_COACH_NOTICE_VERSION, text: notice.SPEAKING_COACH_NOTICE_TEXT,
      accepted: out.session?.guestNotice?.version === notice.SPEAKING_COACH_NOTICE_VERSION };
  }
  return data;
}

/** { session, attempt } for the student or guest. */
async function attemptPayload(sessionId, attemptId, actor) {
  const { session, attempt } = await attempts.getAttempt({ sessionId, attemptId, actor });
  const all = await attemptsOf(session._id);
  const latest = [...all].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  return { session: views.studentSession(session, all), attempt: views.studentAttempt(attempt, session, latest?._id) };
}

async function getSession(req, res) {
  try { const actor = actorOf(req); return sendStudent(res, 200, await sessionPayload(await coach.getSession(req.params.submissionId, actor), actor)); }
  catch (error) { return handleError(res, error); }
}

async function start(req, res) {
  try {
    const actor = actorOf(req);
    const out = await coach.startSession(req.params.submissionId, actor, { noticeVersion: req.body?.noticeVersion });
    return sendStudent(res, out.state === 'generating' ? 202 : 200, await sessionPayload(out, actor));
  } catch (error) { return handleError(res, error); }
}

/** Before the file is read: the checks; a request already stored answers with its attempt (no file is kept). */
async function prepareAttempt(req, res, next) {
  try {
    const actor = actorOf(req);
    const context = await attempts.prepareAttempt({ sessionId: req.params.sessionId, taskId: req.params.taskId, actor, requestId: req.get('Idempotency-Key') });
    if (context.replay) return sendStudent(res, 200, await attemptPayload(req.params.sessionId, context.replay._id, actor));
    req.coachContext = context;
    return next();
  } catch (error) { return handleError(res, error); }
}

/** The task's own maximum for the upload checks (never above the policy). */
const maxDurationFor = req => req.coachContext?.maxSeconds;

async function commitAttempt(req, res) {
  try {
    const actor = actorOf(req);
    const attempt = await attempts.commitAttempt({ context: req.coachContext, upload: req.audioUpload, actor });
    return sendStudent(res, 202, await attemptPayload(req.params.sessionId, attempt._id, actor));
  } catch (error) { return handleError(res, error); }
}

async function getAttempt(req, res) {
  try { return sendStudent(res, 200, await attemptPayload(req.params.sessionId, req.params.attemptId, actorOf(req))); }
  catch (error) { return handleError(res, error); }
}

async function retry(req, res) {
  try {
    const actor = actorOf(req);
    await attempts.retryCheck({ sessionId: req.params.sessionId, attemptId: req.params.attemptId, actor });
    return sendStudent(res, 202, await attemptPayload(req.params.sessionId, req.params.attemptId, actor));
  } catch (error) { return handleError(res, error); }
}

async function teacherProgress(req, res) {
  try { return res.json({ success: true, data: await teacher.getProgress(req.params.submissionId, req.user._id) }); }
  catch (error) { return handleError(res, error); }
}

async function teacherAttempts(req, res) {
  try { return res.json({ success: true, data: await teacher.getAttempts(req.params.sessionId, req.params.taskId, req.user._id, req.query.page, req.query.limit) }); }
  catch (error) { return handleError(res, error); }
}

module.exports = { NOT_FOUND, requireEnabled, getSession, start, prepareAttempt, maxDurationFor, commitAttempt, getAttempt, retry, teacherProgress, teacherAttempts };
