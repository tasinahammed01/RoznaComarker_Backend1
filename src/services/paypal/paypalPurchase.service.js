'use strict';

const PaymentPurchaseAttempt = require('../../models/PaymentPurchaseAttempt');
const CreditTransaction = require('../../models/CreditTransaction');
const TopupService = require('../topup.service');
const { PayPalClient } = require('./paypalClient.service');
const { getPaypalRedirectUrls } = require('../../config/paypal');

const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['creating', 'capturing']);

function purchaseError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function paymentProvider(environment = process.env) {
  return String(environment.PAYMENT_PROVIDER || 'stripe').trim().toLowerCase();
}

function trustedMoney(price, currency) {
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(code)) throw purchaseError('CREDIT_PACK_CURRENCY_INVALID', 'Credit pack currency is invalid', 503);
  const raw = String(price);
  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/u);
  if (!match) throw purchaseError('CREDIT_PACK_PRICE_INVALID', 'Credit pack price must use at most two decimal places', 503);
  const value = `${match[1]}.${String(match[2] || '').padEnd(2, '0')}`;
  if (BigInt(match[1] + String(match[2] || '').padEnd(2, '0')) <= 0n) {
    throw purchaseError('CREDIT_PACK_PRICE_INVALID', 'Credit pack price must be positive', 503);
  }
  return { value, currency: code };
}

function sameMoney(actual, expectedAmount, expectedCurrency) {
  try {
    const normalized = trustedMoney(actual?.value, actual?.currency_code);
    return normalized.value === expectedAmount && normalized.currency === expectedCurrency;
  } catch { return false; }
}

function safeApprovalUrl(order) {
  const link = order?.links?.find((item) => ['payer-action', 'approve'].includes(item?.rel) && item?.method === 'GET');
  if (!link?.href) throw purchaseError('PAYPAL_ORDER_APPROVAL_MISSING', 'PayPal did not return an approval URL', 502);
  let url;
  try { url = new URL(link.href); } catch { throw purchaseError('PAYPAL_ORDER_APPROVAL_INVALID', 'PayPal returned an invalid approval URL', 502); }
  if (url.protocol !== 'https:' || !(url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))) {
    throw purchaseError('PAYPAL_ORDER_APPROVAL_INVALID', 'PayPal returned an untrusted approval URL', 502);
  }
  return url.toString();
}

function lease(now = new Date()) {
  return { lastAttemptAt: now, processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS) };
}

function publicAttempt(attempt) {
  return { attemptId: attempt.attemptId, ...(attempt.providerOrderId ? { orderId: attempt.providerOrderId } : {}),
    ...(attempt.approvalUrl ? { approvalUrl: attempt.approvalUrl } : {}), status: attempt.status,
    packCode: attempt.packCode, credits: attempt.credits, amount: attempt.expectedAmount, currency: attempt.currency,
    credited: attempt.status === 'credited', ...(attempt.safeFailureMessage ? { message: attempt.safeFailureMessage } : {}) };
}

function classify(error) {
  const permanent = [400, 401, 403, 404, 422].includes(error?.providerStatus);
  return { failureClass: permanent ? 'permanent' : 'retryable', failureCode: error?.providerIssue || error?.code || 'PAYPAL_ORDER_FAILED',
    safeFailureMessage: permanent ? 'PayPal could not process this purchase.' : 'PayPal is temporarily unavailable. Please try again.' };
}

async function markFailure(attempt, error) {
  const failure = classify(error);
  await PaymentPurchaseAttempt.updateOne({ _id: attempt._id, status: attempt.status }, { $set: {
    status: 'failed', ...failure, processingLeaseExpiresAt: null
  } });
  throw purchaseError(failure.failureCode, failure.safeFailureMessage, failure.failureClass === 'permanent' ? 409 : 502);
}

async function claimExisting(attempt, fromStatuses, nextStatus) {
  const now = new Date();
  const conditions = fromStatuses.map((status) => status === 'failed'
    ? { status: 'failed', failureClass: 'retryable' }
    : ACTIVE_STATUSES.has(status) ? { status, $or: [{ processingLeaseExpiresAt: { $lte: now } },
      { processingLeaseExpiresAt: { $exists: false } }, { processingLeaseExpiresAt: null }] } : { status });
  return PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, $or: conditions }, { $set: {
    status: nextStatus, failureClass: undefined, failureCode: null, safeFailureMessage: null, ...lease(now)
  }, $inc: { retryCount: 1 } }, { returnDocument: 'after' });
}

