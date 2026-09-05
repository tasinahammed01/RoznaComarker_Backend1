'use strict';

const Plan = require('../../models/Plan');
const User = require('../../models/user.model');
const PaymentCheckoutAttempt = require('../../models/PaymentCheckoutAttempt');
const PaymentManagementAttempt = require('../../models/PaymentManagementAttempt');
const { getPayPalPlanId, getPlanByPayPalPlanId } = require('./paypalPlanMapping.service');
const { assignPlanToUser } = require('../../middlewares/usage.middleware');
const CreditService = require('../credit.service');
const { CHECKOUT_BLOCKING_STATUSES } = require('../stripeSubscription.service');
const { getPaypalRedirectUrls } = require('../../config/paypal');
const BonusRewardService = require('../bonusReward.service');
const logger = require('../../utils/logger');

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
  if (url.protocol !== 'https:' || !(url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))) {
    throw paypalError(errorCode, 'PayPal returned an untrusted approval URL', 502);
  }
  return url.toString();
}

function billingInterval(plan) {
  return ['year', 'yearly', 'annual'].includes(String(plan.billingInterval || '').toLowerCase()) ? 'yearly' : 'monthly';
}

function assertSubscriptionCanBeCreated(user) {
  if (CHECKOUT_BLOCKING_STATUSES.has(user.stripeSubscriptionStatus)) {
    throw paypalError('ALREADY_SUBSCRIBED', 'A paid subscription already exists', 409);
  }
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
  attempt.errorCode = undefined;
  await attempt.save();
  return attempt;
}

