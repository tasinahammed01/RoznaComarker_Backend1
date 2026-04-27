const express = require('express');

const multer = require('multer');

const assignmentController = require('../controllers/assignment.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

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
  body('resourceType').optional().isIn(['essay', 'flashcard', 'worksheet']).withMessage('resourceType must be essay, flashcard, or worksheet'),
  body('resourceId').optional({ nullable: true }).isString().withMessage('resourceId must be a string'),
  handleValidationResult,
  enforceUsageLimit('assignments', 1),
  assignmentController.createAssignment
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
