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
router.use((_req, res) => res.status(404).json(NOT_FOUND));

module.exports = router;
