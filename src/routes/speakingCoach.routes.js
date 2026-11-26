'use strict';
// /api/speaking-coach: Speaking Coach (practice after a speaking result). Behind SPEAKING_COACH_ENABLED (default off) and AUDIO_STT_ENABLED: while
// off, EVERY route answers 404 with the same body as the other switched-off feature routers, before sign-in is checked.
//   GET  /submissions/:submissionId                          the owning student: the practice state and session
//   POST /submissions/:submissionId/start                    the owning student: start (or return) the practice session
//   POST /sessions/:sessionId/tasks/:taskId/attempts         the owning student: one practice recording, field "audio", header Idempotency-Key
//   GET  /sessions/:sessionId/attempts/:attemptId            the owning student: the attempt state and feedback
//   POST /sessions/:sessionId/attempts/:attemptId/retry      the owning student: check a failed check again (does not use the cap)
//   GET  /teacher/submissions/:submissionId/progress         the owning teacher: practice progress (404 for other teachers)
//   GET  /teacher/sessions/:sessionId/tasks/:taskId/attempts the owning teacher: one task's attempt history (404 for other teachers)
// Anyone but the owner gets 404. Guests use /api/guest/speaking/submissions/:submissionId/coach (routes/speakingGuest.routes.js).
const router = require('express').Router();
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter, createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');
const { audioUpload } = require('../middlewares/audioUpload.middleware');
const controller = require('../controllers/speakingCoach.controller');

const MINUTES_15 = 15 * 60 * 1000;
const limit = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
// SPEAKING_COACH_UPLOAD_RATE_LIMIT_MAX (default 10) practice uploads per user per 15 minutes; 5 starts and 10 retries.
const startLimiter = createUserRateLimiter({ windowMs: MINUTES_15, limit: 5, event: 'AI_GENERATION_RATE_LIMITED', reason: 'speaking_coach_start_user' });
const uploadLimiter = createUserRateLimiter({ windowMs: MINUTES_15, limit: limit('SPEAKING_COACH_UPLOAD_RATE_LIMIT_MAX', 10), event: 'UPLOAD_RATE_LIMITED',
  reason: 'speaking_coach_upload_user' });
const retryLimiter = createUserRateLimiter({ windowMs: MINUTES_15, limit: 10, event: 'AI_GENERATION_RATE_LIMITED', reason: 'speaking_coach_retry_user' });

router.use(controller.requireEnabled);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/teacher/submissions/:submissionId/progress', verifyJwtToken, requireRole('teacher'), controller.teacherProgress);
router.get('/teacher/sessions/:sessionId/tasks/:taskId/attempts', verifyJwtToken, requireRole('teacher'), controller.teacherAttempts);
router.get('/submissions/:submissionId', verifyJwtToken, requireRole('student'), controller.getSession);
router.post('/submissions/:submissionId/start', createSensitiveRateLimiter({ limit: 30, windowMs: MINUTES_15, reason: 'speaking_coach_start_ip' }),
  verifyJwtToken, requireRole('student'), startLimiter, controller.start);
router.post('/sessions/:sessionId/tasks/:taskId/attempts', verifyJwtToken, requireRole('student'), uploadLimiter, controller.prepareAttempt,
  ...audioUpload({ maxDurationSeconds: controller.maxDurationFor }), controller.commitAttempt);
router.get('/sessions/:sessionId/attempts/:attemptId', verifyJwtToken, requireRole('student'), controller.getAttempt);
router.post('/sessions/:sessionId/attempts/:attemptId/retry', verifyJwtToken, requireRole('student'), retryLimiter, controller.retry);
router.use((_req, res) => res.status(404).json(controller.NOT_FOUND));

module.exports = router;
