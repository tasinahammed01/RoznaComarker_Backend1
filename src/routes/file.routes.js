const express = require('express');

const fileController = require('../controllers/file.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { enforceStorageLimitFromUploadedFile } = require('../middlewares/usage.middleware');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Files
 *     description: Standalone file upload endpoints
 */

/**
 * @openapi
 * /api/files/assignment:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload an assignment file (Teacher)
 *     description: |
 *       Requires JWT + role `teacher`.
 *       Upload a file as `multipart/form-data` field `file`.
 *       Allowed types: PDF, JPG/JPEG, PNG.
 *       Enforces storage limit (plan `storageMB`).
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Uploaded file metadata
 *       400:
 *         description: Validation error / invalid file type
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded
 *       413:
 *         description: File too large
 */
router.post(
  '/assignment',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  setUploadType('assignments'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  fileController.uploadAssignmentFile
);

/**
 * @openapi
 * /api/files/submission:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload a submission file (Student)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Uploaded file metadata
 *       400:
 *         description: Validation error / invalid file type
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded
 *       413:
 *         description: File too large
 */
router.post(
  '/submission',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  setUploadType('submissions'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  fileController.uploadSubmissionFile
);

/**
 * @openapi
 * /api/files/feedback:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload a feedback file (Teacher)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Uploaded file metadata
 *       400:
 *         description: Validation error / invalid file type
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded
 *       413:
 *         description: File too large
 */
router.post(
  '/feedback',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  setUploadType('feedback'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  fileController.uploadFeedbackFile
);

module.exports = router;
