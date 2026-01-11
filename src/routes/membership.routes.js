const express = require('express');

const membershipController = require('../controllers/membership.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { body, param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Memberships
 *     description: Student membership in classes
 */

/**
 * @openapi
 * /api/memberships/join:
 *   post:
 *     tags:
 *       - Memberships
 *     summary: Join a class by join code (Student)
 *     description: |
 *       Requires JWT + role `student`.
 *       Enforces the teacher's plan student limit.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - joinCode
 *             properties:
 *               joinCode:
 *                 type: string
 *                 example: "<uuid>"
 *     responses:
 *       200:
 *         description: Joined or re-activated membership
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden or limit exceeded
 *       404:
 *         description: Invalid join code / teacher not found
 *       409:
 *         description: Already joined
 */
router.post(
  '/join',
  verifyJwtToken,
  requireRole('student'),
  body('joinCode').isString().trim().notEmpty().withMessage('joinCode is required'),
  handleValidationResult,
  membershipController.joinClassByCode
);

/**
 * @openapi
 * /api/memberships/mine:
 *   get:
 *     tags:
 *       - Memberships
 *     summary: List my joined classes (Student)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active memberships with populated class info
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/mine',
  verifyJwtToken,
  requireRole('student'),
  membershipController.getMyClasses
);

/**
 * @openapi
 * /api/memberships/leave/{classId}:
 *   patch:
 *     tags:
 *       - Memberships
 *     summary: Leave a class (Student)
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
 *         description: Updated membership (status set to left)
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Membership not found
 */
router.patch(
  '/leave/:classId',
  verifyJwtToken,
  requireRole('student'),
  param('classId').isMongoId().withMessage('Invalid class id'),
  handleValidationResult,
  membershipController.leaveClass
);

module.exports = router;
