'use strict';

const Plan = require('../../models/Plan');
const User = require('../../models/user.model');
const PaymentCheckoutAttempt = require('../../models/PaymentCheckoutAttempt');
const PaymentManagementAttempt = require('../../models/PaymentManagementAttempt');
const { getPayPalPlanId, getPlanByPayPalPlanId, requestedInterval } = require('./paypalPlanMapping.service');
const { assignPlanToUser } = require('../../middlewares/usage.middleware');
const CreditService = require('../credit.service');

const { getPaypalRedirectUrls } = require('../../config/paypal');
const BonusRewardService = require('../bonusReward.service');
const logger = require('../../utils/logger');
const { PayPalClient } = require('./paypalClient.service');

const PAYPAL_BLOCKING_STATUSES = new Set(['ACTIVE', 'SUSPENDED']);
const PAYPAL_PENDING_STATUSES = new Set(['APPROVAL_PENDING', 'APPROVAL_REQUIRED', 'APPROVED', 'CREATED']);
const PAYPAL_TERMINAL_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'FAILED']);
const ATTEMPT_PROCESSING_LEASE_MS = 2 * 60 * 1000;

function paypalError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function approvalUrl(response, errorCode = 'PAYPAL_SUBSCRIPTION_CREATE_FAILED') {
  const href = response?.links?.find((link) => link?.rel === 'approve' && link?.method === 'GET')?.href;
  if (!href) throw paypalError(errorCode, 'PayPal did not return an approval URL', 502);
  let url;
  try { url = new URL(href); } catch { throw paypalError(errorCode, 'PayPal returned an invalid approval URL', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))) {
    throw paypalError(errorCode, 'PayPal returned an untrusted approval URL', 502);
  }
  return url.toString();
}

function billingInterval(plan) {
  return ['year', 'yearly', 'annual'].includes(String(plan.billingInterval || '').toLowerCase()) ? 'yearly' : 'monthly';
}

function assertSubscriptionCanBeCreated(user) {
  if (user.paypalSubscriptionStatus === 'ACTIVE') {
    throw paypalError('ALREADY_SUBSCRIBED', 'An active PayPal subscription already exists', 409);
  }
  if (user.paypalSubscriptionStatus === 'SUSPENDED') {
    throw paypalError('SUBSCRIPTION_REQUIRES_MANAGEMENT', 'The PayPal subscription requires management', 409);
  }
}

async function createProviderSubscription(attempt, { client, environment }) {
  const redirects = getPaypalRedirectUrls('subscription', environment);
  const response = await client.createSubscription({
    plan_id: attempt.providerPlanId,
    custom_id: attempt.attemptId,
    application_context: {
      brand_name: 'RoznaHub / CoMarker',
      user_action: 'SUBSCRIBE_NOW',
      return_url: redirects.returnUrl,
      cancel_url: redirects.cancelUrl
    }
  }, attempt.attemptId);
  if (!response?.id) throw paypalError('PAYPAL_SUBSCRIPTION_CREATE_FAILED', 'PayPal did not return a Subscription ID', 502);
  attempt.providerSubscriptionId = response.id;
  attempt.approvalUrl = approvalUrl(response);
  attempt.status = 'approval_pending';
  attempt.processingLeaseExpiresAt = null;
  attempt.approvalExpiresAt ||= new Date(Date.now() + 24 * 60 * 60 * 1000);
  attempt.errorCode = undefined;
  await attempt.save();
  return attempt;
}

async function markFailedProviderAttempt(attempt, user, providerStatus) {
  attempt.status = 'failed';
  attempt.activeOperationKey = undefined;
  attempt.errorCode = `PAYPAL_SUBSCRIPTION_${providerStatus}`;
  attempt.cancelledAt ||= new Date();
  await attempt.save();
  if (user.paypalSubscriptionId === attempt.providerSubscriptionId) {
    user.paypalSubscriptionStatus = 'FAILED';
    user.paypalPaymentIssueActive = false;
    await user.save({ validateModifiedOnly: true });
  }
}

