'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'paypal-phase2-test-secret';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
process.env.PAYPAL_PRODUCT_ID = 'PROD-SAFE';
process.env.PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID = 'P-ESSENTIAL-MONTHLY';
process.env.PAYPAL_WEBHOOK_ID = 'WH-SAFE';
process.env.PAYPAL_RETURN_URL = 'http://localhost:4200/billing/paypal/success';
process.env.PAYPAL_CANCEL_URL = 'http://localhost:4200/billing/paypal/cancel';

const paypalMock = { createSubscription: jest.fn(), getSubscription: jest.fn(), verifyWebhookSignature: jest.fn() };
jest.mock('../src/services/paypal/paypalClient.service', () => ({
  PayPalClient: jest.fn(() => paypalMock), PayPalApiError: class PayPalApiError extends Error {}
}));

const request = require('supertest');
const app = require('../src/app');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const PaymentCheckoutAttempt = require('../src/models/PaymentCheckoutAttempt');
const PaymentProviderEvent = require('../src/models/PaymentProviderEvent');
const CreditWallet = require('../src/models/CreditWallet');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const SECOND_ATTEMPT = '00000000-0000-4000-8000-000000000002';
const THIRD_ATTEMPT = '00000000-0000-4000-8000-000000000003';
const SUBSCRIPTION = 'I-PAYPAL-SAFE';
let teacher; let free; let essential;
const auth = () => ({ Authorization: `Bearer ${signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' })}` });

