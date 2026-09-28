'use strict';

const crypto = require('crypto');
const PaymentPurchaseAttempt = require('../../models/PaymentPurchaseAttempt');
const Plan = require('../../models/Plan');
const { PayPalClient } = require('./paypalClient.service');
const { getPaypalRedirectUrls, getPaypalEnvironment } = require('../../config/paypal');
const { configuredProviderName } = require('../payments/paymentProvider.service');
const { trustedMoney, sameMoney, safeApprovalUrl, safeFailureCode,
  classify: classifyPayPalFailure } = require('./paypalPurchase.service');
const logger = require('../../utils/logger');
const Entitlements = require('../planEntitlement.service');

const LEASE_MS = 120000;
const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const lease = () => ({ lastAttemptAt: new Date(), processingLeaseExpiresAt: new Date(Date.now() + LEASE_MS) });

function publicAttempt(attempt, entitlement) {
  const failureCode = safeFailureCode(attempt.failureCode);
  return { attemptId: attempt.attemptId, orderId: attempt.providerOrderId || undefined, approvalUrl: attempt.approvalUrl || undefined,
    status: attempt.status, purpose: 'plan_purchase', planSlug: attempt.planSlug, billingPeriod: attempt.billingPeriod,
    amount: attempt.expectedAmount, currency: attempt.currency, fulfilled: attempt.status === 'fulfilled',
    ...(failureCode ? { failureCode, retryable: attempt.failureClass === 'retryable' } : {}),
    entitlement: entitlement ? { id: String(entitlement._id), status: entitlement.status,
      startsAt: entitlement.startsAt, endsAt: entitlement.endsAt } : undefined,
    message: attempt.safeFailureMessage || undefined };
}

async function markCaptureFailure(attempt, cause) {
  const failure = classifyPayPalFailure(cause);
  const restart = failure.recoveryAction === 'restart';
  const safeFailureMessage = restart
    ? "PayPal couldn't use this payment method. Please choose another card or payment method."
    : failure.failureClass === 'permanent'
      ? 'PayPal could not complete this plan payment.'
      : 'Payment confirmation failed. Retry this payment.';
  logger.warn({ event: 'paypal.plan_purchase.failure', environment: attempt.providerEnvironment,
    attemptId: attempt.attemptId, providerOrderId: attempt.providerOrderId || null,
    providerStatus: cause?.providerStatus || null, providerIssue: cause?.providerIssue || null,
    debugId: cause?.debugId || null, failureClass: failure.failureClass });
  await PaymentPurchaseAttempt.updateOne({ _id: attempt._id, status: attempt.status }, { $set: {
    status: restart ? 'approval_pending' : 'failed', failureClass: failure.failureClass,
    failureCode: failure.failureCode, safeFailureMessage, providerDebugId: cause?.debugId || null,
    processingLeaseExpiresAt: null,
    ...(restart ? { captureRequestId: `plan-capture:${attempt.attemptId}:${crypto.randomUUID()}` } : {})
  } });
  throw error(failure.failureCode, safeFailureMessage,
    restart ? 422 : failure.failureClass === 'permanent' ? 409 : 502);
}

async function trustedPlan(planSlug, billingPeriod) {
  if (!['monthly', 'annual'].includes(billingPeriod)) throw error('PLAN_PERIOD_INVALID', 'Billing period is invalid');
  const slug = String(planSlug || '').trim().toLowerCase();
  if (!slug || ['free', 'custom', 'institution'].includes(slug)) throw error('PLAN_NOT_PURCHASABLE', 'Plan is not available for checkout');
  const plan = await Plan.findOne({ slug, isActive: true });
  if (!plan) throw error('PLAN_NOT_FOUND', 'Plan not found', 404);
  const amount = billingPeriod === 'annual' ? plan.annualPrice : plan.price;
  const money = trustedMoney(amount, plan.currency);
  return { plan, money };
}

function payload(attempt, environment) {
  const encoded = encodeURIComponent(attempt.attemptId);
  const redirects = getPaypalRedirectUrls('topup', environment, {
    return: { plan: 'paypal-confirming', attempt: encoded }, cancel: { plan: 'paypal-cancelled', attempt: encoded }
  });
  return { intent: 'CAPTURE', purchase_units: [{ reference_id: attempt.attemptId,
    custom_id: `paypal-plan:${attempt.attemptId}`,
    description: `${attempt.planSlug} plan - ${attempt.billingPeriod} prepaid term`,
    amount: { currency_code: attempt.currency, value: attempt.expectedAmount } }],
  application_context: { return_url: redirects.returnUrl, cancel_url: redirects.cancelUrl,
    user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } };
}