function createPayload(attempt, environment) {
  const attemptId = encodeURIComponent(attempt.attemptId);
  const redirects = getPaypalRedirectUrls('topup', environment, {
    return: { topup: 'paypal-confirming', attempt: attemptId },
    cancel: { topup: 'paypal-cancelled', attempt: attemptId }
  });
  return { intent: 'CAPTURE', purchase_units: [{ reference_id: attempt.attemptId,
    custom_id: `paypal-topup:${attempt.attemptId}`, description: `${attempt.credits} Assessment Credits (${attempt.packCode})`,
    amount: { currency_code: attempt.currency, value: attempt.expectedAmount } }], payment_source: { paypal: { experience_context: {
      return_url: redirects.returnUrl,
      cancel_url: redirects.cancelUrl,
      user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING'
    } } } };
}

async function createOrder({ user, packCode, attemptId, client = new PayPalClient(), environment = process.env }) {
  if (paymentProvider(environment) !== 'paypal') throw purchaseError('PAYPAL_PROVIDER_NOT_ENABLED', 'PayPal credit purchases are not enabled', 409);
  const { pack } = await TopupService.eligiblePack(user, packCode, { provider: 'paypal' });
  const money = trustedMoney(pack.price, pack.currency);
  let attempt;
  try {
    attempt = await PaymentPurchaseAttempt.create({ provider: 'paypal', attemptId, userId: user._id,
      packCode: pack.code, credits: pack.credits, expectedAmount: money.value, currency: money.currency,
      createRequestId: `topup-create:${attemptId}`, captureRequestId: `topup-capture:${attemptId}`,
      status: 'creating', ...lease() });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', attemptId });
    if (!attempt || String(attempt.userId) !== String(user._id)) throw purchaseError('PAYPAL_PURCHASE_ATTEMPT_CONFLICT', 'Purchase attempt is unavailable', 409);
    if (attempt.packCode !== pack.code) throw purchaseError('PAYPAL_PURCHASE_ATTEMPT_CONFLICT', 'Use a new checkout attempt for a different pack', 409);
    if (['approval_pending', 'capturing', 'captured', 'credited'].includes(attempt.status)) return publicAttempt(attempt);
    if (['cancelled', 'review_required', 'refunded'].includes(attempt.status) ||
      (attempt.status === 'failed' && attempt.failureClass === 'permanent')) {
      throw purchaseError('PAYPAL_PURCHASE_ATTEMPT_TERMINAL', 'Use a new checkout attempt for this purchase', 409);
    }
    const claimed = await claimExisting(attempt, ['creating', 'failed'], 'creating');
    if (!claimed) return publicAttempt(attempt);
    attempt = claimed;
  }
  let order;
  try { order = await client.createOrder(createPayload(attempt, environment), attempt.createRequestId); }
  catch (error) { return markFailure(attempt, error); }
  if (!order?.id) return markFailure(attempt, purchaseError('PAYPAL_ORDER_ID_MISSING', 'PayPal did not return an Order ID', 502));
  const approvalUrl = safeApprovalUrl(order);
  const saved = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id, status: 'creating' }, { $set: {
    providerOrderId: order.id, approvalUrl, status: 'approval_pending', processingLeaseExpiresAt: null,
    failureClass: undefined, failureCode: null, safeFailureMessage: null
  } }, { returnDocument: 'after' });
  if (!saved) throw purchaseError('PAYPAL_ORDER_PERSISTENCE_FAILED', 'Order was created but confirmation is still recovering. Retry shortly.', 503);
  return publicAttempt(saved);
}

function validatedCapture(order, attempt, { allowRefunded = false } = {}) {
  if (!order || String(order.id) !== attempt.providerOrderId || String(order.status).toUpperCase() !== 'COMPLETED') {
    throw purchaseError('PAYPAL_CAPTURE_NOT_COMPLETED', 'Payment is not completed yet', 409);
  }
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : [];
  if (units.length !== 1 || units[0].reference_id !== attempt.attemptId ||
    units[0].custom_id !== `paypal-topup:${attempt.attemptId}` || !sameMoney(units[0].amount, attempt.expectedAmount, attempt.currency)) {
    throw purchaseError('PAYPAL_CAPTURE_CORRELATION_MISMATCH', 'Payment details do not match this purchase', 409);
  }
  const captures = units.flatMap((unit) => unit?.payments?.captures || []);
  const acceptedStatuses = allowRefunded ? ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] : ['COMPLETED'];
  if (captures.length !== 1 || !captures[0]?.id || !acceptedStatuses.includes(String(captures[0].status).toUpperCase()) ||
    !sameMoney(captures[0].amount, attempt.expectedAmount, attempt.currency)) {
    throw purchaseError('PAYPAL_CAPTURE_NOT_COMPLETED', 'Payment is not completed yet', 409);
  }
  return captures[0];
}

