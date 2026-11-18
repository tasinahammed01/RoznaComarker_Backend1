'use strict';
// /api/speaking: speaking assignments (audio + speech-to-text). Behind AUDIO_STT_ENABLED (default off): while off, EVERY route answers 404 with
// the same body as the other switched-off feature routers, before sign-in is checked.
//   POST /:assignmentId                                   class student: upload (create or replace) one recording, field "audio",
//                                                         header Idempotency-Key. Checks before the file is read, then the upload checks.
//   GET  /:assignmentId/my                                class student: their own status and the limits
//   POST /submissions/:submissionId/retry-transcription   the student who owns it or the owning teacher; 404 for anyone else
//   GET  /submissions/:submissionId                       the owning teacher: the job state; 404 for other teachers
//   GET  /submissions/:submissionId/result                the assessment result: the owning student or teacher; 404 for anyone else
//   POST /submissions/:submissionId/retry-assessment      the owning teacher: a failed or blocked assessment again; 404 for anyone else
// Playback and download are private audio routes in audio.routes.js.
const router = require('express').Router();
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { audioUpload } = require('../middlewares/audioUpload.middleware');
const { audioSttEnabled } = require('../services/audio/policy');
const controller = require('../controllers/speaking.controller');

const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const limit = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
// SPEAKING_UPLOAD_RATE_LIMIT_MAX (default 30) uploads and 30 retries per 15 minutes per user.
const uploadLimiter = createUserRateLimiter({ windowMs: 15 * 60 * 1000, limit: limit('SPEAKING_UPLOAD_RATE_LIMIT_MAX', 30), event: 'UPLOAD_RATE_LIMITED',
  reason: 'speaking_upload_user' });
const retryLimiter = createUserRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30, event: 'UPLOAD_RATE_LIMITED', reason: 'speaking_retry_user' });

router.use((req, res, next) => (audioSttEnabled() ? next() : res.status(404).json(NOT_FOUND)));
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.post('/submissions/:submissionId/retry-transcription', verifyJwtToken, retryLimiter, controller.retry);
router.get('/submissions/:submissionId', verifyJwtToken, requireRole('teacher'), controller.teacherView);
router.get('/submissions/:submissionId/result', verifyJwtToken, controller.result);
router.post('/submissions/:submissionId/retry-assessment', verifyJwtToken, retryLimiter, controller.retryAssessment);
router.get('/:assignmentId/my', verifyJwtToken, requireRole('student'), controller.myStatus);
router.post('/:assignmentId', verifyJwtToken, requireRole('student'), uploadLimiter, controller.prepare,
  ...audioUpload({ maxDurationSeconds: controller.maxDurationFor }), controller.commit);
router.use((_req, res) => res.status(404).json(NOT_FOUND));

module.exports = router;