async function createOrder({ user, planSlug, billingPeriod = 'monthly', attemptId, client = new PayPalClient(), environment = process.env }) {
  configuredProviderName(environment);
  if (Entitlements.recurringPaidThrough(user)) throw error('LEGACY_SUBSCRIPTION_ACTIVE',
    'Your recurring PayPal subscription is still active. Manage it before buying a prepaid term.', 409);
  const { plan, money } = await trustedPlan(planSlug, billingPeriod);
  let attempt;
  try {
    attempt = await PaymentPurchaseAttempt.create({ provider: 'paypal', providerEnvironment: getPaypalEnvironment(environment), purpose: 'plan_purchase', purchaseType: undefined,
      attemptId, userId: user._id, fundingSource: 'paypal', planSlug: plan.slug, billingPeriod,
      expectedAmount: money.value, currency: money.currency, createRequestId: `plan-create:${attemptId}`,
      captureRequestId: `plan-capture:${attemptId}`, status: 'creating', ...lease() });
  } catch (cause) {
    if (cause?.code !== 11000) throw cause;
    attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', attemptId });
    if (!attempt || String(attempt.userId) !== String(user._id) || attempt.purpose !== 'plan_purchase' ||
      attempt.planSlug !== plan.slug || attempt.billingPeriod !== billingPeriod) {
      throw error('PAYPAL_PURCHASE_ATTEMPT_CONFLICT', 'Purchase attempt is unavailable', 409);
    }
    if (['approval_pending', 'capturing', 'captured', 'fulfilled'].includes(attempt.status)) return publicAttempt(attempt);
    if (['cancelled', 'refunded', 'review_required'].includes(attempt.status)) throw error('PAYPAL_PURCHASE_ATTEMPT_TERMINAL', 'Use a new checkout attempt', 409);
    const claimed = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, $or: [
      { status: 'failed', failureClass: 'retryable' }, { status: 'creating', processingLeaseExpiresAt: { $lte: new Date() } }
    ] }, { $set: { status: 'creating', ...lease() }, $inc: { retryCount: 1 } }, { returnDocument: 'after' });
    if (!claimed) return publicAttempt(attempt);
    attempt = claimed;
  }
  let order;
  try { order = await client.createOrder(payload(attempt, environment), attempt.createRequestId); }
  catch { await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'failed', failureClass: 'retryable',
    failureCode: 'PAYPAL_ORDER_FAILED', safeFailureMessage: 'PayPal is temporarily unavailable. Please try again.', processingLeaseExpiresAt: null } });
    throw error('PAYPAL_ORDER_FAILED', 'PayPal is temporarily unavailable. Please try again.', 502); }
  if (!order?.id) throw error('PAYPAL_ORDER_ID_MISSING', 'PayPal did not return an Order ID', 502);
  const saved = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, status: 'creating' }, { $set: {
    providerOrderId: order.id, approvalUrl: safeApprovalUrl(order), status: 'approval_pending', processingLeaseExpiresAt: null
  } }, { returnDocument: 'after' });
  if (!saved) throw error('PAYPAL_ORDER_PERSISTENCE_FAILED', 'Order confirmation is recovering. Retry shortly.', 503);
  return publicAttempt(saved);
}

function validate(order, attempt, allowRefunded = false) {
  if (attempt.providerEnvironment !== getPaypalEnvironment()) {
    throw error('PAYPAL_ENVIRONMENT_MISMATCH', 'Payment environment does not match this purchase', 409);
  }
  const units = order?.purchase_units || [];
  if (String(order?.id) !== attempt.providerOrderId || String(order?.status).toUpperCase() !== 'COMPLETED' || units.length !== 1 ||
    units[0].reference_id !== attempt.attemptId || units[0].custom_id !== `paypal-plan:${attempt.attemptId}` ||
    !sameMoney(units[0].amount, attempt.expectedAmount, attempt.currency)) {
    throw error('PAYPAL_CAPTURE_CORRELATION_MISMATCH', 'Payment details do not match this plan purchase', 409);
  }
  const captures = units.flatMap(unit => unit?.payments?.captures || []);
  const statuses = allowRefunded ? ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] : ['COMPLETED'];
  if (captures.length !== 1 || !captures[0]?.id || !statuses.includes(String(captures[0].status).toUpperCase()) ||
    !sameMoney(captures[0].amount, attempt.expectedAmount, attempt.currency)) throw error('PAYPAL_CAPTURE_NOT_COMPLETED', 'Payment is not completed yet', 409);
  return captures[0];
}

async function fulfill(attempt, order, allowRefunded = false) {
  if (attempt.status === 'refunded') return publicAttempt(attempt, await require('../../models/PlanEntitlement').findOne({ paymentAttemptId: attempt._id }));
  const capture = validate(order, attempt, allowRefunded);
  const conflict = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', providerCaptureId: capture.id, _id: { $ne: attempt._id } });
  if (conflict) throw error('PAYPAL_CAPTURE_OWNERSHIP_CONFLICT', 'Payment capture is already assigned', 409);
  await PaymentPurchaseAttempt.updateOne({ _id: attempt._id, status: { $nin: ['refunded', 'review_required'] } }, { $set: {
    providerCaptureId: capture.id, status: 'captured', capturedAt: new Date(capture.update_time || capture.create_time || Date.now()), processingLeaseExpiresAt: null
  } });
  const plan = await Plan.findOne({ slug: attempt.planSlug, isActive: true });
  if (!plan) throw error('PLAN_NOT_FOUND', 'Purchased plan is no longer configured', 503);
  const entitlement = await Entitlements.fulfillPlanPurchase({ attempt, plan, capture });
  const saved = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, status: { $nin: ['refunded', 'review_required'] } },
    { $set: { status: 'fulfilled', entitlementId: entitlement._id, processingLeaseExpiresAt: null } }, { returnDocument: 'after' });
  return publicAttempt(saved || await PaymentPurchaseAttempt.findById(attempt._id), entitlement);
}