async function grantCaptured(attempt, order, options) {
  const capture = validatedCapture(order, attempt, options);
  const conflict = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', providerCaptureId: capture.id, _id: { $ne: attempt._id } });
  if (conflict) throw purchaseError('PAYPAL_CAPTURE_OWNERSHIP_CONFLICT', 'Payment capture is already assigned', 409);
  await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { providerCaptureId: capture.id,
    status: 'captured', capturedAt: new Date(capture.update_time || capture.create_time || Date.now()), processingLeaseExpiresAt: null } });
  const pack = { code: attempt.packCode, name: attempt.packCode, credits: attempt.credits };
  const grant = await TopupService.grantProviderPurchasedCredits({ userId: attempt.userId, pack,
    idempotencyKey: `paypal-topup:capture:${capture.id}`, reason: `PayPal Assessment Credit purchase: ${attempt.packCode}`,
    metadata: { provider: 'paypal', packCode: attempt.packCode, creditsPurchased: attempt.credits,
      paypalOrderId: attempt.providerOrderId, paypalCaptureId: capture.id, pricePaid: attempt.expectedAmount, currency: attempt.currency } });
  const saved = await PaymentPurchaseAttempt.findOneAndUpdate({ _id: attempt._id }, { $set: { status: 'credited',
    creditedAt: new Date(), creditTransactionId: grant.transaction._id, processingLeaseExpiresAt: null } }, { returnDocument: 'after' });
  return publicAttempt(saved || { ...attempt.toObject(), status: 'credited', providerCaptureId: capture.id });
}

async function captureOrder({ user, attemptId, client = new PayPalClient() }) {
  let attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', attemptId, userId: user._id });
  if (!attempt) throw purchaseError('PAYPAL_PURCHASE_NOT_FOUND', 'Purchase attempt was not found', 404);
  if (attempt.status === 'credited') return publicAttempt(attempt);
  if (!attempt.providerOrderId) throw purchaseError('PAYPAL_ORDER_NOT_READY', 'PayPal Order is not ready', 409);
  if (['cancelled', 'refunded', 'review_required'].includes(attempt.status) ||
    (attempt.status === 'failed' && attempt.failureClass === 'permanent')) {
    throw purchaseError('PAYPAL_PURCHASE_ATTEMPT_TERMINAL', 'This purchase cannot be captured', 409);
  }
  if (attempt.status === 'captured') {
    const order = await client.getOrder(attempt.providerOrderId);
    return grantCaptured(attempt, order);
  }
  const claimed = await claimExisting(attempt, ['approval_pending', 'capturing', 'failed'], 'capturing');
  if (!claimed) throw purchaseError('PAYPAL_CAPTURE_PROCESSING', 'Payment confirmation is already processing', 409);
  attempt = claimed;
  let order;
  try {
    order = await client.captureOrder(attempt.providerOrderId, attempt.captureRequestId);
  } catch (error) {
    try { order = await client.getOrder(attempt.providerOrderId); }
    catch { return markFailure(attempt, error); }
    if (String(order?.status).toUpperCase() !== 'COMPLETED') return markFailure(attempt, error);
  }
  try { return await grantCaptured(attempt, order); }
  catch (error) {
    if (['PAYPAL_CAPTURE_CORRELATION_MISMATCH', 'PAYPAL_CAPTURE_OWNERSHIP_CONFLICT'].includes(error?.code)) {
      await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'review_required',
        failureClass: 'permanent', failureCode: error.code, safeFailureMessage: error.message, processingLeaseExpiresAt: null } });
    } else if (error?.code === 'PAYPAL_CAPTURE_NOT_COMPLETED') {
      await PaymentPurchaseAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'failed', failureClass: 'retryable',
        failureCode: error.code, safeFailureMessage: error.message, processingLeaseExpiresAt: null } });
    }
    throw error;
  }
}

async function reconcileCaptureWebhook({ orderId, captureId, client = new PayPalClient() }) {
  const attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', $or: [
    ...(orderId ? [{ providerOrderId: orderId }] : []), ...(captureId ? [{ providerCaptureId: captureId }] : [])
  ] });
  if (!attempt) throw purchaseError('PAYPAL_PAYMENT_CORRELATION_FAILED', 'Payment cannot be correlated', 422);
  const order = await client.getOrder(attempt.providerOrderId);
  return grantCaptured(attempt, order);
}

