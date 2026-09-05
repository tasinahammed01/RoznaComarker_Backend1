'use strict';

const PaymentProviderEvent = require('../models/PaymentProviderEvent');
const { PayPalClient } = require('../services/paypal/paypalClient.service');
const { syncSubscription } = require('../services/paypal/paypalSubscription.service');
const PayPalPurchaseService = require('../services/paypal/paypalPurchase.service');
const logger = require('../utils/logger');
const { getPaypalConfig } = require('../config/paypal');

const SUPPORTED = new Set(['BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']);
const PAYMENT_EVENTS = new Set(['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']);
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

function leaseFields(now = new Date()) {
  return { processingStartedAt: now, processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS) };
}

async function claimEvent(event) {
  const now = new Date();
  try {
    return { ledger: await PaymentProviderEvent.create({ provider: 'paypal', providerEventId: event.id,
      eventType: event.event_type, resourceId: event.resource?.id, processingAttemptCount: 1, ...leaseFields(now) }), claimed: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const reclaimed = await PaymentProviderEvent.findOneAndUpdate({
    provider: 'paypal', providerEventId: event.id,
    $or: [
      { status: 'failed' },
      { status: 'processing', processingLeaseExpiresAt: { $lte: now } },
      { status: 'processing', processingLeaseExpiresAt: { $exists: false } }
    ]
  }, {
    $set: { status: 'processing', eventType: event.event_type, resourceId: event.resource?.id,
      errorCode: null, processedAt: null, ...leaseFields(now) },
    $inc: { processingAttemptCount: 1 }
  }, { returnDocument: 'after' });
  if (reclaimed) return { ledger: reclaimed, claimed: true };

  const existing = await PaymentProviderEvent.findOne({ provider: 'paypal', providerEventId: event.id });
  return { ledger: existing, claimed: false };
}

function verificationPayload(req, event, environment = process.env) {
  const names = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (names.some((name) => !String(req.headers[name] || '').trim())) return null;
  return { auth_algo: req.headers['paypal-auth-algo'], cert_url: req.headers['paypal-cert-url'],
    transmission_id: req.headers['paypal-transmission-id'], transmission_sig: req.headers['paypal-transmission-sig'],
    transmission_time: req.headers['paypal-transmission-time'], webhook_id: getPaypalConfig(environment).webhookId,
    webhook_event: event };
}

async function paypalWebhook(req, res) {
  let event;
  try { event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '')); }
  catch { return res.status(400).json({ success: false, code: 'PAYPAL_WEBHOOK_INVALID_JSON' }); }
  let verify;
  try { verify = verificationPayload(req, event); } catch { verify = null; }
  if (!verify || !String(verify.webhook_id || '').trim()) {
    return res.status(400).json({ success: false, code: 'PAYPAL_WEBHOOK_VERIFICATION_FAILED' });
  }
  try {
    const result = await new PayPalClient().verifyWebhookSignature(verify);
    if (result?.verification_status !== 'SUCCESS') throw new Error('verification failed');
  } catch {
    return res.status(400).json({ success: false, code: 'PAYPAL_WEBHOOK_VERIFICATION_FAILED' });
  }
  if (!event?.id || !event?.event_type) return res.status(400).json({ success: false, code: 'PAYPAL_WEBHOOK_INVALID_EVENT' });
  const relevantUnknownPayment = /^PAYMENT\.CAPTURE\./u.test(event.event_type) && !PAYMENT_EVENTS.has(event.event_type);
  if (!SUPPORTED.has(event.event_type) && !relevantUnknownPayment) return res.json({ received: true, ignored: true });
  const claim = await claimEvent(event);
  const ledger = claim.ledger;
  if (!claim.claimed) {
    if (ledger?.status === 'processed') return res.json({ received: true, duplicate: true });
    if (ledger?.status === 'review_required') return res.json({ received: true, duplicate: true, reviewRequired: true });
    return res.status(409).json({ received: false, processing: true, retryable: true });
  }
  try {
    if (relevantUnknownPayment) {
      throw Object.assign(new Error('Unknown PayPal capture event'), { code: 'PAYPAL_PAYMENT_EVENT_UNKNOWN' });
    }
    if (PAYMENT_EVENTS.has(event.event_type)) {
      const captureId = String(event.resource?.id || '').trim();
      const orderId = String(event.resource?.supplementary_data?.related_ids?.order_id || '').trim();
      if (!captureId) throw Object.assign(new Error('Capture ID missing'), { code: 'PAYPAL_PAYMENT_CORRELATION_FAILED' });
      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        await PayPalPurchaseService.reconcileCaptureWebhook({ orderId, captureId, client: new PayPalClient() });
      } else {
        await PayPalPurchaseService.reconcileRefundOrReversal({ captureId, orderId, eventId: event.id,
          eventType: event.event_type, client: new PayPalClient() });
      }
      ledger.status = 'processed'; ledger.processedAt = new Date(); ledger.processingLeaseExpiresAt = null; await ledger.save();
      logger.info(`[PAYPAL] payment webhook processed eventId=${event.id} type=${event.event_type} captureId=${captureId}`);
      return res.json({ received: true });
    }
    const subscriptionId = String(event.resource?.id || '').trim();
    if (!subscriptionId) throw Object.assign(new Error('Subscription ID missing'), { code: 'PAYPAL_WEBHOOK_CORRELATION_FAILED' });
    const subscription = await new PayPalClient().getSubscription(subscriptionId);
    const synced = await syncSubscription(subscription, { eventType: event.event_type });
    ledger.status = 'processed'; ledger.processedAt = new Date(); ledger.processingLeaseExpiresAt = null; await ledger.save();
    logger.info(`[PAYPAL] webhook verified eventId=${event.id} type=${event.event_type}`);
    logger.info(`[PAYPAL] subscription synchronized subscriptionId=${subscriptionId} planKey=${synced.plan.slug} status=${synced.status}`);
    return res.json({ received: true });
  } catch (error) {
    const review = ['PAYPAL_WEBHOOK_UNKNOWN_PLAN', 'PAYPAL_WEBHOOK_CORRELATION_FAILED', 'PAYPAL_SUBSCRIPTION_PLAN_MISMATCH',
      'PAYPAL_PAYMENT_CORRELATION_FAILED', 'PAYPAL_PAYMENT_EVENT_UNKNOWN', 'PAYPAL_CAPTURE_CORRELATION_MISMATCH',
      'PAYPAL_CAPTURE_OWNERSHIP_CONFLICT', 'PAYPAL_PARTIAL_REFUND'].includes(error?.code);
    ledger.status = review ? 'review_required' : 'failed'; ledger.errorCode = error?.code || 'PAYPAL_WEBHOOK_PROCESSING_FAILED';
    ledger.processingLeaseExpiresAt = null; await ledger.save();
    logger.error(`[PAYPAL] webhook processing failed eventId=${event.id} type=${event.event_type} code=${ledger.errorCode}`);
    return res.status(review ? 202 : 500).json({ success: false, code: ledger.errorCode });
  }
}

module.exports = { PROCESSING_LEASE_MS, SUPPORTED, PAYMENT_EVENTS, claimEvent, paypalWebhook, verificationPayload };
