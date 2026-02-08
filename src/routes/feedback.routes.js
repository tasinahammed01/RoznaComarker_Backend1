const express = require('express');

const feedbackController = require('../controllers/feedback.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { enforceStorageLimitFromUploadedFile } = require('../middlewares/usage.middleware');

const { param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Feedback
 *     description: Teacher feedback on student submissions
 */

/**
 * @openapi
 * /api/feedback/{submissionId}:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Create feedback for a submission (Teacher)
 *     description: |
 *       Requires JWT + role `teacher`.
 *       Supports optional file upload (`multipart/form-data`, field `file`) plus other fields.
 *       Enforces storage limit (plan `storageMB`) when a file is uploaded.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               textFeedback:
 *                 type: string
 *                 nullable: true
 *               score:
 *                 type: number
 *                 nullable: true
 *               maxScore:
 *                 type: number
 *                 nullable: true
 *               annotations:
 *                 description: JSON array (string) or array of objects
 *                 nullable: true
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Feedback created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Submission/Assignment not found
 *       409:
 *         description: Feedback already exists
 */
router.post(
  '/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  setUploadType('feedback'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  feedbackController.createFeedback
);

router.post(
  '/ai/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.generateAiFeedbackFromOcr
);

// Canonical submission feedback API (teacher + student read, teacher write)
router.get(
  '/:submissionId',
  verifyJwtToken,
  requireRole(['teacher', 'student']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.getSubmissionFeedback
);

// Teacher-only: (re)generate AI defaults for a submission and persist them.
router.post(
  '/:submissionId/generate-ai',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.generateAiSubmissionFeedback
);

router.put(
  '/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.upsertSubmissionFeedback
);

/**
 * @openapi
 * /api/feedback/{feedbackId}:
 *   put:
 *     tags:
 *       - Feedback
 *     summary: Update feedback (Teacher)
 *     description: Optional file upload supported.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: feedbackId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               textFeedback:
 *                 type: string
 *                 nullable: true
 *               score:
 *                 type: number
 *                 nullable: true
 *               maxScore:
 *                 type: number
 *                 nullable: true
 *               annotations:
 *                 description: JSON array (string) or array of objects
 *                 nullable: true
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Feedback updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Feedback not found
 */
router.put(
  '/:feedbackId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('feedbackId').isMongoId().withMessage('Invalid feedback id'),
  handleValidationResult,
  setUploadType('feedback'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  feedbackController.updateFeedback
);

/**
 * @openapi
 * /api/feedback/submission/{submissionId}:
 *   get:
 *     tags:
 *       - Feedback
 *     summary: Get feedback for a submission (Student)
 *     description: Student can only access feedback for their own submission.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Feedback
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Feedback not found
 */
router.get(
  '/submission/:submissionId',
  verifyJwtToken,
  requireRole('student'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.getFeedbackBySubmissionForStudent
);

// Teacher: fetch feedback by submissionId (Feedback collection is the source of truth).
router.get(
  '/submission/teacher/:submissionId',
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.getFeedbackBySubmissionForTeacher
);

router.get(
  '/student/:submissionId',
  verifyJwtToken,
  requireRole('student'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  feedbackController.getFeedbackBySubmissionForStudent
);

router.get(
  '/teacher/:classId',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  feedbackController.listFeedbackByClassForTeacher
);

/**
 * @openapi
 * /api/feedback/{feedbackId}:
 *   get:
 *     tags:
 *       - Feedback
 *     summary: Get feedback by id (Teacher)
 *     description: Teacher must be the class teacher for this feedback.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: feedbackId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Feedback
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Feedback not found
 */
router.get(
  '/by-id/:feedbackId',
  verifyJwtToken,
  requireRole('teacher'),
  param('feedbackId').isMongoId().withMessage('Invalid feedback id'),
  handleValidationResult,
  feedbackController.getFeedbackByIdForTeacher
);

module.exports = router;
