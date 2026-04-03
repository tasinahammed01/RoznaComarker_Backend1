const express = require('express');

const classController = require('../controllers/class.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { body, param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { enforceUsageLimit, enforceStorageLimitFromUploadedFile } = require('../middlewares/usage.middleware');

const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Classes
 *     description: Class management (teacher creates classes, students join via join code)
 */

/**
 * @openapi
 * /api/classes:
 *   post:
 *     tags:
 *       - Classes
 *     summary: Create a class (Teacher)
 *     description: |
 *       Requires JWT and role `teacher`.
 *       Usage limit: increments `classes` and enforces plan limit.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Math 101"
 *               description:
 *                 type: string
 *                 nullable: true
 *                 example: "Morning section"
 *     responses:
 *       200:
 *         description: Class created
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (role or plan limit)
 */
router.post(
  '/',
  verifyJwtToken,
  requireRole('teacher'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').optional({ nullable: true }).isString().withMessage('description must be a string'),
  body('subjectLevel').optional({ nullable: true }).isString().trim().withMessage('subjectLevel must be a string'),
  body('startDate').optional({ nullable: true }).isISO8601().withMessage('startDate must be a valid date'),
  body('endDate').optional({ nullable: true }).isISO8601().withMessage('endDate must be a valid date'),
  handleValidationResult,
  enforceUsageLimit('classes', 1),
  classController.createClass
);

/**
 * @openapi
 * /api/classes/mine:
 *   get:
 *     tags:
 *       - Classes
 *     summary: List my classes (Teacher)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of classes for the authenticated teacher
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/mine',
  verifyJwtToken,
  requireRole('teacher'),
  classController.getMyClasses
);

router.get(
  '/:classId/students',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  classController.getClassStudents
);

router.delete(
  '/:classId/students/:studentId',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  param('studentId').isMongoId().withMessage('Invalid student id'),
  handleValidationResult,
  classController.removeStudentFromClass
);

router.get(
  '/:classId/summary',
  verifyJwtToken,
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  classController.getClassSummary
);

/**
 * @openapi
 * /api/classes/{id}:
 *   put:
 *     tags:
 *       - Classes
 *     summary: Update a class (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Math 101 (Updated)"
 *               description:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated class
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Class not found
 */
router.put(
  '/:id',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid class id'),
  body('name').optional().isString().trim().notEmpty().withMessage('name must be a non-empty string'),
  body('description').optional({ nullable: true }).isString().withMessage('description must be a string'),
  body('subjectLevel').optional({ nullable: true }).isString().trim().withMessage('subjectLevel must be a string'),
  body('startDate').optional({ nullable: true }).isISO8601().withMessage('startDate must be a valid date'),
  body('endDate').optional({ nullable: true }).isISO8601().withMessage('endDate must be a valid date'),
  handleValidationResult,
  classController.updateClass
);

router.post(
  '/:id/banner',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  setUploadType('class-banners'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
  classController.uploadClassBanner
);

/**
 * @openapi
 * /api/classes/{id}:
 *   delete:
 *     tags:
 *       - Classes
 *     summary: Delete (deactivate) a class (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId
 *     responses:
 *       200:
 *         description: Deactivated class
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Class not found
 */
router.delete(
  '/:id',
  verifyJwtToken,
  requireRole('teacher'),
  param('id').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  classController.deleteClass
);

/**
 * @openapi
 * /api/classes/join/{joinCode}:
 *   get:
 *     tags:
 *       - Classes
 *     summary: Resolve a join code (Public)
 *     description: Returns basic class info if `joinCode` is valid.
 *     parameters:
 *       - in: path
 *         name: joinCode
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Class info for a valid join code
 *       404:
 *         description: Invalid join code
 */
router.post(
  '/:classId/invite',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  body('emails').isArray({ min: 1 }).withMessage('emails must be a non-empty array'),
  body('emails.*').isEmail().withMessage('All emails must be valid'),
  handleValidationResult,
  classController.inviteStudents
);

router.get(
  '/:classId/invitations',
  verifyJwtToken,
  requireRole('teacher'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  classController.getClassInvitations
);

router.get(
  '/join/:joinCode',
  classController.joinByCode
);

module.exports = router;
