const express = require('express');
const { body, param } = require('express-validator');
const controller = require('../controllers/credit.controller');
const topup = require('../controllers/topup.controller');
const pricingAdmin = require('../controllers/pricingAdmin.controller');
const paypalPurchase = require('../controllers/paypalPurchase.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const router = express.Router();
router.get('/wallet', verifyJwtToken, requireRole('teacher'), controller.wallet);
router.post('/nudges/acknowledge', verifyJwtToken, requireRole('teacher'), body('threshold').isInt().equals('80'),
  handleValidationResult, controller.acknowledgeNudge);
router.get('/packs', verifyJwtToken, requireRole('teacher'), topup.packs);
router.post('/topups/checkout-session', verifyJwtToken, requireRole('teacher'),
  body('packCode').isString().trim().isLength({ min: 2, max: 80 }), handleValidationResult, topup.checkout);
const paypalPurchaseBody = [
  body('packCode').isString().trim().isLength({ min: 2, max: 80 }),
  body('checkoutAttemptId').isUUID(4),
  body().custom((value) => Object.keys(value || {}).every((key) => ['packCode', 'checkoutAttemptId'].includes(key)))
    .withMessage('Only packCode and checkoutAttemptId are accepted')
];
router.post('/paypal/create-order', verifyJwtToken, requireRole('teacher'), paypalPurchaseBody,
  handleValidationResult, paypalPurchase.createOrder);
router.post('/paypal/capture', verifyJwtToken, requireRole('teacher'), body('checkoutAttemptId').isUUID(4),
  body().custom((value) => Object.keys(value || {}).every((key) => key === 'checkoutAttemptId')),
  handleValidationResult, paypalPurchase.capture);
router.post('/paypal/cancel', verifyJwtToken, requireRole('teacher'), body('checkoutAttemptId').isUUID(4),
  body().custom((value) => Object.keys(value || {}).every((key) => key === 'checkoutAttemptId')),
  handleValidationResult, paypalPurchase.cancel);
router.get('/paypal/purchase/:attemptId', verifyJwtToken, requireRole('teacher'), param('attemptId').isUUID(4),
  handleValidationResult, paypalPurchase.status);
router.get('/transactions', verifyJwtToken, requireRole('teacher'), controller.transactions);
router.get('/rewards', verifyJwtToken, requireRole('teacher'), controller.rewards);
router.get('/admin/teachers', verifyJwtToken, requireRole('admin'), controller.adminTeachers);
router.get('/admin/pricing', verifyJwtToken, requireRole('admin'), pricingAdmin.getConfig);
router.put('/admin/pricing/plans/:slug', verifyJwtToken, requireRole('admin'),
  param('slug').isString().trim().isLength({ min: 2, max: 80 }), handleValidationResult, pricingAdmin.updatePlan);
router.put('/admin/pricing/packs/:code', verifyJwtToken, requireRole('admin'),
  param('code').isString().trim().isLength({ min: 2, max: 80 }), handleValidationResult, pricingAdmin.updatePack);
router.get('/admin/:userId', verifyJwtToken, requireRole('admin'), param('userId').isMongoId(), handleValidationResult, controller.adminWallet);
router.post('/admin/:userId/adjust', verifyJwtToken, requireRole('admin'), param('userId').isMongoId(),
  body('amount').isInt({ min: -100000, max: 100000 }).custom((value) => Number(value) !== 0),
  body('reason').isString().trim().isLength({ min: 1, max: 500 }), body('idempotencyKey').optional().isString().trim().isLength({ min: 8, max: 200 }),
  handleValidationResult, controller.adminAdjust);
module.exports = router;
