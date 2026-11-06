'use strict';
const router = require('express').Router();
const controller = require('../controllers/guestSubmission.controller');
const { requireGuestAccess } = require('../services/guestAccess.service');
const { createSensitiveRateLimiter, createEmailRateLimiter } = require('../middlewares/rateLimit.middleware');
const { upload, setUploadType, handleUploadError, validateUploadedFileSignature } = require('../middlewares/upload.middleware');
const { enforceImagePreflight } = require('../middlewares/imagePreflight.middleware');
const diagnostic=require('../utils/guestPreflightDiagnostics');
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
router.get('/submissions/:submissionId', requireGuestAccess, controller.results);
// Task 20: retry the failed correction stage only. Needs the submission's own link (a read-only portal session is refused by requireGuestAccess).
router.post('/submissions/:submissionId/corrections/retry', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_correction_retry' }),
  requireGuestAccess, require('../controllers/submission.controller').retryCorrectionStage);
router.post('/submissions/:submissionId/image-preflight', createSensitiveRateLimiter({ limit: 40, windowMs: 15 * 60 * 1000, reason: 'guest_revision_preflight' }),
  requireGuestAccess,diagnostic.stage('guest_context'), controller.prepareRevisionPreview, setUploadType('submissions'),diagnostic.stage('image_input'), upload.single('file'), handleUploadError,
  diagnostic.stage('image_signature'),validateUploadedFileSignature, controller.bindRevisionIdentity,diagnostic.stage('preflight'), require('../middlewares/imagePreflight.middleware').preflightImage);
router.post('/submissions/:submissionId/revise', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_revision_upload' }),
  requireGuestAccess, controller.prepareRevision, setUploadType('submissions'), upload.array('files', 20), handleUploadError,
  validateUploadedFileSignature, controller.bindRevisionIdentity, enforceImagePreflight, controller.revise);
router.get('/submissions/:submissionId/presentation', requireGuestAccess, controller.presentation);
router.get('/submissions/:submissionId/feedback', requireGuestAccess, require('../controllers/feedback.controller').getSubmissionFeedback);
router.get('/submissions/:submissionId/media/:fileId/:filename', requireGuestAccess, controller.media);
router.get('/submissions/:submissionId/practice/:sessionId/attempts', requireGuestAccess, controller.attempts);
router.get('/submissions/:submissionId/practice', requireGuestAccess, controller.practice);
router.post('/submissions/:submissionId/practice', createSensitiveRateLimiter({ limit: 5, reason: 'guest_practice' }), requireGuestAccess, controller.practice);
router.post('/submissions/:submissionId/practice/:sessionId/:activityId', createSensitiveRateLimiter({ limit: 20, reason: 'guest_practice_check' }), requireGuestAccess, controller.attempt);
router.get('/submissions/:submissionId/drafts', requireGuestAccess, controller.drafts);
router.get('/submissions/:submissionId/ocr-corrections', requireGuestAccess, require('../controllers/submission.controller').getOcrCorrections);
router.get('/submissions/:submissionId/pdf', createSensitiveRateLimiter({ limit: 5, reason: 'guest_pdf' }), requireGuestAccess, require('../controllers/pdf.controller').downloadSubmissionPdf);
module.exports = router;
