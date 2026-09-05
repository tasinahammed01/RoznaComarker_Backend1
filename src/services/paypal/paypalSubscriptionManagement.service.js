'use strict';

const { randomUUID } = require('crypto');
const Plan = require('../../models/Plan');
const PaymentManagementAttempt = require('../../models/PaymentManagementAttempt');
const { approvalUrl } = require('./paypalSubscription.service');
const { getPayPalPlanId, getPlanByPayPalPlanId, isFreeOrNonBillable } = require('./paypalPlanMapping.service');
const { getPaypalConfig, getPaypalRedirectUrls } = require('../../config/paypal');

const MANAGEABLE = new Set(['ACTIVE', 'SUSPENDED']);
const TERMINAL = new Set(['CANCELLED', 'EXPIRED']);
const ACTIVE_STATUSES = ['processing', 'approval_pending', 'provider_pending'];
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const CANCEL_REASON = 'Cancelled by subscriber from CoMarker account settings.';

function domainError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function activeOperationKey(providerSubscriptionId) {
  return `paypal:${providerSubscriptionId}`;
}

function lease(now = new Date()) {
  return { lastAttemptAt: now, processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS) };
}

function assertPayPalUser(user) {
  if (!user || !user.paypalSubscriptionId || !user.paypalPlanId) {
    throw domainError('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE', 'No manageable PayPal subscription was found', 409);
  }
}

function interval(plan) {
  return ['year', 'yearly', 'annual'].includes(String(plan.billingInterval || plan.billingType || '').toLowerCase()) ? 'yearly' : 'monthly';
}

function failureClass(error) {
  return [400, 401, 403, 404, 422].includes(Number(error?.providerStatus)) ? 'permanent' : 'retryable';
}

function isDuplicate(error) { return error?.code === 11000; }

async function authoritativeSubscription(user, client, failureCode) {
  assertPayPalUser(user);
  let subscription;
  try { subscription = await client.getSubscription(user.paypalSubscriptionId); }
  catch { throw domainError(failureCode, 'Unable to confirm the PayPal subscription', 502); }
  if (String(subscription?.id || '') !== user.paypalSubscriptionId) {
    throw domainError('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE', 'PayPal subscription ownership could not be confirmed', 409);
  }
  return subscription;
}

async function findActive(providerSubscriptionId) {
  return PaymentManagementAttempt.findOne({
    activeOperationKey: activeOperationKey(providerSubscriptionId), status: { $in: ACTIVE_STATUSES }
  }).sort({ createdAt: -1 });
}

async function createOwnedAttempt(fields) {
  const now = new Date();
  return PaymentManagementAttempt.create({ ...fields,
    activeOperationKey: activeOperationKey(fields.providerSubscriptionId), ...lease(now) });
}

async function claimRetryable(attempt) {
  const now = new Date();
  try {
    return await PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id, status: 'failed', failureClass: 'retryable' }, {
      $set: { status: 'processing', activeOperationKey: activeOperationKey(attempt.providerSubscriptionId),
        errorCode: null, failureClass: null, ...lease(now) }, $inc: { retryCount: 1 }
    }, { returnDocument: 'after' });
  } catch (error) {
    if (isDuplicate(error)) return null;
    throw error;
  }
}

async function claimStale(attempt) {
  const now = new Date();
  try {
    return await PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id, status: 'processing',
      $or: [{ processingLeaseExpiresAt: { $lte: now } }, { processingLeaseExpiresAt: { $exists: false } }] }, {
      $set: { activeOperationKey: activeOperationKey(attempt.providerSubscriptionId), ...lease(now) },
      $inc: { retryCount: 1 }
    }, { returnDocument: 'after' });
  } catch (error) {
    if (isDuplicate(error)) return null;
    throw error;
  }
}

async function markActiveOutcome(attempt, status, fields = {}) {
  return PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id,
    activeOperationKey: activeOperationKey(attempt.providerSubscriptionId), status: 'processing' }, {
    $set: { status, ...fields, processingLeaseExpiresAt: null, errorCode: null, failureClass: null }
  }, { returnDocument: 'after' });
}

async function markFailed(attempt, errorCode, classification) {
  return PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id }, {
    $set: { status: 'failed', errorCode, failureClass: classification, processingLeaseExpiresAt: null },
    $unset: { activeOperationKey: 1 }
  }, { returnDocument: 'after' });
}

function existingResult(attempt) {
  return { attempt, requiresApproval: attempt.status === 'approval_pending' };
}

