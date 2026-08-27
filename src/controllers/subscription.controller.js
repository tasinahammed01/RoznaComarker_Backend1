const mongoose = require('mongoose');

const Plan = require('../models/Plan');
const User = require('../models/user.model');
const { getStripe, getFrontendUrl } = require('../services/stripe.service');
const { CHECKOUT_BLOCKING_STATUSES, getPriceId } = require('../services/stripeSubscription.service');
const logger = require('../utils/logger');

const { ensureActivePlan, assignPlanToUser } = require('../middlewares/usage.middleware');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(code ? { code } : {})
  });
}

function sanitizeStripeMessage(message) {
  return String(message || 'Stripe Checkout Session creation failed')
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:\d[ -]*?){12,19}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function logCheckoutSessionFailure(err, { user, plan, checkoutAttemptId, customerId, priceId }) {
  logger.error({
    message: 'Stripe Checkout Session creation failed',
    stripeErrorType: err?.type || err?.rawType || 'unknown',
    stripeErrorCode: err?.code || 'unknown',
    stripeErrorParam: err?.param || 'unknown',
    stripeErrorMessage: sanitizeStripeMessage(err?.message),
    teacherId: String(user._id),
    planSlug: plan.slug,
    checkoutAttemptId,
    stripeCustomerId: customerId,
    stripePriceId: priceId
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function getMySubscription(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const planDoc = await ensureActivePlan(user);

    return sendSuccess(res, {
      plan: planDoc,
      planStartedAt: user.planStartedAt || null,
      planExpiresAt: user.planExpiresAt || null,
      billing: user.role === 'teacher' ? {
        customerConfigured: !!user.stripeCustomerId,
        subscriptionId: user.stripeSubscriptionId || null,
        status: user.stripeSubscriptionStatus || null,
        currentPeriodEnd: user.stripeCurrentPeriodEnd || null,
        cancelAtPeriodEnd: !!user.stripeCancelAtPeriodEnd,
        paymentIssue: ['past_due', 'unpaid'].includes(user.stripeSubscriptionStatus)
      } : null,
      usage: user.usage || {
        classes: 0,
        assignments: 0,
        students: 0,
        submissions: 0,
        storageMB: 0
      }
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch subscription');
  }
}

async function setUserSubscription(req, res) {
  try {
    const { userId, planId, planName, startedAt } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return sendError(res, 400, 'Invalid userId');
    }

    const user = await User.findById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    let planDoc;

    if (mongoose.Types.ObjectId.isValid(planId)) {
      planDoc = await Plan.findById(planId);
    } else if (isNonEmptyString(planName)) {
      planDoc = await Plan.findOne({ name: planName.trim() });
    } else {
      return sendError(res, 400, 'planId or planName is required');
    }

    if (!planDoc) {
      return sendError(res, 404, 'Plan not found');
    }

    const parsedStartedAt = startedAt ? new Date(startedAt) : new Date();
    if (!(parsedStartedAt instanceof Date) || Number.isNaN(parsedStartedAt.getTime())) {
      return sendError(res, 400, 'Invalid startedAt');
    }

    await assignPlanToUser(user, planDoc, parsedStartedAt);

    const nextPlan = await Plan.findById(user.plan);

    return sendSuccess(res, {
      userId: user._id,
      plan: nextPlan,
      planStartedAt: user.planStartedAt || null,
      planExpiresAt: user.planExpiresAt || null,
      usage: user.usage
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to set subscription');
  }
}

async function getCheckoutPlan(req, res) {
  try {
    if (!req.user || req.user.role !== 'teacher') return sendError(res, 403, 'Forbidden');
    const planCode = String(req.query.planCode || 'starter_monthly').trim().toLowerCase();
    if (['free', 'custom', 'institution'].includes(planCode)) return sendError(res, 400, 'Plan is not available for checkout', 'PLAN_NOT_PURCHASABLE');
    const plan = await Plan.findOne({ slug: planCode, isActive: true }).lean();
    if (!plan) return sendError(res, 404, 'Plan not found');
    return sendSuccess(res, {
      name: plan.name,
      slug: plan.slug,
      price: plan.price,
      annualPrice: plan.annualPrice,
      currency: plan.currency,
      billingInterval: plan.billingInterval,
      features: plan.features,
      display: plan.display
    });
  } catch {
    return sendError(res, 500, 'Failed to fetch checkout plan');
  }
}

async function createCheckoutSession(req, res) {
  try {
    const user = req.user;
    const { checkoutAttemptId } = req.body || {};
    const planSlug = String(req.body?.planCode || req.body?.planSlug || '').trim().toLowerCase();
    const billingPeriod = String(req.body?.billingPeriod || 'monthly').trim().toLowerCase();
    if (['free', 'custom', 'institution'].includes(planSlug) || !['monthly', 'annual'].includes(billingPeriod))
      return sendError(res, 400, 'Plan is not available for checkout', 'PLAN_NOT_PURCHASABLE');
    const plan = await Plan.findOne({ slug: planSlug, isActive: true });
    if (!plan) return sendError(res, 404, 'Plan not found');
    const trustedPriceId = billingPeriod === 'annual' ? plan.stripe?.annualPriceId : (plan.stripe?.monthlyPriceId || plan.stripe?.priceId);
    const trustedProductId = plan.stripe?.productId;
    if (!trustedPriceId || !trustedProductId) return sendError(res, 503, 'Plan billing is not configured', 'PLAN_BILLING_NOT_CONFIGURED');
    if (CHECKOUT_BLOCKING_STATUSES.has(user.stripeSubscriptionStatus)) {
      return res.status(409).json({ success: false, code: 'ALREADY_SUBSCRIBED', message: 'A subscription is already active. Use Manage Plan to change it.' });
    }

    const stripe = getStripe();
    let customerId = user.stripeCustomerId;
    if (customerId) {
      const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
      const duplicate = existing.data.find((sub) => CHECKOUT_BLOCKING_STATUSES.has(sub.status) && getPriceId(sub) === trustedPriceId);
      if (duplicate) {
        user.stripeSubscriptionId = duplicate.id;
        user.stripeSubscriptionStatus = duplicate.status;
        await user.save();
        return res.status(409).json({ success: false, code: 'ALREADY_SUBSCRIBED', message: 'This subscription is already active.' });
      }
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.displayName || undefined,
        metadata: { userId: String(user._id) }
      }, { idempotencyKey: `rozna-customer-${user._id}` });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    const stripePrice = await stripe.prices.retrieve(trustedPriceId);
    const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
    const expectedAmount = Math.round(Number(billingPeriod === 'annual' ? plan.annualPrice : plan.price) * 100);
    const expectedCurrency = String(plan.currency || 'USD').toLowerCase();
    const productId = typeof stripePrice.product === 'string' ? stripePrice.product : stripePrice.product?.id;
    const expectedInterval = billingPeriod === 'annual' ? 'year' : 'month';
    if (!!stripePrice.livemode !== expectedLiveMode || !stripePrice.active || stripePrice.type !== 'recurring' || stripePrice.unit_amount !== expectedAmount || stripePrice.currency !== expectedCurrency || stripePrice.recurring?.interval !== expectedInterval || productId !== trustedProductId) {
      logger.error(`stripe plan mismatch plan=${plan.slug} configuredProduct=${trustedProductId} configuredPrice=${trustedPriceId}`);
      return sendError(res, 503, 'Starter billing configuration does not match the application plan');
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        ui_mode: 'embedded_page',
        mode: 'subscription',
        customer: customerId,
        client_reference_id: String(user._id),
        line_items: [{ price: trustedPriceId, quantity: 1 }],
        return_url: `${getFrontendUrl()}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        metadata: { userId: String(user._id), planSlug: plan.slug },
        subscription_data: { metadata: { userId: String(user._id), planSlug: plan.slug } }
      }, { idempotencyKey: `rozna-checkout:${user._id}:${plan.slug}:${billingPeriod}:${checkoutAttemptId}` });
      if (!session?.client_secret) {
        const missingSecretError = new Error('Stripe Checkout Session response did not contain client_secret');
        missingSecretError.type = 'StripeInvalidResponseError';
        missingSecretError.code = 'missing_client_secret';
        missingSecretError.param = 'client_secret';
        throw missingSecretError;
      }
    } catch (err) {
      logCheckoutSessionFailure(err, { user, plan, checkoutAttemptId, customerId, priceId: trustedPriceId });
      return sendError(res, 502, 'Unable to initialize secure checkout', 'STRIPE_CHECKOUT_SESSION_FAILED');
    }
    return sendSuccess(res, { clientSecret: session.client_secret });
  } catch (err) {
    if (err?.statusCode === 503) return sendError(res, 503, err.message);
    return sendError(res, 502, 'Unable to initialize secure checkout');
  }
}

async function createCustomerPortal(req, res) {
  try {
    const user = req.user;
    if (!user.stripeCustomerId) return sendError(res, 404, 'No billing account found');
    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${getFrontendUrl()}/teacher/dashboard`
    });
    return sendSuccess(res, { url: session.url });
  } catch (err) {
    if (err?.statusCode === 503) return sendError(res, 503, err.message);
    return sendError(res, 502, 'Unable to open subscription management');
  }
}

module.exports = {
  getMySubscription,
  setUserSubscription,
  getCheckoutPlan,
  createCheckoutSession,
  createCustomerPortal
};
