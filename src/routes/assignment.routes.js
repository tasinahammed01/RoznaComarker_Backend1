const express = require('express');

const assignmentController = require('../controllers/assignment.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { body, param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { enforceUsageLimit } = require('../middlewares/usage.middleware');

const router = express.Router();

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
  body('classId').isMongoId().withMessage('Invalid class id'),
  body('deadline').notEmpty().withMessage('deadline is required'),
  body('instructions').optional({ nullable: true }).isString().withMessage('instructions must be a string'),
  body('allowLateResubmission').optional().isBoolean().withMessage('allowLateResubmission must be a boolean'),
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
  body('instructions').optional({ nullable: true }).isString().withMessage('instructions must be a string'),
  body('allowLateResubmission').optional().isBoolean().withMessage('allowLateResubmission must be a boolean'),
  handleValidationResult,
  assignmentController.updateAssignment
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

// Student routes
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