async function executeCancel(attempt, client) {
  try {
    await client.cancelSubscription(attempt.providerSubscriptionId, CANCEL_REASON, attempt.providerRequestId);
  } catch (error) {
    const classification = failureClass(error);
    await markFailed(attempt, 'PAYPAL_CANCEL_FAILED', classification);
    throw domainError('PAYPAL_CANCEL_FAILED', classification === 'retryable'
      ? 'PayPal cancellation could not be confirmed; retry is safe'
      : 'PayPal rejected the cancellation request', classification === 'retryable' ? 502 : 409);
  }
  try {
    const saved = await markActiveOutcome(attempt, 'provider_pending');
    if (!saved) throw new Error('Cancellation ownership was lost');
    return { pending: true, attempt: saved };
  } catch {
    // PayPal may already have accepted the request. Keep the processing owner
    // and stable providerRequestId; a stale-lease retry safely replays it.
    throw domainError('PAYPAL_CANCEL_FAILED', 'Cancellation was sent to PayPal and is awaiting safe recovery', 503);
  }
}

async function cancelSubscription({ user, client }) {
  const subscription = await authoritativeSubscription(user, client, 'PAYPAL_CANCEL_FAILED');
  const status = String(subscription.status || '').toUpperCase();
  if (TERMINAL.has(status)) return { alreadyTerminal: true, status };
  if (!MANAGEABLE.has(status)) throw domainError('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE', 'PayPal subscription cannot be cancelled in its current state', 409);

  let active = await findActive(user.paypalSubscriptionId);
  if (active) {
    if (active.operation !== 'CANCEL') throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
    if (active.status !== 'processing') return { pending: true, attempt: active, status };
    const reclaimed = await claimStale(active);
    if (!reclaimed) return { pending: true, attempt: active, status };
    return { ...(await executeCancel(reclaimed, client)), status };
  }

  const failed = await PaymentManagementAttempt.findOne({ provider: 'paypal', userId: user._id,
    providerSubscriptionId: user.paypalSubscriptionId, operation: 'CANCEL', status: 'failed', failureClass: 'retryable' })
    .sort({ createdAt: -1 });
  if (failed) {
    const reclaimed = await claimRetryable(failed);
    if (reclaimed) return { ...(await executeCancel(reclaimed, client)), status };
    active = await findActive(user.paypalSubscriptionId);
    if (active?.operation === 'CANCEL') return { pending: true, attempt: active, status };
    throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
  }

  const attemptId = randomUUID();
  let attempt;
  try {
    attempt = await createOwnedAttempt({ provider: 'paypal', attemptId, userId: user._id,
      providerSubscriptionId: user.paypalSubscriptionId, operation: 'CANCEL',
      sourcePlanKey: (await getPlanByPayPalPlanId(subscription.plan_id)).slug,
      sourceProviderPlanId: subscription.plan_id, providerRequestId: `cancel-${attemptId}`, status: 'processing' });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    active = await findActive(user.paypalSubscriptionId);
    if (active?.operation === 'CANCEL') return { pending: true, attempt: active, status };
    throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
  }
  return { ...(await executeCancel(attempt, client)), status };
}

async function executeChange(attempt, client, environment) {
  const redirects = getPaypalRedirectUrls('changePlan', environment, {
    return: { attempt: attempt.attemptId }, cancel: { attempt: attempt.attemptId }
  });
  let revised;
  try {
    revised = await client.reviseSubscription(attempt.providerSubscriptionId, { plan_id: attempt.targetProviderPlanId,
      application_context: { return_url: redirects.returnUrl, cancel_url: redirects.cancelUrl } }, attempt.providerRequestId);
  } catch (error) {
    const classification = failureClass(error);
    const code = classification === 'permanent' && Number(error?.providerStatus) === 422
      ? 'PAYPAL_PLAN_CHANGE_UNSUPPORTED' : 'PAYPAL_PLAN_CHANGE_FAILED';
    await markFailed(attempt, code, classification);
    throw domainError(code, classification === 'retryable'
      ? 'PayPal plan change could not be confirmed; retry is safe'
      : 'PayPal does not support this plan transition', classification === 'retryable' ? 502 : 409);
  }
  let href = null;
  try {
    href = revised?.links?.some((link) => link?.rel === 'approve')
      ? approvalUrl(revised, 'PAYPAL_PLAN_CHANGE_FAILED') : null;
  } catch (error) {
    await markFailed(attempt, 'PAYPAL_PLAN_CHANGE_FAILED', 'permanent');
    throw error;
  }
  try {
    const saved = await markActiveOutcome(attempt, href ? 'approval_pending' : 'provider_pending', { approvalUrl: href });
    if (!saved) throw new Error('Plan-change ownership was lost');
    return existingResult(saved);
  } catch {
    // The provider call may have succeeded. Keep ownership and the same
    // PayPal-Request-Id so stale recovery can replay safely.
    throw domainError('PAYPAL_PLAN_CHANGE_FAILED', 'Plan change was sent to PayPal and is awaiting safe recovery', 503);
  }
}