async function recoverPendingAttempt({ user, plan, providerPlanId, client, environment }) {
  let attempt = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', userId: user._id,
    status: { $in: ['creating', 'approval_pending'] } }).sort({ updatedAt: -1 });
  if (!attempt) return null;
  if (attempt.providerPlanId !== providerPlanId) {
    throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Pending checkout belongs to another provider plan', 409);
  }
  if (attempt.status === 'creating' || !attempt.providerSubscriptionId || !attempt.approvalUrl) {
    const updatedAt = attempt.updatedAt ? new Date(attempt.updatedAt).getTime() : 0;
    if (updatedAt && Date.now() - updatedAt < ATTEMPT_PROCESSING_LEASE_MS) {
      throw paypalError('CHECKOUT_ATTEMPT_IN_PROGRESS', 'Checkout attempt is already being processed', 409);
    }
    const claimed = await PaymentCheckoutAttempt.findOneAndUpdate({ _id: attempt._id, status: 'creating',
      $or: [{ processingLeaseExpiresAt: { $lte: new Date() } }, { processingLeaseExpiresAt: { $exists: false } }] },
      { $set: { processingLeaseExpiresAt: new Date(Date.now() + ATTEMPT_PROCESSING_LEASE_MS) } }, { new: true });
    if (!claimed) throw paypalError('CHECKOUT_ATTEMPT_IN_PROGRESS', 'Checkout is already processing', 409);
    attempt = claimed;
    // Beyond our conservative 24-hour retry policy, require operator reconciliation.
    if (Date.now() - new Date(attempt.createdAt).getTime() > 24 * 60 * 60 * 1000) {
      throw paypalError('CHECKOUT_REVIEW_REQUIRED', 'Checkout requires reconciliation before retry', 409);
    }
    try { return await createProviderSubscription(attempt, { client, environment }); }
    catch (error) {
      attempt.status = 'creating'; attempt.errorCode = error?.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED'; await attempt.save();
      throw error;
    }
  }

  let subscription;
  try { subscription = await client.getSubscription(attempt.providerSubscriptionId); }
  catch (error) {
    if (error?.providerStatus === 404) {
      await markFailedProviderAttempt(attempt, user, 'NOT_FOUND');
      return null;
    }
    // A provider outage must not trigger a duplicate subscription. The stored,
    // trusted approval URL remains the safest retry path until reconciliation resumes.
    return attempt;
  }
  if (String(subscription?.id || '') !== attempt.providerSubscriptionId || subscription?.plan_id !== providerPlanId) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'Pending PayPal Subscription does not match checkout attempt', 422);
  }
  const providerStatus = String(subscription.status || '').toUpperCase();
  if (PAYPAL_PENDING_STATUSES.has(providerStatus)) {
    const providerApproval = subscription?.links?.some((link) => link?.rel === 'approve')
      ? approvalUrl(subscription, 'PAYPAL_SUBSCRIPTION_RECOVERY_FAILED')
      : null;
    if (providerApproval) attempt.approvalUrl = providerApproval;
    attempt.status = 'approval_pending';
    await attempt.save();
    return attempt;
  }
  if (providerStatus === 'ACTIVE' || providerStatus === 'SUSPENDED') {
    await syncSubscription(subscription, { eventType: 'CHECKOUT.RECONCILIATION' });
    if (providerStatus === 'ACTIVE') {
      throw paypalError('ALREADY_SUBSCRIBED', 'An active PayPal subscription already exists', 409);
    }
    throw paypalError('SUBSCRIPTION_REQUIRES_MANAGEMENT', 'The PayPal subscription requires management', 409);
  }
  if (['CANCELLED', 'EXPIRED'].includes(providerStatus)) {
    await syncSubscription(subscription, { eventType: 'CHECKOUT.RECONCILIATION' });
    return null;
  }
  if (providerStatus === 'FAILED') {
    await markFailedProviderAttempt(attempt, user, providerStatus);
    return null;
  }
  throw paypalError('PAYPAL_SUBSCRIPTION_RECOVERY_FAILED', 'Pending PayPal Subscription has an unsupported status', 502);
}