async function reconcileRefundOrReversal({ captureId, orderId, eventId, eventType, client = new PayPalClient() }) {
  let attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', $or: [
    { providerCaptureId: captureId }, ...(orderId ? [{ providerOrderId: orderId }] : [])
  ] });
  if (!attempt) throw purchaseError('PAYPAL_PAYMENT_CORRELATION_FAILED', 'Payment cannot be correlated', 422);
  const priorRefund = await CreditTransaction.findOne({ userId: attempt.userId, type: 'TOPUP_REFUND', status: 'refunded',
    'metadata.paypalCaptureId': captureId });
  if (priorRefund) {
    if (attempt.status !== 'refunded') {
      attempt.status = 'refunded'; attempt.refundedAt = attempt.refundedAt || new Date();
      attempt.failureCode = undefined; attempt.safeFailureMessage = undefined; await attempt.save();
    }
    return { attempt, transaction: priorRefund };
  }

  let purchase = await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:capture:${captureId}`, status: 'committed' });
  if (!purchase && attempt.providerOrderId) {
    const order = await client.getOrder(attempt.providerOrderId);
    await grantCaptured(attempt, order, { allowRefunded: true });
    attempt = await PaymentPurchaseAttempt.findById(attempt._id);
    purchase = await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:capture:${captureId}`, status: 'committed' });
  }
  if (!purchase) throw purchaseError('PAYPAL_PAYMENT_CORRELATION_FAILED', 'Credit purchase cannot be correlated', 422);
  const capture = await client.getCapture(captureId);
  const refunded = capture?.seller_receivable_breakdown?.total_refunded_amount;
  const isReversal = eventType === 'PAYMENT.CAPTURE.REVERSED';
  const full = isReversal ? sameMoney(capture?.amount, attempt.expectedAmount, attempt.currency)
    : sameMoney(refunded, attempt.expectedAmount, attempt.currency);
  const refundIdentity = isReversal ? 'full' : `${String(refunded?.currency_code || '').toUpperCase()}:${String(refunded?.value || 'unknown')}`;
  const key = `paypal-topup:${isReversal ? 'reversal' : 'refund'}:${captureId}:${refundIdentity}`;
  const transaction = await TopupService.reverseProviderPurchase({ purchase, idempotencyKey: key,
    reason: isReversal ? 'PayPal payment reversal' : 'PayPal purchased credits refunded', reviewOnly: !full,
    metadata: { provider: 'paypal', paypalOrderId: attempt.providerOrderId, paypalCaptureId: captureId,
      providerEventId: eventId, eventType, amountRefunded: refunded?.value || null, currency: refunded?.currency_code || attempt.currency } });
  attempt.status = transaction.status === 'refunded' ? 'refunded' : 'review_required';
  attempt.refundedAt = transaction.status === 'refunded' ? new Date() : undefined;
  attempt.failureCode = transaction.status === 'review_required' ? (full ? 'PAYPAL_REFUND_CREDITS_CONSUMED' : 'PAYPAL_PARTIAL_REFUND') : undefined;
  attempt.safeFailureMessage = transaction.status === 'review_required' ? 'Refund requires administrator review.' : undefined;
  await attempt.save();
  return { attempt, transaction };
}

async function cancelAttempt({ user, attemptId }) {
  const attempt = await PaymentPurchaseAttempt.findOneAndUpdate({ provider: 'paypal', attemptId, userId: user._id,
    status: { $in: ['creating', 'approval_pending', 'failed'] }, providerCaptureId: { $exists: false } }, { $set: {
    status: 'cancelled', processingLeaseExpiresAt: null, safeFailureMessage: null
  } }, { returnDocument: 'after' });
  if (attempt) return publicAttempt(attempt);
  const existing = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', attemptId, userId: user._id });
  if (!existing) throw purchaseError('PAYPAL_PURCHASE_NOT_FOUND', 'Purchase attempt was not found', 404);
  return publicAttempt(existing);
}

async function getAttempt({ user, attemptId }) {
  const attempt = await PaymentPurchaseAttempt.findOne({ provider: 'paypal', attemptId, userId: user._id });
  if (!attempt) throw purchaseError('PAYPAL_PURCHASE_NOT_FOUND', 'Purchase attempt was not found', 404);
  return publicAttempt(attempt);
}

module.exports = { PROCESSING_LEASE_MS, trustedMoney, sameMoney, safeApprovalUrl, publicAttempt, createPayload,
  createOrder, captureOrder, reconcileCaptureWebhook, reconcileRefundOrReversal, cancelAttempt, getAttempt, validatedCapture };