async function changePlan({ user, targetPlanCode, changeAttemptId, client, environment = process.env }) {
  const subscription = await authoritativeSubscription(user, client, 'PAYPAL_PLAN_CHANGE_FAILED');
  const status = String(subscription.status || '').toUpperCase();
  if (!MANAGEABLE.has(status)) throw domainError('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE', 'PayPal subscription cannot be changed in its current state', 409);
  const targetSlug = String(targetPlanCode || '').trim().toLowerCase();
  const target = await Plan.findOne({ slug: targetSlug, isActive: true }).lean();
  if (!target || isFreeOrNonBillable(target)) throw domainError('PAYPAL_PLAN_CHANGE_TARGET_INVALID', 'Target plan is not available', target ? 400 : 404);
  const source = await getPlanByPayPalPlanId(subscription.plan_id, { environment });
  const targetProviderPlanId = await getPayPalPlanId({ planKey: target.slug, billingInterval: interval(target) }, { environment });
  if (targetProviderPlanId === subscription.plan_id || target.slug === source.slug) {
    throw domainError('PAYPAL_PLAN_CHANGE_SAME_PLAN', 'Target plan is already active', 409);
  }

  let existing = await PaymentManagementAttempt.findOne({ provider: 'paypal', attemptId: changeAttemptId });
  if (existing) {
    if (!existing.userId.equals(user._id) || existing.providerSubscriptionId !== user.paypalSubscriptionId || existing.targetPlanKey !== target.slug) {
      throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Management attempt belongs to another operation', 409);
    }
    if (['approval_pending', 'provider_pending', 'completed'].includes(existing.status)) return existingResult(existing);
    if (existing.status === 'cancelled') throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Cancelled plan changes require a new attempt ID', 409);
    if (existing.status === 'failed' && existing.failureClass === 'permanent') {
      throw domainError(existing.errorCode || 'PAYPAL_PLAN_CHANGE_FAILED', 'This plan change cannot be retried', 409);
    }
    if (existing.status === 'failed') {
      const reclaimed = await claimRetryable(existing);
      if (reclaimed) return executeChange(reclaimed, client, environment);
    }
    if (existing.status === 'processing') {
      const reclaimed = await claimStale(existing);
      if (reclaimed) return executeChange(reclaimed, client, environment);
      return existingResult(existing);
    }
    const active = await findActive(user.paypalSubscriptionId);
    if (active) throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
  }

  let active = await findActive(user.paypalSubscriptionId);
  if (active) {
    if (active.operation === 'CHANGE_PLAN' && active.targetPlanKey === target.slug && active.status === 'processing') {
      const reclaimed = await claimStale(active);
      if (reclaimed) return executeChange(reclaimed, client, environment);
    }
    throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
  }

  let sourceProviderPlan; let targetProviderPlan;
  try {
    [sourceProviderPlan, targetProviderPlan] = await Promise.all([
      client.getPlan(subscription.plan_id), client.getPlan(targetProviderPlanId)
    ]);
  } catch (error) {
    if (error?.providerStatus === 422) throw domainError('PAYPAL_PLAN_CHANGE_UNSUPPORTED', 'PayPal does not support this plan transition', 409);
    throw domainError('PAYPAL_PLAN_CHANGE_FAILED', 'Unable to validate PayPal plans', 502);
  }
  const configuredProductId = getPaypalConfig(environment).productId;
  if (!configuredProductId || sourceProviderPlan?.product_id !== configuredProductId || targetProviderPlan?.product_id !== configuredProductId) {
    throw domainError('PAYPAL_PLAN_CHANGE_UNSUPPORTED', 'PayPal plans are not compatible for revision', 409);
  }

  let attempt;
  try {
    attempt = await createOwnedAttempt({ provider: 'paypal', attemptId: changeAttemptId, userId: user._id,
      providerSubscriptionId: user.paypalSubscriptionId, operation: 'CHANGE_PLAN', sourcePlanKey: source.slug,
      sourceProviderPlanId: subscription.plan_id, targetPlanKey: target.slug, targetProviderPlanId,
      providerRequestId: `revise-${changeAttemptId}`, status: 'processing' });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    existing = await PaymentManagementAttempt.findOne({ provider: 'paypal', attemptId: changeAttemptId });
    if (existing) return existingResult(existing);
    throw domainError('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT', 'Another PayPal subscription change is pending', 409);
  }
  return executeChange(attempt, client, environment);
}

async function markChangePlanCancelled({ user, changeAttemptId }) {
  const attempt = await PaymentManagementAttempt.findOne({ provider: 'paypal', attemptId: changeAttemptId,
    userId: user._id, operation: 'CHANGE_PLAN' });
  if (!attempt) throw domainError('PAYPAL_PLAN_CHANGE_TARGET_INVALID', 'Plan change attempt was not found', 404);
  if (attempt.status === 'approval_pending') {
    return PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id, status: 'approval_pending' }, {
      $set: { status: 'cancelled', cancelledAt: new Date(), processingLeaseExpiresAt: null },
      $unset: { activeOperationKey: 1 }
    }, { returnDocument: 'after' });
  }
  return attempt;
}

module.exports = { ACTIVE_STATUSES, CANCEL_REASON, MANAGEABLE, PROCESSING_LEASE_MS, TERMINAL,
  activeOperationKey, cancelSubscription, changePlan, markChangePlanCancelled, domainError };
