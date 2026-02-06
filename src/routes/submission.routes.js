const express = require('express');

const submissionController = require('../controllers/submission.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

const {
  enforceStorageLimitFromUploadedFile
} = require('../middlewares/usage.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Submissions
 *     description: Student submissions for assignments
 */

/**
 * @openapi
 * /api/submissions/qr/{qrToken}:
 *   post:
 *     tags:
 *       - Submissions
 *     summary: Submit using assignment QR token (Student)
 *     description: |
 *       Requires JWT + role `student`.
 *       Upload a file as `multipart/form-data` field `file`.
 *       Enforces storage limit (plan `storageMB`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: qrToken
 *         required: true
 *         schema:
 *           type: string
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
 *         description: Submission created/updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded / deadline passed
 *       404:
 *         description: Invalid QR / assignment not found
 */
router.post(
  '/qr/:qrToken',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  param('qrToken').isString().trim().notEmpty().withMessage('Invalid QR'),
  handleValidationResult,
  setUploadType('submissions'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  submissionController.submitByQrToken
);

router.post(
  '/upload',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  setUploadType('submissions'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  submissionController.uploadHandwrittenForOcr
);

/**
 * @openapi
 * /api/submissions/{assignmentId}:
 *   post:
 *     tags:
 *       - Submissions
 *     summary: Submit using assignment id (Student)
 *     description: Upload a file as `multipart/form-data` field `file`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: string
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
 *         description: Submission created/updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded / deadline passed
 *       404:
 *         description: Assignment not found
 *       409:
 *         description: Already submitted (in some race conditions)
 */
router.post(
  '/:assignmentId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  setUploadType('submissions'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  submissionController.submitByAssignmentId
);

router.get(
  '/assignment/:assignmentId/my',
  verifyJwtToken,
  requireRole('student'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getMySubmissionByAssignmentId
);

/**
 * @openapi
 * /api/submissions/assignment/{assignmentId}:
 *   get:
 *     tags:
 *       - Submissions
 *     summary: List submissions for an assignment (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Submissions list
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Assignment/Class not found
 */
router.get(
  '/assignment/:assignmentId',
  verifyJwtToken,
  requireRole('teacher'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getSubmissionsByAssignment
);

/**
 * @openapi
 * /api/submissions/my:
 *   get:
 *     tags:
 *       - Submissions
 *     summary: List my submissions (Student)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submissions list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/my', verifyJwtToken, requireRole('student'), submissionController.getMySubmissions);

router.post(
  '/:submissionId/ocr-corrections',
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  submissionController.getOcrCorrections
);

router.get(
  '/:assignmentId',
  verifyJwtToken,
  requireRole('student'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getMySubmissionByAssignmentId
);

module.exports = router;
