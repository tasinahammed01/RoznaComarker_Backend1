'use strict';
const express = require('express');
const { body, param, query } = require('express-validator');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { handleValidationResult } = require('../middlewares/validation.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const Billing = require('../services/planBilling.service');
const Promo = require('../services/promoCode.service');
const PromoModel = require('../models/PromoCode');
const Plan = require('../models/Plan');
const router = express.Router();
router.use(verifyJwtToken);
const limit = createUserRateLimiter({ windowMs: 5 * 60 * 1000, limit: 40, event: 'BILLING_RATE_LIMITED', reason: 'billing_quote_admin' });
const only = keys => body().custom(value => value && Object.keys(value).every(key => keys.includes(key)));
const handle = action => async (req, res) => {
  try { res.json({ success: true, data: await action(req) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false,
    code: error.statusCode ? error.code : 'BILLING_FAILED', message: error.statusCode ? error.message : 'Billing could not be updated. Please try again.' }); }
};
router.post('/quote', requireRole('teacher'), limit,
  body('planSlug').isString().isLength({ min: 1, max: 80 }), body('billingPeriod').isIn(['monthly', 'annual']),
  body('promoCode').optional().isString().isLength({ max: 40 }), only(['planSlug', 'billingPeriod', 'promoCode']), handleValidationResult,
  handle(req => Billing.createQuote({ userId: req.user._id, ...req.body })));
router.use('/admin', requireRole('admin'), limit);
router.get('/admin/plans', handle(async () => {
  const plans = await Plan.find({ isActive: true, slug: { $regex: /^(?:free|(?:essential|pro)(?:_(?:monthly|annual))?)$/ } })
    .select('name slug display.title price annualPrice currency billingInterval billingType displayOrder').sort({ displayOrder: 1, slug: 1 }).lean();
  return plans.filter(plan => Billing.adminTier(plan.slug) && (plan.slug === 'free' || Billing.adminPeriods(plan).length))
    .map(plan => ({ slug: plan.slug, name: plan.display?.title || plan.name, tier: Billing.adminTier(plan.slug),
      periods: Billing.adminPeriods(plan), promoEligible: plan.slug !== 'free', price: plan.price,
      annualPrice: plan.annualPrice, currency: plan.currency }));
}));
router.get('/admin/promos', query('page').optional().isInt({ min: 1, max: 10000 }), handleValidationResult,
  handle(async req => ({ items: (await PromoModel.find().sort({ _id: -1 }).skip((Number(req.query.page || 1) - 1) * 25).limit(25).lean()).map(Promo.dto) })));
router.post('/admin/promos', handle(req => Billing.transaction(session => Promo.save(req.body, req.user._id, null, session))));
router.put('/admin/promos/:id', param('id').isMongoId(), handleValidationResult,
  handle(req => Billing.transaction(session => Promo.save(req.body, req.user._id, req.params.id, session))));
router.get('/admin/user', query('email').isString().isLength({ max: 254 }), handleValidationResult,
  handle(req => Billing.lookup(req.query.email)));
router.post('/admin/preview', only(['email', 'planSlug', 'billingPeriod', 'reason']), handleValidationResult,
  handle(req => Billing.previewAdmin({ actor: req.user._id, ...req.body })));
router.post('/admin/assign', body('quoteId').isMongoId(), body('operationId').isUUID(4), only(['quoteId', 'operationId']), handleValidationResult,
  handle(async req => {
    const entitlement = await Billing.assignAdmin({ actor: req.user._id, ...req.body });
    // Reconcile only the allowance via the existing wallet mechanism. Never set
    // purchased/bonus buckets. A retry may repair this after a committed grant.
    await require('../services/credit.service').getOrCreateWallet(entitlement.userId);
    return { entitlementId: String(entitlement._id), planSlug: entitlement.planSlug, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt };
  }));
module.exports = router;
