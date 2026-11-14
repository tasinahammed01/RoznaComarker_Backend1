const express = require('express');

const multer = require('multer');

const assignmentController = require('../controllers/assignment.controller');
const flashcardProgressController = require('../controllers/flashcardProgress.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { createUserConcurrencyGuard } = require('../middlewares/concurrency.middleware');
const assignmentReportController = require('../controllers/assignmentReport.controller');

const { body, param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { enforceUsageLimit } = require('../middlewares/usage.middleware');

const router = express.Router();

const rubricUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

/**
 * @openapi
 * tags:
 *   - name: Assignments
 *     description: Assignment management
 */

// Teacher routes
/**
 * @openapi
 * /api/assignments:
 *   post:
 *     tags:
 *       - Assignments
 *     summary: Create assignment (Teacher)
 *     description: |
 *       Requires JWT + role `teacher`.
 *       Usage limit: increments `assignments`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - classId
 *               - deadline
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Homework 1"
 *               classId:
 *                 type: string
 *                 example: "65a000000000000000000010"
 *               deadline:
 *                 type: string
 *                 example: "2026-02-01T12:00:00.000Z"
 *               instructions:
 *                 type: string
 *                 nullable: true
 *               allowLateResubmission:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Assignment created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (role or plan limit)
 *       404:
 *         description: Class not found
 */
router.post(
  '/',
  verifyJwtToken,
  requireRole('teacher'),
  body('title').isString().trim().notEmpty().withMessage('title is required'),
  body('writingType').optional({ nullable: true }).isString().trim().withMessage('writingType must be a string'),
  body('classId').isMongoId().withMessage('Invalid class id'),
  body('deadline').notEmpty().withMessage('deadline is required'),
  body('instructions').optional({ nullable: true }).isString().withMessage('instructions must be a string'),
  body('rubrics').optional({ nullable: true }),
  body('allowLateResubmission').optional().isBoolean().withMessage('allowLateResubmission must be a boolean'),
  body('allowGuestSubmission').optional().isBoolean().withMessage('allowGuestSubmission must be a boolean'),
  body('showMarksToStudent').optional().isBoolean().withMessage('showMarksToStudent must be a boolean'),
  body('allowResubmission').optional().isBoolean().withMessage('allowResubmission must be a boolean'),
  body('maxDrafts').optional({ values: 'null' }).isInt({ min: 2, max: 10 }).withMessage('maxDrafts must be a whole number from 2 to 10').bail().toInt(),
  body('requireAdaptiveBeforeResubmission').optional().isBoolean().withMessage('requireAdaptiveBeforeResubmission must be a boolean'),
  body('resourceType').optional().isIn(['essay', 'flashcard', 'worksheet']).withMessage('resourceType must be essay, flashcard, or worksheet'),
  body('resourceId').optional({ nullable: true }).isString().withMessage('resourceId must be a string'),
  handleValidationResult,
  enforceUsageLimit('assignments', 1),
  assignmentController.createAssignment
);

router.post(
  '/:id/duplicate',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  body('targetClassId').isMongoId().withMessage('Invalid target class id'),
  body('title').isString().trim().notEmpty().withMessage('title is required'),
  body('deadline').notEmpty().withMessage('deadline is required'),
  handleValidationResult,
  enforceUsageLimit('assignments', 1),
  assignmentController.duplicateAssignment
);

/**
 * @openapi
 * /api/assignments/{id}:
 *   patch:
 *     tags:
 *       - Assignments
 *     summary: Update assignment (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               instructions:
 *                 type: string
 *                 nullable: true
 *               allowLateResubmission:
 *                 type: boolean
 *               deadline:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated assignment
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Assignment not found
 */
router.patch(
  '/:id',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  body('title').optional().isString().trim().notEmpty().withMessage('title must be a non-empty string'),
  body('writingType').optional().isString().trim().notEmpty().withMessage('writingType must be a non-empty string'),
  body('instructions').optional({ nullable: true }).isString().withMessage('instructions must be a string'),
  body('rubrics').optional({ nullable: true }),
  body('allowLateResubmission').optional().isBoolean().withMessage('allowLateResubmission must be a boolean'),
  body('allowGuestSubmission').optional().isBoolean().withMessage('allowGuestSubmission must be a boolean'),
  body('showMarksToStudent').optional().isBoolean().withMessage('showMarksToStudent must be a boolean'),
  body('allowResubmission').optional().isBoolean().withMessage('allowResubmission must be a boolean'),
  body('maxDrafts').optional({ values: 'null' }).isInt({ min: 2, max: 10 }).withMessage('maxDrafts must be a whole number from 2 to 10').bail().toInt(),
  body('requireAdaptiveBeforeResubmission').optional().isBoolean().withMessage('requireAdaptiveBeforeResubmission must be a boolean'),
  handleValidationResult,
  assignmentController.updateAssignment
);

router.patch(
  '/:id/rubrics',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  body('rubrics').optional({ nullable: true }),
  body('rubricDesigner').optional({ nullable: true }),
  handleValidationResult,
  assignmentController.updateAssignmentRubrics
);

// Teacher-only: generate rubric designer from a teacher prompt (for assignment rubric modal).
router.post(
  '/generate-rubric-prompt',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  body('prompt').isString().trim().notEmpty().withMessage('prompt is required'),
  body('title').optional().isString().trim().isLength({ max: 200 }),
  body('writingType').optional().isString().trim().isLength({ max: 100 }),
  body('instructions').optional().isString().trim().isLength({ max: 500 }),
  handleValidationResult,
  assignmentController.generateDraftRubricDesignerFromPrompt
);

router.post(
  '/:id/generate-rubric-prompt',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  body('prompt').isString().trim().notEmpty().withMessage('prompt is required'),
  handleValidationResult,
  assignmentController.generateRubricDesignerFromPrompt
);

router.post(
  '/:id/rubric-file',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  rubricUpload.single('file'),
  assignmentController.uploadRubricFileForAssignment
);

/**
 * @openapi
 * /api/assignments/{id}:
 *   delete:
 *     tags:
 *       - Assignments
 *     summary: Delete (deactivate) assignment (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deactivated assignment
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Assignment not found
 */
router.delete(
  '/:id',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.deleteAssignment
);

/**
 * @openapi
 * /api/assignments/class/{classId}:
 *   get:
 *     tags:
 *       - Assignments
 *     summary: List assignments for a class (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: classId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Assignments list
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Class not found
 */
// Improved Writing Model: now one per submission (routes/submission.routes.js, /:submissionId/writing-model/teacher). The old assignment-wide
// endpoints are gone: the assignment-wide model is kept in the database but is no longer served (its teacher sees it read-only in the panel).

// Draft limit (DRAFT_LIMIT_ENABLED): whether the assignment form shows "Maximum drafts". Teachers only; no assignment data.
router.get('/draft-limit/config', verifyJwtToken, requireRole('teacher'), assignmentController.getDraftLimitConfig);

router.get(
  '/class/:classId',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  assignmentController.getClassAssignments
);

router.get(
  '/teacher/:id',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.getAssignmentByIdForTeacher
);

router.get(
  '/:id/evaluations/stale-summary',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.getStaleEvaluationSummary
);

// Whole-assignment report (teacher only; 404 to anyone else). Light aggregated numbers, never raw submissions.
router.get(
  '/:id/report',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  createUserRateLimiter({ limit: 60, windowMs: 5 * 60 * 1000, event: 'API_RATE_LIMITED', reason: 'assignment_report' }),
  createUserConcurrencyGuard({ operation: 'assignment_report', maxConcurrent: 2 }),
  assignmentReportController.getAssignmentReport
);

// AI summary of the report (teacher only, on request, no credit charge; off unless ASSIGNMENT_REPORT_SUMMARY_ENABLED=true).
// 6 per 15 minutes per teacher, one at a time; 5 per assignment per day and at least 3 scored submissions are checked in the service.
router.post(
  '/:id/report/summary',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  createUserRateLimiter({ limit: 6, windowMs: 15 * 60 * 1000, event: 'AI_GENERATION_RATE_LIMITED', reason: 'assignment_report_summary' }),
  createUserConcurrencyGuard({ operation: 'assignment_report_summary', maxConcurrent: 1 }),
  assignmentReportController.postAssignmentSummary
);

router.post(
  '/:id/evaluations/retry-stale',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.retryStaleEvaluations
);

// Student routes — submit flashcard assignment and check own submission
router.post(
  '/:id/submit',
  verifyJwtToken,
  requireRole('student'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.submitFlashcardAssignment
);

router.get(
  '/:id/my-submission',
  verifyJwtToken,
  requireRole('student'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.getMyFlashcardSubmission
);

// Teacher route — view all student submissions for a flashcard assignment
router.get(
  '/:id/submissions',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.getFlashcardAssignmentSubmissions
);

// Teacher route — get detailed progress for all students in a flashcard assignment
// Returns not_started, in_progress, completed statuses for real-time tracking
router.get(
  '/:id/progress',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  flashcardProgressController.getAssignmentProgress
);

/**
 * @openapi
 * /api/assignments/my:
 *   get:
 *     tags:
 *       - Assignments
 *     summary: List assignments for my joined classes (Student)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Assignments list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/my', verifyJwtToken, requireRole('student'), assignmentController.getMyAssignments);

router.get(
  '/qr/:qrToken',
  verifyJwtToken,
  requireRole('student'),
  param('qrToken').isString().trim().notEmpty().withMessage('Invalid QR'),
  handleValidationResult,
  assignmentController.getAssignmentByQrToken
);

/**
 * @openapi
 * /api/assignments/{id}:
 *   get:
 *     tags:
 *       - Assignments
 *     summary: Get assignment details (Student)
 *     description: Student must be an active member of the assignment's class.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Assignment details
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Assignment not found
 */
router.get(
  '/:id',
  verifyJwtToken,
  requireRole('student'),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  assignmentController.getAssignmentById
);

module.exports = router;
