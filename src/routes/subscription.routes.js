const express = require('express');

const subscriptionController = require('../controllers/subscription.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { body } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Subscription
 *     description: Subscription plan and usage endpoints
 */

/**
 * @openapi
 * /api/subscription/me:
 *   get:
 *     tags:
 *       - Subscription
 *     summary: Get my subscription & usage
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current plan + usage
 *       401:
 *         description: Unauthorized
 */
router.get('/me', verifyJwtToken, subscriptionController.getMySubscription);

/**
 * @openapi
 * /api/subscription/set:
 *   post:
 *     tags:
 *       - Subscription
 *     summary: Set a user's subscription (Admin)
 *     description: Provide `userId` and either `planId` or `planName`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 example: "65a000000000000000000001"
 *               planId:
 *                 type: string
 *                 nullable: true
 *               planName:
 *                 type: string
 *                 nullable: true
 *                 example: "Pro"
 *               startedAt:
 *                 type: string
 *                 nullable: true
 *                 example: "2026-01-01T00:00:00.000Z"
 *     responses:
 *       200:
 *         description: Subscription updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User/Plan not found
 */
router.post(
  '/set',
  verifyJwtToken,
  requireRole('admin'),
  body('userId').isMongoId().withMessage('Invalid userId'),
  body('planId').optional({ nullable: true }).isString(),
  body('planName').optional({ nullable: true }).isString(),
  body('startedAt').optional({ nullable: true }).isString(),
  handleValidationResult,
  subscriptionController.setUserSubscription
);

module.exports = router;
