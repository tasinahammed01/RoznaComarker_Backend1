'use strict';
// /api/speaking/assignments/:assignmentId/teacher-uploads (stage 9): a teacher uploads a student's recording. The essay teacher-upload routes'
// shape (routes/teacherUpload.routes.js), for speaking assignments only. Behind AUDIO_STT_ENABLED like every speaking route: while off, every
// route answers the same 404 before sign-in. Teachers only; the service answers 404 unless this teacher owns the assignment and its class.
//   GET  /                        the teacher's uploads for this assignment, and credits
//   POST /check                   validate students (account, existing recording, credits), as the essay dialog's step 1
//   POST /                        one student's recording: multipart field "audio" plus name, email, requestKey, batchId, mode, send
//   POST /:submissionId/send      Send, or Resend ({ resend: true, requestId })
//   POST /:submissionId/retry     transcription or marking again
const router = require('express').Router({ mergeParams: true });
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { audioUpload } = require('../middlewares/audioUpload.middleware');
const { audioSttEnabled } = require('../services/audio/policy');
const controller = require('../controllers/speakingTeacherUpload.controller');

const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
// The essay teacher-upload limits, with their own reasons (the same environment overrides apply).
const checkLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: 120, event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'speaking_teacher_upload_check' });
const uploadLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: Number(process.env.TEACHER_UPLOAD_RATE_LIMIT_MAX) || 400,
  event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'speaking_teacher_upload_save' });
const retryLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: 60, event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'speaking_teacher_upload_retry' });
const sendLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: Number(process.env.TEACHER_UPLOAD_SEND_RATE_LIMIT_MAX) || 60,
  event: 'TEACHER_UPLOAD_SEND_RATE_LIMITED', reason: 'speaking_teacher_upload_send' });

router.use((_req, res, next) => (audioSttEnabled() ? next() : res.status(404).json(NOT_FOUND)));
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/', verifyJwtToken, requireRole('teacher'), checkLimiter, controller.list);
router.post('/check', verifyJwtToken, requireRole('teacher'), checkLimiter, controller.check);
// Six text fields (name, email, requestKey, batchId, mode, send) before the one file.
router.post('/', verifyJwtToken, requireRole('teacher'), uploadLimiter, controller.prepare,
  ...audioUpload({ maxDurationSeconds: controller.maxDurationFor, maxFields: 6 }), controller.save);
router.post('/:submissionId/send', verifyJwtToken, requireRole('teacher'), sendLimiter, controller.send);
router.post('/:submissionId/retry', verifyJwtToken, requireRole('teacher'), retryLimiter, controller.retry);
router.use((_req, res) => res.status(404).json(NOT_FOUND));

module.exports = router;
