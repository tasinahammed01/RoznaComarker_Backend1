'use strict';
const router = require('express').Router();
const controller = require('../controllers/guestSubmission.controller');
const { requireGuestAccess } = require('../services/guestAccess.service');
const { createSensitiveRateLimiter, createEmailRateLimiter } = require('../middlewares/rateLimit.middleware');
const { upload, setUploadType, handleUploadError, validateUploadedFileSignature } = require('../middlewares/upload.middleware');
const { enforceImagePreflight } = require('../middlewares/imagePreflight.middleware');
const diagnostic=require('../utils/guestPreflightDiagnostics');
// Guest routes are essay-only: a speaking (audio) submission is refused after its link is checked and before any upload is read.
const { refuseAudioSubmission } = require('../middlewares/essayOnly.middleware');
router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});
router.get('/status', (_req, res) => res.json({ success: true, data: { enabled: require('../config/guestSubmission').guestSubmissionEnabled() } }));
// Before guest availability/access/rate limits so early exits are observable too.
router.post(['/assignments/:qrToken/image-preflight','/submissions/:submissionId/image-preflight'],diagnostic.start);
router.use(require('../config/guestSubmission').requireGuestSubmissionEnabled);
router.use(createSensitiveRateLimiter({ limit: 300, windowMs: 15 * 60 * 1000, reason: 'guest_access' }));
router.get('/assignments/:qrToken', controller.entry);
router.post('/assignments/:qrToken/image-preflight', createSensitiveRateLimiter({ limit: 40, windowMs: 15 * 60 * 1000, reason: 'guest_preflight' }),
  diagnostic.stage('guest_context'),controller.prepare, setUploadType('submissions'),diagnostic.stage('image_input'), upload.single('file'), handleUploadError,
  diagnostic.stage('image_signature'),validateUploadedFileSignature,diagnostic.stage('preflight'), require('../middlewares/imagePreflight.middleware').preflightImage);
// Link resend. One IP budget for both paths (generous: a class often shares one school IP) plus a per-address request limit; the
// emails themselves are limited per address by the shared atomic cool-down and hourly cap (recoveryEmailQuota.service).
const recoveryIpLimit = createSensitiveRateLimiter({ limit: 20, windowMs: 15 * 60 * 1000, reason: 'guest_recovery' });
const recoveryEmailLimit = createEmailRateLimiter({ limit: require('../services/recoveryEmailQuota.service').config().requestsPerHour,
  windowMs: 60 * 60 * 1000, reason: 'guest_recovery_email' });
router.post('/assignments/:qrToken/recover', recoveryIpLimit, recoveryEmailLimit, controller.recover);
router.post('/submissions/:submissionId/recover', recoveryIpLimit, recoveryEmailLimit, controller.recover);
router.post('/assignments/:qrToken/submit', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_upload' }),
  controller.prepare, setUploadType('submissions'), upload.array('files', 20), handleUploadError,
  validateUploadedFileSignature, enforceImagePreflight, controller.submit);
router.get('/submissions/:submissionId', requireGuestAccess, refuseAudioSubmission, controller.results);
// Task 20: retry the failed correction stage only. Needs the submission's own link (a read-only portal session is refused by requireGuestAccess).
router.post('/submissions/:submissionId/corrections/retry', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_correction_retry' }),
  requireGuestAccess, refuseAudioSubmission, require('../controllers/submission.controller').retryCorrectionStage);
router.post('/submissions/:submissionId/image-preflight', createSensitiveRateLimiter({ limit: 40, windowMs: 15 * 60 * 1000, reason: 'guest_revision_preflight' }),
  requireGuestAccess, refuseAudioSubmission,diagnostic.stage('guest_context'), controller.prepareRevisionPreview, setUploadType('submissions'),diagnostic.stage('image_input'), upload.single('file'), handleUploadError,
  diagnostic.stage('image_signature'),validateUploadedFileSignature, controller.bindRevisionIdentity,diagnostic.stage('preflight'), require('../middlewares/imagePreflight.middleware').preflightImage);
router.post('/submissions/:submissionId/revise', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_revision_upload' }),
  requireGuestAccess, refuseAudioSubmission, controller.prepareRevision, setUploadType('submissions'), upload.array('files', 20), handleUploadError,
  validateUploadedFileSignature, controller.bindRevisionIdentity, enforceImagePreflight, controller.revise);
router.get('/submissions/:submissionId/presentation', requireGuestAccess, refuseAudioSubmission, controller.presentation);
router.get('/submissions/:submissionId/feedback', requireGuestAccess, refuseAudioSubmission, require('../controllers/feedback.controller').getSubmissionFeedback);
router.get('/submissions/:submissionId/media/:fileId/:filename', requireGuestAccess, refuseAudioSubmission, controller.media);
router.get('/submissions/:submissionId/practice/:sessionId/attempts', requireGuestAccess, refuseAudioSubmission, controller.attempts);
router.get('/submissions/:submissionId/practice', requireGuestAccess, refuseAudioSubmission, controller.practice);
router.post('/submissions/:submissionId/practice', createSensitiveRateLimiter({ limit: 5, reason: 'guest_practice' }), requireGuestAccess, refuseAudioSubmission, controller.practice);
router.post('/submissions/:submissionId/practice/:sessionId/:activityId', createSensitiveRateLimiter({ limit: 20, reason: 'guest_practice_check' }), requireGuestAccess, refuseAudioSubmission, controller.attempt);
router.get('/submissions/:submissionId/drafts', requireGuestAccess, refuseAudioSubmission, controller.drafts);
router.get('/submissions/:submissionId/writing-model', requireGuestAccess, refuseAudioSubmission, require('../controllers/writingModel.controller').forGuest);
router.get('/submissions/:submissionId/ocr-corrections', requireGuestAccess, refuseAudioSubmission, require('../controllers/submission.controller').getOcrCorrections);
router.get('/submissions/:submissionId/pdf', createSensitiveRateLimiter({ limit: 5, reason: 'guest_pdf' }), requireGuestAccess, refuseAudioSubmission, require('../controllers/pdf.controller').downloadSubmissionPdf);
module.exports = router;
