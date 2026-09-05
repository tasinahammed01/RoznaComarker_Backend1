const express = require('express');

const subscriptionController = require('../controllers/subscription.controller');
const paypalSubscriptionController = require('../controllers/paypalSubscription.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { body } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');

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
router.get('/checkout-plan', verifyJwtToken, requireRole('teacher'), subscriptionController.getCheckoutPlan);
router.post(
  '/paypal/create',
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 10, event: 'BILLING_RATE_LIMITED', reason: 'paypal_checkout_user' }),
  body('planCode').isString().trim().notEmpty(),
  body('checkoutAttemptId').isUUID(4),
  body('price').not().exists(), body('currency').not().exists(), body('planId').not().exists(),
  body('credits').not().exists(), body('entitlements').not().exists(),
  handleValidationResult,
  paypalSubscriptionController.create
);
router.post(
  '/paypal/cancel',
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 10, event: 'BILLING_RATE_LIMITED', reason: 'paypal_cancel_user' }),
  body('subscriptionId').not().exists(), body('paypalSubscriptionId').not().exists(),
  body('reason').not().exists(),
  handleValidationResult,
  paypalSubscriptionController.cancel
);
router.post(
  '/paypal/change-plan',
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 10, event: 'BILLING_RATE_LIMITED', reason: 'paypal_change_plan_user' }),
  body('targetPlanCode').isString().trim().isLength({ min: 1, max: 80 }),
  body('changeAttemptId').isUUID(4),
  body('targetPayPalPlanId').not().exists(), body('providerSubscriptionId').not().exists(),
  body('subscriptionId').not().exists(), body('price').not().exists(), body('credits').not().exists(),
  handleValidationResult,
  paypalSubscriptionController.changePlan
);
router.post(
  '/paypal/change-plan/cancelled',
  verifyJwtToken,
  requireRole('teacher'),
  body('changeAttemptId').isUUID(4),
  body('subscriptionId').not().exists(), body('targetPayPalPlanId').not().exists(),
  handleValidationResult,
  paypalSubscriptionController.changePlanCancelled
);
router.post(
  '/checkout-session',
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 10, event: 'BILLING_RATE_LIMITED', reason: 'checkout_user' }),
  body('planSlug').optional().isString().trim().notEmpty(),
  body('planCode').optional().isString().trim().notEmpty(),
  body().custom((value) => !!String(value?.planCode || value?.planSlug || '').trim()).withMessage('planCode is required'),
  body('billingPeriod').optional().isIn(['monthly', 'annual']),
  body('checkoutAttemptId').isString().isLength({ min: 36, max: 36 }).isUUID(4)
    .withMessage('checkoutAttemptId must be a valid UUID v4'),
  body('priceId').not().exists().withMessage('priceId is not accepted'),
  body('amount').not().exists().withMessage('amount is not accepted'),
  body('successUrl').not().exists().withMessage('successUrl is not accepted'),
  body('cancelUrl').not().exists().withMessage('cancelUrl is not accepted'),
  handleValidationResult,
  subscriptionController.createCheckoutSession
);
router.post(
  '/customer-portal',
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 10, event: 'BILLING_RATE_LIMITED', reason: 'portal_user' }),
  body('returnUrl').not().exists().withMessage('returnUrl is not accepted'),
  handleValidationResult,
  subscriptionController.createCustomerPortal
);

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