async function captureOrder({ user, attemptId, client = new PayPalClient() }) {
  let attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', purpose: 'plan_purchase', attemptId, userId: user._id });
  if (!attempt) throw error('PAYPAL_PURCHASE_NOT_FOUND', 'Purchase attempt was not found', 404);
  if (attempt.status === 'fulfilled') return publicAttempt(attempt, await require('../../models/PlanEntitlement').findById(attempt.entitlementId));
  if (!attempt.providerOrderId) throw error('PAYPAL_ORDER_NOT_READY', 'PayPal Order is not ready', 409);
  if (['cancelled', 'refunded', 'review_required'].includes(attempt.status) ||
    (attempt.status === 'failed' && attempt.failureClass === 'permanent')) {
    throw error('PAYPAL_PURCHASE_ATTEMPT_TERMINAL', 'This plan purchase cannot be captured', 409);
  }
  const claimed = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, $or: [
    { status: { $in: ['approval_pending', 'captured'] } },
    { status: 'failed', failureClass: 'retryable' },
    { status: 'capturing', processingLeaseExpiresAt: { $lte: new Date() } }
  ] }, { $set: { status: 'capturing', ...lease() },
    $unset: { failureClass: 1, failureCode: 1, safeFailureMessage: 1, providerDebugId: 1 },
    $inc: { retryCount: 1 } }, { returnDocument: 'after' });
  if (!claimed) throw error('PAYPAL_CAPTURE_PROCESSING', 'Payment confirmation is already processing', 409);
  attempt = claimed;
  let order;
  try { order = attempt.providerCaptureId ? await client.getOrder(attempt.providerOrderId)
    : await client.captureOrder(attempt.providerOrderId, attempt.captureRequestId); }
  catch (cause) {
    try { order = await client.getOrder(attempt.providerOrderId); } catch { order = null; }
    if (String(order?.status).toUpperCase() !== 'COMPLETED') return markCaptureFailure(attempt, cause);
  }
  return fulfill(attempt, order);
}

async function reconcileCaptureWebhook({ orderId, captureId, client = new PayPalClient() }) {
  const attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', purpose: 'plan_purchase', $or: [
    ...(orderId ? [{ providerOrderId: orderId }] : []), ...(captureId ? [{ providerCaptureId: captureId }] : []) ] });
  if (!attempt) throw error('PAYPAL_PAYMENT_CORRELATION_FAILED', 'Payment cannot be correlated', 422);
  return fulfill(attempt, await client.getOrder(attempt.providerOrderId));
}

async function reconcileRefundOrReversal({ captureId, orderId, eventId, client = new PayPalClient() }) {
  const attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', purpose: 'plan_purchase', $or: [
    { providerCaptureId: captureId }, ...(orderId ? [{ providerOrderId: orderId }] : []) ] });
  if (!attempt) throw error('PAYPAL_PAYMENT_CORRELATION_FAILED', 'Payment cannot be correlated', 422);
  const capture = await client.getCapture(captureId);
  const refunded = capture?.seller_receivable_breakdown?.total_refunded_amount;
  if (!sameMoney(refunded || capture?.amount, attempt.expectedAmount, attempt.currency)) {
    await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'review_required', failureCode: 'PAYPAL_PARTIAL_REFUND' } });
    throw error('PAYPAL_PARTIAL_REFUND', 'Partial plan refund requires review', 422);
  }
  const entitlement = await Entitlements.reconcileRefund({ attempt, eventId });
  await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'refunded', refundedAt: new Date(), entitlementId: entitlement?._id } });
  return { attempt, entitlement };
}

async function cancel({ user, attemptId }) {
  const attempt = await PaymentPurchaseAttempt.findOneAndUpdate({ provider: 'paypal', purpose: 'plan_purchase', attemptId,
    userId: user._id, status: { $in: ['creating', 'approval_pending', 'failed'] } }, { $set: { status: 'cancelled', processingLeaseExpiresAt: null } }, { returnDocument: 'after' });
  if (!attempt) throw error('PAYPAL_PURCHASE_NOT_CANCELLABLE', 'Purchase cannot be cancelled', 409);
  return publicAttempt(attempt);
}

async function get({ user, attemptId }) {
  const attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', purpose: 'plan_purchase', attemptId, userId: user._id });
  if (!attempt) throw error('PAYPAL_PURCHASE_NOT_FOUND', 'Purchase attempt was not found', 404);
  return publicAttempt(attempt, attempt.entitlementId ? await require('../../models/PlanEntitlement').findById(attempt.entitlementId) : null);
}

module.exports = { createOrder, captureOrder, reconcileCaptureWebhook, reconcileRefundOrReversal, cancel, get, trustedPlan, validate, publicAttempt };