function subscription(status = 'ACTIVE', planId = 'P-ESSENTIAL-MONTHLY') {
  return { id: SUBSCRIPTION, plan_id: planId, custom_id: ATTEMPT, status,
    start_time: '2026-08-31T00:00:00Z', billing_info: { next_billing_time: '2026-09-30T00:00:00Z' } };
}
function event(id, type) { return { id, event_type: type, resource: { id: SUBSCRIPTION, plan_id: 'P-ESSENTIAL-MONTHLY' } }; }
function webhookHeaders() { return { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tx-safe', 'paypal-transmission-sig': 'sig-safe', 'paypal-transmission-time': '2026-08-31T00:00:00Z' }; }
async function createAttempt(checkoutAttemptId = ATTEMPT) {
  return request(app).post('/api/subscription/paypal/create').set(auth()).send({ planCode: 'essential_monthly', checkoutAttemptId });
}
async function sendWebhook(payload) { return request(app).post('/api/webhooks/paypal').set(webhookHeaders()).set('Content-Type', 'application/json').send(payload); }

describe('PayPal Sandbox subscription Phase 2', () => {
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase(); jest.clearAllMocks();
    free = await Plan.create({ name: 'Free', slug: 'free', price: 0, currency: 'USD', billingInterval: 'month', isActive: true,
      features: { essayAnalysesPerMonth: 25 } });
    essential = await Plan.create({ name: 'Essential Monthly', slug: 'essential_monthly', price: 9.99, currency: 'USD',
      billingInterval: 'month', isActive: true, features: { essayAnalysesPerMonth: 300 } });
    teacher = await User.create({ firebaseUid: `teacher-${Date.now()}`, email: `teacher-${Date.now()}@example.com`, role: 'teacher', plan: free._id });
    paypalMock.createSubscription.mockResolvedValue({ id: SUBSCRIPTION, status: 'APPROVAL_PENDING', links: [
      { rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=SAFE' }
    ] });
    paypalMock.verifyWebhookSignature.mockResolvedValue({ verification_status: 'SUCCESS' });
    paypalMock.getSubscription.mockResolvedValue(subscription());
  });

  test('authenticated teacher creates a trusted subscription and receives only safe approval data', async () => {
    const res = await createAttempt(); expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ subscriptionId: SUBSCRIPTION,
      approvalUrl: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=SAFE', status: 'approval_pending' });
    expect(paypalMock.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'P-ESSENTIAL-MONTHLY', custom_id: ATTEMPT }), ATTEMPT);
    expect(JSON.stringify(res.body)).not.toContain('sandbox-secret');
  });

  test('arbitrary financial fields and frontend Plan IDs are rejected', async () => {
    const res = await request(app).post('/api/subscription/paypal/create').set(auth()).send({ planCode: 'essential_monthly',
      checkoutAttemptId: ATTEMPT, planId: 'P-ATTACK', price: 0, credits: 9999 });
    expect(res.status).toBe(400); expect(paypalMock.createSubscription).not.toHaveBeenCalled();
  });

  test('same checkout attempt is idempotent and creates one provider subscription', async () => {
    expect((await createAttempt()).status).toBe(200); expect((await createAttempt()).status).toBe(200);
    expect(paypalMock.createSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentCheckoutAttempt.countDocuments()).toBe(1);
  });

  test('abandoned pending checkout remains Free and retries reuse its approval flow without duplicate activation or credits', async () => {
    teacher.usage.submissions = 7; await teacher.save();
    expect((await createAttempt()).status).toBe(200);
    paypalMock.getSubscription.mockResolvedValue(subscription('APPROVAL_PENDING'));
    expect((await sendWebhook(event('WH-PENDING', 'BILLING.SUBSCRIPTION.CREATED'))).status).toBe(200);

    let current = await User.findById(teacher._id);
    expect(String(current.plan)).toBe(String(free._id));
    expect(current.paypalSubscriptionStatus).toBe('APPROVAL_PENDING');
    expect(current.usage.submissions).toBe(7);
    expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(0);
    const beforeRetry = await request(app).get('/api/subscription/me').set(auth());
    expect(beforeRetry.body.data.plan.slug).toBe('free');
    expect(beforeRetry.body.data.billing.canManageSubscription).toBe(false);

    const retry = await createAttempt(SECOND_ATTEMPT);
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ subscriptionId: SUBSCRIPTION, status: 'approval_pending' });
    expect(retry.body.data.approvalUrl).toContain('sandbox.paypal.com');
    const refresh = await createAttempt(THIRD_ATTEMPT);
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.subscriptionId).toBe(SUBSCRIPTION);
    expect(paypalMock.createSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentCheckoutAttempt.countDocuments()).toBe(1);

    current = await User.findById(teacher._id);
    expect(String(current.plan)).toBe(String(free._id));
    expect(current.usage.submissions).toBe(7);
    expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(0);
  });

  test.each(['APPROVAL_REQUIRED', 'APPROVED', 'CREATED'])(
    '%s provider state is recoverable and is not reported as an active subscription', async (providerStatus) => {
      expect((await createAttempt()).status).toBe(200);
      teacher.paypalSubscriptionId = SUBSCRIPTION;
      teacher.paypalPlanId = 'P-ESSENTIAL-MONTHLY';
      teacher.paypalSubscriptionStatus = providerStatus;
      await teacher.save();
      paypalMock.getSubscription.mockResolvedValue(subscription(providerStatus));

      const retry = await createAttempt(SECOND_ATTEMPT);
      expect(retry.status).toBe(200);
      expect(retry.body.data.subscriptionId).toBe(SUBSCRIPTION);
      expect(paypalMock.createSubscription).toHaveBeenCalledTimes(1);
      expect(String((await User.findById(teacher._id)).plan)).toBe(String(free._id));
    });

  test.each(['CANCELLED', 'EXPIRED', 'FAILED'])(
    '%s abandoned checkout is retired and a new approval checkout can be created', async (providerStatus) => {
      expect((await createAttempt()).status).toBe(200);
      teacher.paypalSubscriptionId = SUBSCRIPTION;
      teacher.paypalPlanId = 'P-ESSENTIAL-MONTHLY';
      teacher.paypalSubscriptionStatus = 'APPROVAL_PENDING';
      await teacher.save();
      paypalMock.getSubscription.mockResolvedValue(subscription(providerStatus));
      paypalMock.createSubscription.mockResolvedValueOnce({ id: `I-RETRY-${providerStatus}`, status: 'APPROVAL_PENDING', links: [
        { rel: 'approve', method: 'GET', href: `https://www.sandbox.paypal.com/approve?state=${providerStatus}` }
      ] });

      const retry = await createAttempt(SECOND_ATTEMPT);
      expect(retry.status).toBe(200);
      expect(retry.body.data.subscriptionId).toBe(`I-RETRY-${providerStatus}`);
      expect(paypalMock.createSubscription).toHaveBeenCalledTimes(2);
      expect(await PaymentCheckoutAttempt.countDocuments()).toBe(2);
      expect(String((await User.findById(teacher._id)).plan)).toBe(String(free._id));
      expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(0);
    });

  test('provider-confirmed missing pending subscription is retired before safe recreation', async () => {
    expect((await createAttempt()).status).toBe(200);
    teacher.paypalSubscriptionId = SUBSCRIPTION;
    teacher.paypalPlanId = 'P-ESSENTIAL-MONTHLY';
    teacher.paypalSubscriptionStatus = 'APPROVAL_PENDING';
    await teacher.save();
    paypalMock.getSubscription.mockRejectedValue(Object.assign(new Error('not found'), { providerStatus: 404 }));
    paypalMock.createSubscription.mockResolvedValueOnce({ id: 'I-RETRY-NOT-FOUND', status: 'APPROVAL_PENDING', links: [
      { rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?state=recreated' }
    ] });

    const retry = await createAttempt(SECOND_ATTEMPT);
    expect(retry.status).toBe(200);
    expect(retry.body.data.subscriptionId).toBe('I-RETRY-NOT-FOUND');
    expect(paypalMock.createSubscription).toHaveBeenCalledTimes(2);
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(free._id));
  });

  test('free/custom plans cannot create a PayPal subscription', async () => {
    const res = await request(app).post('/api/subscription/paypal/create').set(auth()).send({ planCode: 'free', checkoutAttemptId: ATTEMPT });
    expect(res.status).toBe(400); expect(res.body.code).toBe('PLAN_NOT_PURCHASABLE');
  });

  test('active Stripe or PayPal state blocks a parallel subscription', async () => {
    teacher.stripeSubscriptionStatus = 'active'; await teacher.save();
    expect((await createAttempt()).status).toBe(409);
    teacher.stripeSubscriptionStatus = null; teacher.paypalSubscriptionStatus = 'ACTIVE'; await teacher.save();
    const activePayPal = await createAttempt();
    expect(activePayPal.status).toBe(409); expect(activePayPal.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(paypalMock.createSubscription).not.toHaveBeenCalled();
  });

  test('suspended PayPal state preserves management behavior without claiming it is active', async () => {
    teacher.paypalSubscriptionStatus = 'SUSPENDED'; await teacher.save();
    const res = await createAttempt();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUBSCRIPTION_REQUIRES_MANAGEMENT');
    expect(paypalMock.createSubscription).not.toHaveBeenCalled();
  });

  test('redirect/create response never grants the paid plan', async () => {
    await createAttempt(); const current = await User.findById(teacher._id);
    expect(String(current.plan)).toBe(String(free._id)); expect(current.paypalSubscriptionStatus).toBeNull();
  });

  test('webhook verification failure mutates nothing', async () => {
    await createAttempt(); paypalMock.verifyWebhookSignature.mockResolvedValue({ verification_status: 'FAILURE' });
    const res = await sendWebhook(event('WH-FAIL', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(400); expect(paypalMock.getSubscription).not.toHaveBeenCalled();
    expect(await PaymentProviderEvent.countDocuments()).toBe(0);
  });

  test('verified ACTIVATED fetches current subscription, maps Plan, activates once, and initializes credits', async () => {
    await createAttempt(); const res = await sendWebhook(event('WH-ACTIVE', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(200); expect(paypalMock.getSubscription).toHaveBeenCalledWith(SUBSCRIPTION);
    const current = await User.findById(teacher._id); expect(String(current.plan)).toBe(String(essential._id));
    expect(current.paypalSubscriptionStatus).toBe('ACTIVE');
    expect(await CreditWallet.findOne({ userId: teacher._id })).toMatchObject({ monthlyCredits: 300, monthlyCreditsUsed: 0 });
    const duplicate = await sendWebhook(event('WH-ACTIVE', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(duplicate.body.duplicate).toBe(true); expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(1);
  });

  test('expired processing lease is atomically reclaimed and completed after a crash', async () => {
    await createAttempt();
    await PaymentProviderEvent.create({ provider: 'paypal', providerEventId: 'WH-STALE',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: SUBSCRIPTION, status: 'processing',
      processingStartedAt: new Date(Date.now() - 240000), processingLeaseExpiresAt: new Date(Date.now() - 120000),
      processingAttemptCount: 1 });
    const res = await sendWebhook(event('WH-STALE', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(200); expect(paypalMock.getSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentProviderEvent.findOne({ providerEventId: 'WH-STALE' })).toMatchObject({
      status: 'processed', processingAttemptCount: 2
    });
  });

  test('fresh processing lease rejects concurrent processing without acknowledging completion', async () => {
    await PaymentProviderEvent.create({ provider: 'paypal', providerEventId: 'WH-FRESH',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: SUBSCRIPTION, status: 'processing',
      processingStartedAt: new Date(), processingLeaseExpiresAt: new Date(Date.now() + 120000), processingAttemptCount: 1 });
    const res = await sendWebhook(event('WH-FRESH', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(409); expect(res.body).toMatchObject({ received: false, processing: true, retryable: true });
    expect(paypalMock.getSubscription).not.toHaveBeenCalled();
  });

  test('processed duplicate is acknowledged without subscription fetch or sync', async () => {
    await PaymentProviderEvent.create({ provider: 'paypal', providerEventId: 'WH-DONE',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: SUBSCRIPTION, status: 'processed', processedAt: new Date() });
    const res = await sendWebhook(event('WH-DONE', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(200); expect(res.body.duplicate).toBe(true);
    expect(paypalMock.getSubscription).not.toHaveBeenCalled();
  });

  test('failed event is atomically reclaimed and retried', async () => {
    await createAttempt();
    await PaymentProviderEvent.create({ provider: 'paypal', providerEventId: 'WH-RETRY',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', resourceId: SUBSCRIPTION, status: 'failed',
      errorCode: 'PAYPAL_WEBHOOK_PROCESSING_FAILED', processingAttemptCount: 1 });
    const res = await sendWebhook(event('WH-RETRY', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(200); expect(paypalMock.getSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentProviderEvent.findOne({ providerEventId: 'WH-RETRY' })).toMatchObject({
      status: 'processed', processingAttemptCount: 2
    });
  });

  test('unknown Plan ID is stored for review and grants nothing', async () => {
    await createAttempt(); paypalMock.getSubscription.mockResolvedValue(subscription('ACTIVE', 'P-UNKNOWN'));
    const res = await sendWebhook(event('WH-UNKNOWN', 'BILLING.SUBSCRIPTION.ACTIVATED'));
    expect(res.status).toBe(202); expect((await PaymentProviderEvent.findOne({ providerEventId: 'WH-UNKNOWN' })).status).toBe('review_required');
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(free._id));
  });

  test.each([['CANCELLED', 'BILLING.SUBSCRIPTION.CANCELLED'], ['SUSPENDED', 'BILLING.SUBSCRIPTION.SUSPENDED'], ['EXPIRED', 'BILLING.SUBSCRIPTION.EXPIRED']])(
    '%s synchronizes back to Free without deleting wallet history', async (status, type) => {
      await createAttempt(); paypalMock.getSubscription.mockResolvedValue(subscription('ACTIVE'));
      await sendWebhook(event(`WH-${status}-A`, 'BILLING.SUBSCRIPTION.ACTIVATED'));
      const failedAt = new Date('2026-08-30T12:00:00Z');
      await User.updateOne({ _id: teacher._id }, { $set: {
        paypalLastPaymentFailedAt: failedAt, paypalPaymentIssueActive: true
      } });
      paypalMock.getSubscription.mockResolvedValue(subscription(status)); await sendWebhook(event(`WH-${status}-B`, type));
      const current = await User.findById(teacher._id); expect(String(current.plan)).toBe(String(free._id));
      expect(current.paypalSubscriptionStatus).toBe(status); expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(1);
      expect(current.paypalLastPaymentFailedAt).toEqual(failedAt);
      expect(current.paypalPaymentIssueActive).toBe(status === 'SUSPENDED');
    });

  test('PAYMENT.FAILED records history/current issue and later authoritative ACTIVE recovery clears only current issue', async () => {
    await createAttempt(); paypalMock.getSubscription.mockResolvedValue(subscription('SUSPENDED'));
    await sendWebhook(event('WH-PAYMENT-FAILED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'));
    let current = await User.findById(teacher._id);
    expect(current.paypalLastPaymentFailedAt).toBeTruthy(); expect(current.paypalPaymentIssueActive).toBe(true);
    expect((await request(app).get('/api/subscription/me').set(auth())).body.data.billing.paymentIssue).toBe(true);

    paypalMock.getSubscription.mockResolvedValue(subscription('ACTIVE'));
    await sendWebhook(event('WH-PAYMENT-RECOVERED', 'BILLING.SUBSCRIPTION.UPDATED'));
    current = await User.findById(teacher._id);
    expect(String(current.plan)).toBe(String(essential._id)); expect(current.paypalSubscriptionStatus).toBe('ACTIVE');
    expect(current.paypalPaymentIssueActive).toBe(false); expect(current.paypalLastPaymentFailedAt).toBeTruthy();
    expect((await request(app).get('/api/subscription/me').set(auth())).body.data.billing.paymentIssue).toBe(false);
  });
});
