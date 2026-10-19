'use strict';
const router = require('express').Router();
const controller = require('../controllers/guestSubmission.controller');
const { requireGuestAccess } = require('../services/guestAccess.service');
const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');
const { upload, setUploadType, handleUploadError, validateUploadedFileSignature } = require('../middlewares/upload.middleware');
const { enforceImagePreflight } = require('../middlewares/imagePreflight.middleware');
router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});
router.use(createSensitiveRateLimiter({ limit: 60, windowMs: 15 * 60 * 1000, reason: 'guest_access' }));
router.get('/assignments/:qrToken', controller.entry);
router.post('/assignments/:qrToken/recover', createSensitiveRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000, reason: 'guest_recovery' }), controller.recover);
router.post('/assignments/:qrToken/submit', createSensitiveRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, reason: 'guest_upload' }),
  controller.prepare, setUploadType('submissions'), upload.array('files', 20), handleUploadError,
  validateUploadedFileSignature, enforceImagePreflight, controller.submit);
router.get('/submissions/:submissionId', requireGuestAccess, controller.results);
router.get('/submissions/:submissionId/practice', requireGuestAccess, controller.practice);
router.post('/submissions/:submissionId/practice', createSensitiveRateLimiter({ limit: 5, reason: 'guest_practice' }), requireGuestAccess, controller.practice);
router.post('/submissions/:submissionId/practice/:sessionId/:activityId', createSensitiveRateLimiter({ limit: 20, reason: 'guest_practice_check' }), requireGuestAccess, controller.attempt);
router.get('/submissions/:submissionId/drafts', requireGuestAccess, controller.drafts);
router.get('/submissions/:submissionId/ocr-corrections', requireGuestAccess, require('../controllers/submission.controller').getOcrCorrections);
router.get('/submissions/:submissionId/pdf', createSensitiveRateLimiter({ limit: 5, reason: 'guest_pdf' }), requireGuestAccess, require('../controllers/pdf.controller').downloadSubmissionPdf);
module.exports = router;