async function createSubscription({ user, planKey, billingPeriod, attemptId, client, environment = process.env }) {
  if (String(environment.PAYMENT_PROVIDER || '').toLowerCase() !== 'paypal') {
    throw paypalError('PAYPAL_PROVIDER_NOT_ENABLED', 'PayPal checkout is not enabled', 409);
  }
  assertSubscriptionCanBeCreated(user);
  const plan = await Plan.findOne({ slug: String(planKey || '').trim().toLowerCase(), isActive: true }).lean();
  if (!plan || ['free', 'institution', 'custom'].includes(plan.slug) || !(Number(plan.price) > 0)) {
    throw paypalError('PLAN_NOT_PURCHASABLE', 'Plan is not available for PayPal checkout', plan ? 400 : 404);
  }
  const interval = requestedInterval(plan, billingPeriod);
  const providerPlanId = await getPayPalPlanId({ planKey: plan.slug, billingInterval: interval }, { environment });
  const existing = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId });
  if (existing) {
    if (String(existing.userId) !== String(user._id) || existing.planKey !== plan.slug || existing.billingInterval !== interval || existing.providerPlanId !== providerPlanId) throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Checkout attempt belongs to another plan', 409);
    if (['cancelled', 'failed'].includes(existing.status)) throw paypalError('CHECKOUT_ATTEMPT_TERMINAL', 'Use a new attempt after confirmed termination', 409);
    if (existing.status === 'active') return existing;
    if (existing.providerSubscriptionId && existing.approvalUrl) return existing;
  }
  const recovered = await recoverPendingAttempt({ user, plan, providerPlanId, client, environment });
  if (recovered) return recovered;
  await require('../paymentIndexContract.service').verifyCheckoutIndex();
  let attempt;
  try {
    attempt = await PaymentCheckoutAttempt.create({ attemptId, provider: 'paypal', userId: user._id,
      planKey: plan.slug, billingInterval: interval, providerPlanId, status: 'creating',
      activeOperationKey: `paypal:${user._id}`, processingLeaseExpiresAt: new Date(Date.now() + ATTEMPT_PROCESSING_LEASE_MS) });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId });
      if (duplicate?.userId?.equals(user._id) && duplicate.planKey === plan.slug && duplicate.billingInterval === interval && duplicate.providerSubscriptionId && duplicate.approvalUrl) return duplicate;
      throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Checkout attempt is already in use', 409);
    }
    throw error;
  }
  try {
    return await createProviderSubscription(attempt, { client, environment });
  } catch (error) {
    attempt.status = 'creating'; attempt.errorCode = error?.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED'; await attempt.save();
    if (error?.code?.startsWith?.('PAYPAL_')) throw error;
    throw paypalError('PAYPAL_SUBSCRIPTION_CREATE_FAILED', 'Unable to create PayPal subscription', 502);
  }
}

function subscriptionPeriod(subscription) {
  const start = subscription?.start_time ? new Date(subscription.start_time) : null;
  const end = subscription?.billing_info?.next_billing_time ? new Date(subscription.billing_info.next_billing_time) : null;
  return { start: start && !Number.isNaN(start.getTime()) ? start : null, end: end && !Number.isNaN(end.getTime()) ? end : null };
}