async function markFailedProviderAttempt(attempt, user, providerStatus) {
  attempt.status = 'failed';
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
  const attempt = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', userId: user._id,
    planKey: plan.slug, status: { $in: ['creating', 'approval_pending'] } }).sort({ updatedAt: -1 });
  if (!attempt) return null;
  if (attempt.providerPlanId !== providerPlanId) {
    throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Pending checkout belongs to another provider plan', 409);
  }
  if (attempt.status === 'creating' || !attempt.providerSubscriptionId || !attempt.approvalUrl) {
    const updatedAt = attempt.updatedAt ? new Date(attempt.updatedAt).getTime() : 0;
    if (updatedAt && Date.now() - updatedAt < ATTEMPT_PROCESSING_LEASE_MS) {
      throw paypalError('CHECKOUT_ATTEMPT_IN_PROGRESS', 'Checkout attempt is already being processed', 409);
    }
    try { return await createProviderSubscription(attempt, { client, environment }); }
    catch (error) {
      attempt.status = 'failed'; attempt.errorCode = error?.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED'; await attempt.save();
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

async function createSubscription({ user, planKey, attemptId, client, environment = process.env }) {
  if (String(environment.PAYMENT_PROVIDER || 'stripe').toLowerCase() !== 'paypal') {
    throw paypalError('PAYPAL_PROVIDER_NOT_ENABLED', 'PayPal checkout is not enabled', 409);
  }
  assertSubscriptionCanBeCreated(user);
  const plan = await Plan.findOne({ slug: String(planKey || '').trim().toLowerCase(), isActive: true }).lean();
  if (!plan || ['free', 'institution', 'custom'].includes(plan.slug) || !(Number(plan.price) > 0)) {
    throw paypalError('PLAN_NOT_PURCHASABLE', 'Plan is not available for PayPal checkout', plan ? 400 : 404);
  }
  const interval = billingInterval(plan);
  const providerPlanId = await getPayPalPlanId({ planKey: plan.slug, billingInterval: interval }, { environment });
  const existing = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId, userId: user._id });
  if (existing) {
    if (existing.planKey !== plan.slug) throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Checkout attempt belongs to another plan', 409);
    if (existing.providerSubscriptionId && existing.approvalUrl) return existing;
    throw paypalError('CHECKOUT_ATTEMPT_IN_PROGRESS', 'Checkout attempt is already being processed', 409);
  }
  const recovered = await recoverPendingAttempt({ user, plan, providerPlanId, client, environment });
  if (recovered) return recovered;
  let attempt;
  try {
    attempt = await PaymentCheckoutAttempt.create({ attemptId, provider: 'paypal', userId: user._id,
      planKey: plan.slug, billingInterval: interval, providerPlanId, status: 'creating' });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await PaymentCheckoutAttempt.findOne({ provider: 'paypal', attemptId });
      if (duplicate?.userId?.equals(user._id) && duplicate.providerSubscriptionId && duplicate.approvalUrl) return duplicate;
      throw paypalError('CHECKOUT_ATTEMPT_CONFLICT', 'Checkout attempt is already in use', 409);
    }
    throw error;
  }
  try {
    return await createProviderSubscription(attempt, { client, environment });
  } catch (error) {
    attempt.status = 'failed'; attempt.errorCode = error?.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED'; await attempt.save();
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
    status: { $in: ['processing', 'approval_pending', 'provider_pending', 'cancelled', 'failed'] }
  }).sort({ createdAt: -1 });
  let user = managementAttempt ? await User.findOne({ _id: managementAttempt.userId, role: 'teacher' }) : null;
  if (!user) user = await User.findOne({ paypalSubscriptionId: subscriptionId, role: 'teacher' });
  if (!attempt && !user) throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PayPal Subscription cannot be correlated', 422);
  if (attempt && attempt.providerSubscriptionId && attempt.providerSubscriptionId !== subscriptionId) {
    throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PayPal Subscription cannot be correlated', 422);
  }
  const plan = await getPlanByPayPalPlanId(subscription.plan_id);
  const isExpectedRevision = managementAttempt?.operation === 'CHANGE_PLAN' &&
    managementAttempt.targetPlanKey === plan.slug && managementAttempt.targetProviderPlanId === subscription.plan_id;
  const isUnchangedRevision = managementAttempt?.operation === 'CHANGE_PLAN' &&
    managementAttempt.sourcePlanKey === plan.slug && managementAttempt.sourceProviderPlanId === subscription.plan_id;
  if (managementAttempt?.operation === 'CHANGE_PLAN' && !isExpectedRevision && !isUnchangedRevision) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'PayPal Subscription Plan does not match the requested revision', 422);
  }
  if (attempt && (attempt.planKey !== plan.slug || attempt.providerPlanId !== subscription.plan_id) && !isExpectedRevision) {
    throw paypalError('PAYPAL_SUBSCRIPTION_PLAN_MISMATCH', 'PayPal Subscription Plan does not match checkout attempt', 422);
  }
  if (!user && attempt) user = await User.findOne({ _id: attempt.userId, role: 'teacher' });
  if (!user) throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'Teacher cannot be correlated', 422);
  if (user.paypalSubscriptionId && user.paypalSubscriptionId !== subscriptionId &&
      !PAYPAL_TERMINAL_STATUSES.has(user.paypalSubscriptionStatus)) {
    throw paypalError('PAYPAL_WEBHOOK_CORRELATION_FAILED', 'Teacher is linked to another PayPal Subscription', 409);
  }
  const status = String(subscription.status || '').toUpperCase();
  const period = subscriptionPeriod(subscription);
  user.paypalSubscriptionId = subscriptionId;
  user.paypalPlanId = subscription.plan_id;
  user.paypalSubscriptionStatus = status;
  user.paypalCurrentPeriodStart = period.start;
  user.paypalCurrentPeriodEnd = period.end;
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
    const interval = String(plan.billingInterval || plan.billingType || '').toLowerCase();
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
  } else if (['CANCELLED', 'SUSPENDED', 'EXPIRED'].includes(status)) {
    const free = await Plan.findOne({ slug: 'free', isActive: true });
    if (free) await assignPlanToUser(user, free, new Date());
    if (attempt) { attempt.status = 'cancelled'; attempt.cancelledAt ||= new Date(); }
    if (managementAttempt?.operation === 'CANCEL' && ['CANCELLED', 'EXPIRED'].includes(status)) {
      managementAttempt.status = 'completed'; managementAttempt.completedAt ||= new Date();
      managementAttempt.activeOperationKey = undefined; managementAttempt.processingLeaseExpiresAt = null;
    }
  } else {
    await user.save({ validateModifiedOnly: true });
  }
  if (attempt) await attempt.save();
  if (managementAttempt) await managementAttempt.save();
  return { user, plan, attempt, managementAttempt, status };
}

module.exports = { ATTEMPT_PROCESSING_LEASE_MS, PAYPAL_BLOCKING_STATUSES, PAYPAL_PENDING_STATUSES,
  PAYPAL_TERMINAL_STATUSES, approvalUrl, createSubscription, syncSubscription, subscriptionPeriod };
