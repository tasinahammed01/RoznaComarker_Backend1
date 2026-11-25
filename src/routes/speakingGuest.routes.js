'use strict';
// /api/guest/speaking: guests on speaking assignments (stage 10). Mounted BEFORE /api/guest in app.js; it answers every request that reaches it.
// Switched off, in this order: AUDIO_STT_ENABLED off -> the hidden-feature 404 (as /api/speaking, before anything else); guest submission off ->
// the essay guest 403 (GUEST_SUBMISSION_UNAVAILABLE). Per-IP limits are the essay guest values (routes/guestSubmission.routes.js).
//   GET  /assignments/:qrToken            the guest page: the task, the recording limits, the notice to accept
//   POST /assignments/:qrToken/submit     one recording, field "audio", fields name, email, consent, consentVersion; header Idempotency-Key
//   POST /assignments/:qrToken/recover    "Lost your link?": the same public answer for every address; the resend runs afterwards
//   GET  /submissions/:submissionId       the guest's own result (X-Guest-Token, or a read-only recovery-portal session)
//   GET  /submissions/:submissionId/media the guest's own recording: Range, private no-store, nosniff, the stored content type
// Any other caller of a submission route (another guest, a student, a teacher, no link) gets one 404 (GUEST_LINK_INVALID).
const router = require('express').Router();
const { createSensitiveRateLimiter, createEmailRateLimiter } = require('../middlewares/rateLimit.middleware');
const { audioUpload } = require('../middlewares/audioUpload.middleware');
const { audioSttEnabled } = require('../services/audio/policy');
const controller = require('../controllers/speakingGuest.controller');
const media = require('../controllers/audioMedia.controller');

const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const MINUTES_15 = 15 * 60 * 1000;

router.use((req, res, next) => (audioSttEnabled() ? next() : res.status(404).json(NOT_FOUND)));
router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});
router.use(require('../config/guestSubmission').requireGuestSubmissionEnabled);
router.use(createSensitiveRateLimiter({ limit: 300, windowMs: MINUTES_15, reason: 'guest_speaking_access' }));

router.get('/assignments/:qrToken', controller.entry);
router.post('/assignments/:qrToken/submit', createSensitiveRateLimiter({ limit: 10, windowMs: MINUTES_15, reason: 'guest_speaking_upload' }),
  controller.prepare, ...audioUpload({ maxDurationSeconds: controller.maxDurationFor }), controller.submit);
router.post('/assignments/:qrToken/recover', createSensitiveRateLimiter({ limit: 20, windowMs: MINUTES_15, reason: 'guest_recovery' }),
  createEmailRateLimiter({ limit: require('../services/recoveryEmailQuota.service').config().requestsPerHour, windowMs: 60 * 60 * 1000, reason: 'guest_recovery_email' }),
  controller.recover);
router.get('/submissions/:submissionId', controller.requireSpeakingGuest, controller.result);
router.get('/submissions/:submissionId/media', controller.requireSpeakingGuest, media.guestMedia);
// Speaking Coach for guests (SPEAKING_COACH_ENABLED, default off: the hidden-feature 404). The guest's own link only (a recovery-portal session is
// read-only: GET). The practice notice must be accepted (start, noticeVersion) before the first practice recording. Per-IP limits; the attempt cap
// per submission is the real guard (a device cannot be identified).
//   GET  /submissions/:submissionId/coach                                           the practice state, session and notice
//   POST /submissions/:submissionId/coach/start                                     start (or return) the session; body noticeVersion
//   POST /submissions/:submissionId/coach/sessions/:sessionId/tasks/:taskId/attempts one practice recording, field "audio", header Idempotency-Key
//   GET  /submissions/:submissionId/coach/sessions/:sessionId/attempts/:attemptId   the attempt state and feedback
//   POST /submissions/:submissionId/coach/sessions/:sessionId/attempts/:attemptId/retry  check a failed check again
const coach = require('../controllers/speakingCoach.controller');
router.get('/submissions/:submissionId/coach', coach.requireEnabled, controller.requireSpeakingGuest, coach.getSession);
router.post('/submissions/:submissionId/coach/start', coach.requireEnabled, createSensitiveRateLimiter({ limit: 10, windowMs: MINUTES_15, reason: 'guest_speaking_coach_start' }),
  controller.requireSpeakingGuest, coach.start);
router.post('/submissions/:submissionId/coach/sessions/:sessionId/tasks/:taskId/attempts', coach.requireEnabled,
  createSensitiveRateLimiter({ limit: 20, windowMs: MINUTES_15, reason: 'guest_speaking_coach_upload' }), controller.requireSpeakingGuest, coach.prepareAttempt,
  ...audioUpload({ maxDurationSeconds: coach.maxDurationFor }), coach.commitAttempt);
router.get('/submissions/:submissionId/coach/sessions/:sessionId/attempts/:attemptId', coach.requireEnabled, controller.requireSpeakingGuest, coach.getAttempt);
router.post('/submissions/:submissionId/coach/sessions/:sessionId/attempts/:attemptId/retry', coach.requireEnabled,
  createSensitiveRateLimiter({ limit: 20, windowMs: MINUTES_15, reason: 'guest_speaking_coach_retry' }), controller.requireSpeakingGuest, coach.retry);
router.use((_req, res) => res.status(404).json(NOT_FOUND));

module.exports = router;