async function syncSubscription(subscription, { eventType } = {}) {
  const subscriptionId = String(subscription?.id || '').trim();
  if (!subscriptionId) throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PayPal Subscription ID is missing', 422);
  let attempt = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', providerSubscriptionId: subscriptionId });
  if (!attempt && subscription.custom_id) {
    attempt = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId: String(subscription.custom_id) });
  }
  const managementAttempt = await PaymentManagementAttempt.findOne({
    provider: 'paypal', providerSubscriptionId: subscriptionId,
    status: { $in: ['processing', 'approval_pending', 'provider_pending', 'completed'] }
  }).sort({ createdAt: -1 });
  let user = managementAttempt ? await User.findOne({ _id: managementAttempt.userId, role: 'teacher' }) : null;
  if (!user) user = await User.findOne({ paypalSubscriptionId: subscriptionId, role: 'teacher' });
  if (!attempt && !user) throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PayPal Subscription cannot be correlated', 422);
  if (attempt && attempt.providerSubscriptionId && attempt.providerSubscriptionId !== subscriptionId) {
    throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PayPal Subscription cannot be correlated', 422);
  }
  const plan = await getPlanByPayPalPlanId(subscription.plan_id);
  const authorizedRevision = await PaymentManagementAttempt.findOne({ provider: 'paypal', providerSubscriptionId: subscriptionId,
    operation: 'CHANGE_PLAN', targetProviderPlanId: subscription.plan_id, targetPlanKey: plan.slug,
    status: { $in: ['processing', 'approval_pending', 'provider_pending', 'completed'] } }).sort({ createdAt: -1 });
  const isExpectedRevision = managementAttempt?.operation === 'CHANGE_PLAN' &&
    managementAttempt.targetPlanKey === plan.slug && managementAttempt.targetProviderPlanId === subscription.plan_id;
  const isUnchangedRevision = managementAttempt?.operation === 'CHANGE_PLAN' &&
    managementAttempt.sourcePlanKey === plan.slug && managementAttempt.sourceProviderPlanId === subscription.plan_id;
  if (managementAttempt?.operation === 'CHANGE_PLAN' && !isExpectedRevision && !isUnchangedRevision && !authorizedRevision) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'PayPal Subscription Plan does not match the requested revision', 422);
  }
  if (attempt && (attempt.planKey !== plan.slug || attempt.providerPlanId !== subscription.plan_id) && !isExpectedRevision && !authorizedRevision) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'PayPal Subscription Plan does not match checkout attempt', 422);
  }
  if (!user && attempt) user = await User.findOne({ _id: attempt.userId, role: 'teacher' });
  if (!user) throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'Teacher cannot be correlated', 422);
  if (user.paypalSubscriptionId && user.paypalSubscriptionId !== subscriptionId &&
      !PAYPAL_TERMINAL_STATUSES.has(user.paypalSubscriptionStatus)) {
    throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'Teacher is linked to another PayPal Subscription', 409);
  }
  if (!attempt && !authorizedRevision && user.paypalPlanId !== subscription.plan_id) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'Provider plan change was not authorized', 422);
  }
  const status = String(subscription.status || '').toUpperCase();
  const period = subscriptionPeriod(subscription);
  user.paypalSubscriptionId = subscriptionId;
  user.paypalPlanId = subscription.plan_id;
  user.paypalSubscriptionStatus = status;
  if (period.start) {
    user.paypalCurrentPeriodStart = period.start;
  }
  if (period.end) {
    user.paypalCurrentPeriodEnd = period.end;
  }
  if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
    user.paypalLastPaymentFailedAt = new Date();
    user.paypalPaymentIssueActive = true;
  } else if (status === 'ACTIVE') {
    user.paypalPaymentIssueActive = false;
  } else if (status === 'SUSPENDED') {
    user.paypalPaymentIssueActive = true;
  } else if (['CANCELLED', 'EXPIRED'].includes(status)) {
    user.paypalPaymentIssueActive = false;
  }
  if (status === 'ACTIVE') {
    const previousPlan = user.plan ? await Plan.findById(user.plan).lean() : null;
    await assignPlanToUser(user, plan, period.start || new Date());
    user.planExpiresAt = period.end;
    await user.save({ validateModifiedOnly: true });
    await CreditService.getOrCreateWallet(user._id);
    const interval = plan.resolvedBillingInterval;
    const previousInterval = String(previousPlan?.billingInterval || previousPlan?.billingType || '').toLowerCase();
    if (isExpectedRevision && ['annual', 'year', 'yearly'].includes(interval) &&
        !['annual', 'year', 'yearly'].includes(previousInterval) && previousPlan?.price > 0) {
      try { await BonusRewardService.grantConfiguredBonus({ eventType: 'ANNUAL_UPGRADE',
        eventKey: `${subscriptionId}:${period.start?.toISOString() || subscription.plan_id}`,
        userId: user._id, sourceId: managementAttempt._id }); }
      catch (error) { logger.error({ event: 'bonus_reward_failed', userId: String(user._id),
        eventType: 'ANNUAL_UPGRADE', error: error?.message }); }
    }
    if (attempt && attempt.planKey === plan.slug) { attempt.status = 'active'; attempt.completedAt ||= new Date(); }
    if (isExpectedRevision) {
      managementAttempt.status = 'completed'; managementAttempt.completedAt ||= new Date();
      managementAttempt.activeOperationKey = undefined; managementAttempt.processingLeaseExpiresAt = null;
    }
  } else if (status === 'CANCELLED') {
    user.paypalPaymentIssueActive = false;
    // Preserve existing paid plan and entitlement dates. Do NOT call assignPlanToUser(free).
    // Do NOT clear paypalPlanId, paypalCurrentPeriodEnd, or planExpiresAt if still future.
    if (user.paypalCurrentPeriodEnd && (!user.planExpiresAt || user.planExpiresAt < user.paypalCurrentPeriodEnd)) {
      user.planExpiresAt = user.paypalCurrentPeriodEnd;
    }
    await user.save({ validateModifiedOnly: true });
    if (attempt) {
      attempt.status = 'cancelled';
      attempt.cancelledAt ||= new Date();
    }
    if (managementAttempt?.operation === 'CANCEL') {
      managementAttempt.status = 'completed';
      managementAttempt.completedAt ||= new Date();
      managementAttempt.activeOperationKey = undefined;
      managementAttempt.processingLeaseExpiresAt = null;
    }
  } else if (status === 'EXPIRED') {
    const free = await Plan.findOne({ slug: 'free', isActive: true });
    if (free) await assignPlanToUser(user, free, new Date());
    if (attempt) { attempt.status = 'cancelled'; attempt.cancelledAt ||= new Date(); }
    if (managementAttempt?.operation === 'CANCEL') {
      managementAttempt.status = 'completed'; managementAttempt.completedAt ||= new Date();
      managementAttempt.activeOperationKey = undefined; managementAttempt.processingLeaseExpiresAt = null;
    }
  } else if (status === 'SUSPENDED') {
    const free = await Plan.findOne({ slug: 'free', isActive: true });
    if (free) await assignPlanToUser(user, free, new Date());
    // Suspension is not termination: retain the checkout lock against stale requests.
    if (attempt) attempt.activeOperationKey = `paypal:${user._id}`;
  } else {
    await user.save({ validateModifiedOnly: true });
  }
  if (attempt) {
    if (['cancelled', 'failed'].includes(attempt.status)) attempt.activeOperationKey = undefined;
    await attempt.save();
  }
  if (managementAttempt) await managementAttempt.save();
  if (['CANCELLED', 'EXPIRED'].includes(status)) await PaymentManagementAttempt.updateMany({ provider: 'paypal',
    providerSubscriptionId: subscriptionId, userId: user._id, operation: 'CANCEL', status: { $in: ['processing', 'provider_pending'] } },
    { $set: { status: 'completed', completedAt: new Date(), processingLeaseExpiresAt: null }, $unset: { activeOperationKey: 1 } });
  return { user, plan, attempt, managementAttempt, status };
}

async function reconcileCheckout({ user, attemptId, client = new PayPalClient() }) {
  const attempt = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId, userId: user._id });
  if (!attempt?.providerSubscriptionId) throw paypalError('PAYPAL_SUBSCRIPTION_NOT_FOUND', 'Subscription checkout was not found', 404);
  const subscription = await client.getSubscription(attempt.providerSubscriptionId);
  if (!subscription?.id || String(subscription.id) !== attempt.providerSubscriptionId) {
    throw paypalError('PAYPAL_SUBSCRIPTION_CORRELATION_FAILED', 'Fetched PayPal subscription does not match checkout attempt', 422);
  }
  const result = await syncSubscription(subscription);
  return { attemptId: attempt.attemptId, subscriptionId: attempt.providerSubscriptionId,
    status: result.status, active: result.status === 'ACTIVE' };
}

module.exports = { ATTEMPT_PROCESSING_LEASE_MS, PAYPAL_BLOCKING_STATUSES, PAYPAL_PENDING_STATUSES,
  PAYPAL_TERMINAL_STATUSES, approvalUrl, createSubscription, reconcileCheckout, syncSubscription, subscriptionPeriod };
