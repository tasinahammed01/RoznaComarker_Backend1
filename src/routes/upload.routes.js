const express = require('express');

const uploadController = require('../controllers/upload.controller');

const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { enforceStorageLimitFromUploadedFile } = require('../middlewares/usage.middleware');

const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const { tryDeleteUploadedFile } = require('../middlewares/usage.middleware');

const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();
const uploadUserLimiter = createUserRateLimiter({
  windowMs: process.env.UPLOAD_USER_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  limit: process.env.UPLOAD_USER_RATE_LIMIT_MAX || 30,
  event: 'UPLOAD_RATE_LIMITED',
  reason: 'upload_user'
});

function handleUploadValidationResult(req, res, next) {
  const result = validationResult(req);

  if (result.isEmpty()) {
    return next();
  }

  tryDeleteUploadedFile(req.file);

  const first = result.array({ onlyFirstError: true })[0];
  const message = first && first.msg ? String(first.msg) : 'Validation error';

  return res.status(400).json({
    success: false,
    message
  });
}

router.post(
  '/original',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  uploadUserLimiter,
  setUploadType('original'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  body('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  body('submissionId').optional().isMongoId().withMessage('Invalid submission id'),
  handleUploadValidationResult,
  enforceStorageLimitFromUploadedFile(),
  uploadController.uploadOriginal
);

router.post(
  '/processed',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  uploadUserLimiter,
  setUploadType('processed'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  body('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleUploadValidationResult,
  enforceStorageLimitFromUploadedFile(),
  uploadController.uploadProcessed
);

router.post(
  '/transcript',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  uploadUserLimiter,
  body('submissionId').isMongoId().withMessage('Invalid submission id'),
  body('transcriptText').isString().trim().notEmpty().withMessage('transcriptText is required'),
  handleUploadValidationResult,
  uploadController.saveTranscript
);

router.post(
  '/flashcard-image',
  createSensitiveRateLimiter({ event: 'UPLOAD_RATE_LIMITED', reason: 'upload_ip' }),
  verifyJwtToken,
  uploadUserLimiter,
  setUploadType('flashcard'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  uploadController.uploadFlashcardImage
);

module.exports = router;
