'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'paypal-management-test-secret';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
process.env.PAYPAL_PRODUCT_ID = 'PROD-SAFE';
process.env.PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID = 'P-ESSENTIAL-MONTHLY';
process.env.PAYPAL_PRO_MONTHLY_PLAN_ID = 'P-PRO-MONTHLY';
process.env.PAYPAL_WEBHOOK_ID = 'WH-SAFE';
process.env.PAYPAL_CHANGE_PLAN_RETURN_URL = 'http://localhost:4200/billing/paypal/change-plan/success';
process.env.PAYPAL_CHANGE_PLAN_CANCEL_URL = 'http://localhost:4200/billing/paypal/change-plan/cancel';
process.env.GOOGLE_CLOUD_KEY_FILE = process.env.TEMP + '\\mock-vision-key.json';

const paypalMock = { getSubscription: jest.fn(), getPlan: jest.fn(), cancelSubscription: jest.fn(),
  reviseSubscription: jest.fn(), verifyWebhookSignature: jest.fn() };
jest.mock('../src/services/paypal/paypalClient.service', () => ({
  PayPalClient: jest.fn(() => paypalMock), PayPalApiError: class PayPalApiError extends Error {}
}));

const request = require('supertest');
const app = require('../src/app');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const PaymentManagementAttempt = require('../src/models/PaymentManagementAttempt');
const PaymentProviderEvent = require('../src/models/PaymentProviderEvent');
const CreditService = require('../src/services/credit.service');
const CreditTransaction = require('../src/models/CreditTransaction');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const SUBSCRIPTION = 'I-PAYPAL-MANAGE';
const CHANGE_ATTEMPT = '00000000-0000-4000-8000-000000000031';
const CHANGE_ATTEMPT_B = '00000000-0000-4000-8000-000000000032';
let teacher; let free; let essential; let pro;
const auth = (user = teacher) => ({ Authorization: `Bearer ${signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role })}` });
const providerSubscription = (status = 'ACTIVE', planId = 'P-ESSENTIAL-MONTHLY') => ({ id: SUBSCRIPTION,
  plan_id: planId, status, start_time: '2026-08-01T00:00:00Z', billing_info: { next_billing_time: '2026-09-01T00:00:00Z' } });
const headers = () => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tx-manage', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-08-31T00:00:00Z' });
async function webhook(id, type) { return request(app).post('/api/webhooks/paypal').set(headers()).set('Content-Type', 'application/json')
  .send({ id, event_type: type, resource: { id: SUBSCRIPTION } }); }

describe('PayPal subscription management Phase 3', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await PaymentManagementAttempt.init(); }); afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase(); jest.clearAllMocks();
    free = await Plan.create({ name: 'Free', slug: 'free', price: 0, currency: 'USD', billingInterval: 'month', isActive: true,
      features: { essayAnalysesPerMonth: 25 } });
    essential = await Plan.create({ name: 'Essential Monthly', slug: 'essential_monthly', price: 9.99, currency: 'USD',
      billingInterval: 'month', isActive: true, features: { essayAnalysesPerMonth: 300 } });
    pro = await Plan.create({ name: 'Pro Monthly', slug: 'pro_monthly', price: 19.99, currency: 'USD',
      billingInterval: 'month', isActive: true, features: { essayAnalysesPerMonth: 500 } });
    teacher = await User.create({ firebaseUid: `teacher-${Date.now()}`, email: `teacher-${Date.now()}@example.com`, role: 'teacher',
      plan: essential._id, paypalSubscriptionId: SUBSCRIPTION, paypalPlanId: 'P-ESSENTIAL-MONTHLY', paypalSubscriptionStatus: 'ACTIVE',
      paypalCurrentPeriodStart: new Date('2026-08-01T00:00:00Z'), paypalCurrentPeriodEnd: new Date('2026-09-01T00:00:00Z') });
    paypalMock.getSubscription.mockResolvedValue(providerSubscription());
    paypalMock.getPlan.mockImplementation(async (id) => ({ id, product_id: 'PROD-SAFE', status: 'ACTIVE' }));
    paypalMock.cancelSubscription.mockResolvedValue(null);
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/agreements/approve?token=SAFE' }] });
    paypalMock.verifyWebhookSignature.mockResolvedValue({ verification_status: 'SUCCESS' });
  });

  test('cancel uses only the authenticated user provider ID and does not downgrade before webhook', async () => {
    const res = await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({});
    expect(res.status).toBe(200); expect(res.body.data.pending).toBe(true);
    expect(paypalMock.cancelSubscription).toHaveBeenCalledWith(SUBSCRIPTION,
      'Cancelled by subscriber from CoMarker account settings.', expect.stringMatching(/^cancel-/));
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(essential._id));
  });

  test('cancel is idempotent while pending and rejects frontend subscription IDs', async () => {
    expect((await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({})).status).toBe(200);
    expect((await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({})).status).toBe(200);
    expect(paypalMock.cancelSubscription).toHaveBeenCalledTimes(1);
    expect((await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({ subscriptionId: 'I-OTHER' })).status).toBe(400);
  });

  test('Stripe and Free users cannot use PayPal management routes', async () => {
    const stripe = await User.create({ firebaseUid: 'stripe-teacher', email: 'stripe@example.com', role: 'teacher', plan: essential._id,
      stripeCustomerId: 'cus_safe', stripeSubscriptionId: 'sub_safe', stripeSubscriptionStatus: 'active' });
    const freeUser = await User.create({ firebaseUid: 'free-teacher', email: 'free@example.com', role: 'teacher', plan: free._id });
    expect((await request(app).post('/api/subscription/paypal/cancel').set(auth(stripe)).send({})).body.code).toBe('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE');
    expect((await request(app).post('/api/subscription/paypal/change-plan').set(auth(freeUser)).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT })).body.code)
      .toBe('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE');
  });

  test('change-plan resolves a trusted target, validates product, sends stable request ID, and waits for authority', async () => {
    const res = await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(res.status).toBe(200); expect(res.body.data).toMatchObject({ requiresApproval: true, targetPlanCode: 'pro_monthly', status: 'approval_pending' });
    expect(paypalMock.reviseSubscription).toHaveBeenCalledWith(SUBSCRIPTION, expect.objectContaining({ plan_id: 'P-PRO-MONTHLY',
      application_context: expect.objectContaining({ return_url: expect.stringContaining(`attempt=${CHANGE_ATTEMPT}`) }) }), `revise-${CHANGE_ATTEMPT}`);
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(essential._id));
    expect((await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT })).status).toBe(200);
    expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ targetPlanCode: 'essential_monthly', changeAttemptId: CHANGE_ATTEMPT }, 'PAYPAL_PLAN_CHANGE_SAME_PLAN'],
    [{ targetPlanCode: 'missing_monthly', changeAttemptId: CHANGE_ATTEMPT }, 'PAYPAL_PLAN_CHANGE_TARGET_INVALID']
  ])('rejects invalid target %#', async (body, code) => {
    const res = await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send(body);
    expect(res.body.code).toBe(code); expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
  });

  test('rejects arbitrary provider plan input and cross-product revision', async () => {
    expect((await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly',
      targetPayPalPlanId: 'P-ATTACK', changeAttemptId: CHANGE_ATTEMPT })).status).toBe(400);
    paypalMock.getPlan.mockImplementation(async (id) => ({ id, product_id: id === 'P-PRO-MONTHLY' ? 'PROD-OTHER' : 'PROD-SAFE' }));
    const res = await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(res.body.code).toBe('PAYPAL_PLAN_CHANGE_UNSUPPORTED');
  });

  test('verified UPDATED fetch-back applies the new plan and allowance exactly once', async () => {
    await CreditService.getOrCreateWallet(teacher._id);
    await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('ACTIVE', 'P-PRO-MONTHLY'));
    expect((await webhook('WH-UPDATED', 'BILLING.SUBSCRIPTION.UPDATED')).status).toBe(200);
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(pro._id));
    expect((await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT })).status).toBe('completed');
    expect(await CreditTransaction.countDocuments({ userId: teacher._id, type: 'PLAN_ALLOWANCE_CHANGE' })).toBe(1);
    expect((await webhook('WH-UPDATED', 'BILLING.SUBSCRIPTION.UPDATED')).body.duplicate).toBe(true);
    expect(await CreditTransaction.countDocuments({ userId: teacher._id, type: 'PLAN_ALLOWANCE_CHANGE' })).toBe(1);
  });

  test('verified CANCELLED fetch-back applies Free exactly once and clears payment issue', async () => {
    await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({});
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    await User.updateOne({ _id: teacher._id }, { paypalPaymentIssueActive: true });
    expect((await webhook('WH-CANCELLED', 'BILLING.SUBSCRIPTION.CANCELLED')).status).toBe(200);
    const current = await User.findById(teacher._id);
    expect(String(current.plan)).toBe(String(free._id)); expect(current.paypalPaymentIssueActive).toBe(false);
    expect((await PaymentManagementAttempt.findOne({ operation: 'CANCEL' })).status).toBe('completed');
    expect((await webhook('WH-CANCELLED', 'BILLING.SUBSCRIPTION.CANCELLED')).body.duplicate).toBe(true);
    expect(await PaymentProviderEvent.countDocuments({ providerEventId: 'WH-CANCELLED' })).toBe(1);
  });

  test('cancelled approval closes only the matching authenticated attempt and preserves plan', async () => {
    await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    const res = await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    expect(res.body.data.status).toBe('cancelled');
    expect(String((await User.findById(teacher._id)).plan)).toBe(String(essential._id));
  });

  test('GET me exposes safe provider capabilities and pending target without provider Plan ID', async () => {
    await request(app).post('/api/subscription/paypal/change-plan').set(auth()).send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    const data = (await request(app).get('/api/subscription/me').set(auth())).body.data;
    expect(data.billing).toMatchObject({ provider: 'paypal', canCancel: true, canChangePlan: true,
      planCode: 'essential_monthly', pendingPlanChange: true, pendingTargetPlanCode: 'pro_monthly' });
    expect(JSON.stringify(data.billing)).not.toContain('P-PRO-MONTHLY');
  });

  test('simultaneous cancellation requests atomically produce one owner and one PayPal call', async () => {
    let release; paypalMock.cancelSubscription.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = request(app).post('/api/subscription/paypal/cancel').set(auth()).send({}).then((value) => value);
    const second = request(app).post('/api/subscription/paypal/cancel').set(auth()).send({}).then((value) => value);
    for (let count = 0; !release && count < 100; count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(typeof release).toBe('function'); release(null);
    const responses = await Promise.all([first, second]);
    expect(responses.every((item) => item.status === 200)).toBe(true);
    expect(paypalMock.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentManagementAttempt.countDocuments({ operation: 'CANCEL' })).toBe(1);
    expect(await PaymentManagementAttempt.countDocuments({ activeOperationKey: `paypal:${SUBSCRIPTION}` })).toBe(1);
  });

  test('simultaneous change requests with different UUIDs atomically issue one revise call', async () => {
    let release; paypalMock.reviseSubscription.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT }).then((value) => value);
    const second = request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT_B }).then((value) => value);
    for (let count = 0; !release && count < 100; count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(typeof release).toBe('function');
    release({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=RACE' }] });
    const responses = await Promise.all([first, second]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentManagementAttempt.countDocuments({ operation: 'CHANGE_PLAN' })).toBe(1);
  });

  test('same attempt in provider_pending or completed returns idempotently without replay', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [] });
    let response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.body.data.status).toBe('provider_pending');
    response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.body.data.status).toBe('provider_pending');
    expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
    await PaymentManagementAttempt.updateOne({ attemptId: CHANGE_ATTEMPT }, {
      $set: { status: 'completed', completedAt: new Date() }, $unset: { activeOperationKey: 1 }
    });
    response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.body.data.status).toBe('completed');
    expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
  });

  test('same cancelled attempt cannot silently restart', async () => {
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    const response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(409); expect(response.body.code).toBe('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT');
    expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
  });

  test('retryable failed plan change reuses the exact provider request ID', async () => {
    paypalMock.reviseSubscription.mockRejectedValueOnce(Object.assign(new Error('network'), { providerStatus: 500 }));
    let response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(502);
    expect(await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT })).toMatchObject({ status: 'failed', failureClass: 'retryable' });
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=RETRY' }] });
    response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(200);
    const ids = paypalMock.reviseSubscription.mock.calls.map((call) => call[2]);
    expect(ids).toEqual([`revise-${CHANGE_ATTEMPT}`, `revise-${CHANGE_ATTEMPT}`]);
    expect((await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT })).retryCount).toBe(1);
  });

  test('retryable failed cancellation is reclaimed with its original provider request ID', async () => {
    paypalMock.cancelSubscription.mockRejectedValueOnce(Object.assign(new Error('network'), { providerStatus: 500 }));
    let response = await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({});
    expect(response.status).toBe(502);
    const failed = await PaymentManagementAttempt.findOne({ operation: 'CANCEL' });
    expect(failed).toMatchObject({ status: 'failed', failureClass: 'retryable' });
    paypalMock.cancelSubscription.mockResolvedValue(null);
    response = await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(paypalMock.cancelSubscription.mock.calls.map((call) => call[2]))
      .toEqual([failed.providerRequestId, failed.providerRequestId]);
    expect((await PaymentManagementAttempt.findById(failed._id)).retryCount).toBe(1);
  });

  test('permanent provider failure is recorded and never retried', async () => {
    paypalMock.reviseSubscription.mockRejectedValue(Object.assign(new Error('unsupported'), { providerStatus: 422 }));
    let response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.body.code).toBe('PAYPAL_PLAN_CHANGE_UNSUPPORTED');
    response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(409); expect(paypalMock.reviseSubscription).toHaveBeenCalledTimes(1);
    expect(await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT })).toMatchObject({ status: 'failed', failureClass: 'permanent' });
  });

  test('provider success plus local persistence failure recovers by replaying the same identity after lease expiry', async () => {
    const realUpdate = PaymentManagementAttempt.findOneAndUpdate.bind(PaymentManagementAttempt);
    const persistence = jest.spyOn(PaymentManagementAttempt, 'findOneAndUpdate').mockRejectedValueOnce(new Error('local write failed'));
    let response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(503); persistence.mockRestore();
    let attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('processing'); expect(attempt.activeOperationKey).toBe(`paypal:${SUBSCRIPTION}`);
    await PaymentManagementAttempt.updateOne({ _id: attempt._id }, { $set: { processingLeaseExpiresAt: new Date(Date.now() - 1000) } });
    response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(200);
    expect(paypalMock.reviseSubscription.mock.calls.map((call) => call[2]))
      .toEqual([`revise-${CHANGE_ATTEMPT}`, `revise-${CHANGE_ATTEMPT}`]);
    attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('approval_pending'); expect(attempt.retryCount).toBe(1);
    expect(realUpdate).toBeDefined();
  });

  test('stale processing owner is recovered with its original request ID', async () => {
    await PaymentManagementAttempt.create({ provider: 'paypal', attemptId: CHANGE_ATTEMPT, userId: teacher._id,
      providerSubscriptionId: SUBSCRIPTION, operation: 'CHANGE_PLAN', sourcePlanKey: 'essential_monthly',
      sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY', targetPlanKey: 'pro_monthly', targetProviderPlanId: 'P-PRO-MONTHLY',
      providerRequestId: `revise-${CHANGE_ATTEMPT}`, status: 'processing', activeOperationKey: `paypal:${SUBSCRIPTION}`,
      processingLeaseExpiresAt: new Date(Date.now() - 1000) });
    const response = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    expect(response.status).toBe(200);
    expect(paypalMock.reviseSubscription).toHaveBeenCalledWith(SUBSCRIPTION, expect.any(Object), `revise-${CHANGE_ATTEMPT}`);
    expect((await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT })).retryCount).toBe(1);
  });

  test('webhook completion releases atomic operation ownership', async () => {
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('ACTIVE', 'P-PRO-MONTHLY'));
    expect((await webhook('WH-RELEASE', 'BILLING.SUBSCRIPTION.UPDATED')).status).toBe(200);
    const attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('completed'); expect(attempt.activeOperationKey).toBeUndefined();
  });

  test('reconcile-management rejects browser-supplied subscription ID', async () => {
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth())
      .send({ subscriptionId: SUBSCRIPTION });
    expect(response.status).toBe(400);
  });

  test('reconcile-management rejects browser-supplied providerSubscriptionId', async () => {
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth())
      .send({ providerSubscriptionId: SUBSCRIPTION });
    expect(response.status).toBe(400);
  });

  test('reconcile-management rejects browser-supplied userId', async () => {
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth())
      .send({ userId: teacher._id.toString() });
    expect(response.status).toBe(400);
  });

  test('reconcile-management rejects browser-supplied status', async () => {
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth())
      .send({ status: 'CANCELLED' });
    expect(response.status).toBe(400);
  });

  test('reconcile-management fetches authoritative provider state and returns terminal status', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('CANCELLED');
    expect(response.body.data.cancelledOrTerminal).toBe(true);
    expect(paypalMock.getSubscription).toHaveBeenCalledWith(SUBSCRIPTION);
  });

  test('reconcile-management returns pendingCancellation when provider is SUSPENDED', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('SUSPENDED'));
    await User.findByIdAndUpdate(teacher._id, { paypalSubscriptionStatus: 'SUSPENDED' });
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.pendingCancellation).toBe(true);
  });

  test('cancelled plan change becomes terminal and clears metadata', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=CANCEL-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    const attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('approval_pending');
    expect(attempt.approvalUrl).toBe('https://www.sandbox.paypal.com/approve?token=CANCEL-TEST');
    expect(attempt.activeOperationKey).toBe(`paypal:${SUBSCRIPTION}`);

    const cancelRes = await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');

    const cancelledAttempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(cancelledAttempt.status).toBe('cancelled');
    expect(cancelledAttempt.cancelledAt).toBeDefined();
    expect(cancelledAttempt.approvalUrl).toBeNull();
    expect(cancelledAttempt.activeOperationKey).toBeUndefined();
    expect(cancelledAttempt.processingLeaseExpiresAt).toBeNull();
  });

  test('cancelled attempt excluded from active-operation query', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=ACTIVE-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });

    const { findActive } = require('../src/services/paypal/paypalSubscriptionManagement.service');
    const activeAttempt = await findActive(SUBSCRIPTION);
    expect(activeAttempt).toBeNull();
  });

  test('subscription me returns no pending plan change after cancellation', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=ME-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    let data = (await request(app).get('/api/subscription/me').set(auth())).body.data;
    expect(data.billing.pendingPlanChange).toBe(true);
    expect(data.billing.pendingTargetPlanCode).toBe('pro_monthly');
    expect(data.billing.pendingChangeAttemptId).toBe(CHANGE_ATTEMPT);
    expect(data.billing.pendingChangeApprovalUrl).toBe('https://www.sandbox.paypal.com/approve?token=ME-TEST');

    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });

    data = (await request(app).get('/api/subscription/me').set(auth())).body.data;
    expect(data.billing.pendingPlanChange).toBe(false);
    expect(data.billing.pendingTargetPlanCode).toBeNull();
    expect(data.billing.pendingChangeAttemptId).toBeNull();
    expect(data.billing.pendingChangeApprovalUrl).toBeNull();
  });

  test('cancelled attempt does not block subscription cancellation', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=BLOCK-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });

    paypalMock.cancelSubscription.mockResolvedValue(null);
    const cancelRes = await request(app).post('/api/subscription/paypal/cancel').set(auth()).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.pending).toBe(true);
  });

  test('cancelled attempt does not block starting another plan change', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=CHANGE-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });

    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=NEW-CHANGE' }] });
    const newChangeRes = await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT_B });
    expect(newChangeRes.status).toBe(200);
    expect(newChangeRes.body.data.status).toBe('approval_pending');
  });

  test('duplicate cancellation is idempotent', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=IDEMP-TEST' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    const firstCancel = await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    expect(firstCancel.status).toBe(200);
    expect(firstCancel.body.data.status).toBe('cancelled');

    const secondCancel = await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    expect(secondCancel.status).toBe(200);
    expect(secondCancel.body.data.status).toBe('cancelled');

    const attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('cancelled');
  });

  test('cancelled processing attempt becomes terminal', async () => {
    await PaymentManagementAttempt.create({ provider: 'paypal', attemptId: CHANGE_ATTEMPT, userId: teacher._id,
      providerSubscriptionId: SUBSCRIPTION, operation: 'CHANGE_PLAN', sourcePlanKey: 'essential_monthly',
      sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY', targetPlanKey: 'pro_monthly', targetProviderPlanId: 'P-PRO-MONTHLY',
      providerRequestId: `revise-${CHANGE_ATTEMPT}`, status: 'processing', activeOperationKey: `paypal:${SUBSCRIPTION}`,
      processingLeaseExpiresAt: new Date(Date.now() + 10000) });

    const cancelRes = await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');

    const attempt = await PaymentManagementAttempt.findOne({ attemptId: CHANGE_ATTEMPT });
    expect(attempt.status).toBe('cancelled');
    expect(attempt.activeOperationKey).toBeUndefined();
  });

  test('historical cancelled plus newer active exposes only active', async () => {
    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=HIST-1' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT });

    await request(app).post('/api/subscription/paypal/change-plan/cancelled').set(auth()).send({ changeAttemptId: CHANGE_ATTEMPT });

    paypalMock.reviseSubscription.mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve?token=HIST-2' }] });
    await request(app).post('/api/subscription/paypal/change-plan').set(auth())
      .send({ targetPlanCode: 'pro_monthly', changeAttemptId: CHANGE_ATTEMPT_B });

    const data = (await request(app).get('/api/subscription/me').set(auth())).body.data;
    expect(data.billing.pendingPlanChange).toBe(true);
    expect(data.billing.pendingChangeAttemptId).toBe(CHANGE_ATTEMPT_B);
    expect(data.billing.pendingTargetPlanCode).toBe('pro_monthly');
  });

  test('reconcile-management is idempotent when webhook already updated state', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    const response2 = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response2.status).toBe(200);
    expect(response2.body.data.cancelledOrTerminal).toBe(true);
    expect(paypalMock.getSubscription).toHaveBeenCalledTimes(2);
  });

  test('ACTIVE subscription reconcile returns 200 with correct state', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('ACTIVE'));
    await User.findByIdAndUpdate(teacher._id, { paypalSubscriptionStatus: 'ACTIVE' });
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ACTIVE');
    expect(response.body.data.cancelledOrTerminal).toBe(false);
    expect(response.body.data.pendingCancellation).toBe(false);
  });

  test('SUSPENDED subscription reconcile returns pendingCancellation true', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('SUSPENDED'));
    await User.findByIdAndUpdate(teacher._id, { paypalSubscriptionStatus: 'SUSPENDED' });
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('SUSPENDED');
    expect(response.body.data.cancelledOrTerminal).toBe(false);
    expect(response.body.data.pendingCancellation).toBe(true);
  });

  test('CANCELLED subscription reconcile returns 200 without 422', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
    expect(response.body.data.cancelledOrTerminal).toBe(true);
    expect(response.body.data.pendingCancellation).toBe(false);
  });

  test('EXPIRED subscription reconcile returns 200 without 422', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('EXPIRED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('EXPIRED');
    expect(response.body.data.cancelledOrTerminal).toBe(true);
    expect(response.body.data.pendingCancellation).toBe(false);
  });

  test('terminal state does NOT throw 422 during sync', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).not.toBe(422);
    expect(response.body.success).toBe(true);
  });

  test('syncSubscription called before fresh user reload in reconcileManagement', async () => {
    const User = require('../src/models/user.model');
    const findByIdSpy = jest.spyOn(User, 'findById');

    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});

    // Verify findById was called (it should be called after syncSubscription)
    expect(findByIdSpy).toHaveBeenCalled();
    findByIdSpy.mockRestore();
  });

  test('fresh user reload happens after sync', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));

    // Set local state to ACTIVE before sync
    await User.findByIdAndUpdate(teacher._id, { paypalSubscriptionStatus: 'ACTIVE' });

    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});

    // After sync, local state should reflect terminal state
    const syncedUser = await User.findById(teacher._id);
    expect(syncedUser.paypalSubscriptionStatus).toBe('CANCELLED');
    expect(response.body.data.status).toBe('CANCELLED');
  });

  test('cancelledOrTerminal=true for CANCELLED status', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.body.data.cancelledOrTerminal).toBe(true);
  });

  test('pendingCancellation=false for CANCELLED status', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.body.data.pendingCancellation).toBe(false);
  });

  test('cancelledOrTerminal=true for EXPIRED status', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('EXPIRED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.body.data.cancelledOrTerminal).toBe(true);
  });

  test('pendingCancellation=false for EXPIRED status', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('EXPIRED'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.body.data.pendingCancellation).toBe(false);
  });

  test('real sync failure still returns safe error', async () => {
    paypalMock.getSubscription.mockRejectedValue(new Error('Provider unavailable'));
    const response = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.success).toBe(false);
    expect(response.body).not.toHaveProperty('providerSecret');
  });

  test('repeated reconciliation is idempotent for terminal states', async () => {
    paypalMock.getSubscription.mockResolvedValue(providerSubscription('CANCELLED'));
    const response1 = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response1.status).toBe(200);

    const response2 = await request(app).post('/api/subscription/paypal/reconcile-management').set(auth()).send({});
    expect(response2.status).toBe(200);

    expect(response1.body.data).toEqual(response2.body.data);
  });

  describe('change-plan context prepare phase', () => {
    test('context with brand-new valid UUID creates PaymentManagementAttempt and returns 200 without calling PayPal revise', async () => {
      const newAttemptId = '00000000-0000-4000-8000-000000000099';
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: newAttemptId });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.changeAttemptId).toBe(newAttemptId);
      expect(response.body.data.providerSubscriptionId).toBe(SUBSCRIPTION);
      expect(response.body.data.targetPayPalPlanId).toBe('P-PRO-MONTHLY');
      expect(response.body.data.targetPlanCode).toBe('pro_monthly');
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
      const attempt = await PaymentManagementAttempt.findOne({ attemptId: newAttemptId });
      expect(attempt).toBeTruthy();
      expect(attempt.operation).toBe('CHANGE_PLAN');
      expect(attempt.status).toBe('processing');
      expect(attempt.targetPlanKey).toBe('pro_monthly');
    });

    test('context called twice with same UUID returns same attempt idempotently', async () => {
      const newAttemptId = '00000000-0000-4000-8000-000000000098';
      const response1 = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: newAttemptId });
      expect(response1.status).toBe(200);
      const response2 = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: newAttemptId });
      expect(response2.status).toBe(200);
      expect(response2.body.data.changeAttemptId).toBe(newAttemptId);
      expect(await PaymentManagementAttempt.countDocuments({ attemptId: newAttemptId })).toBe(1);
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
    });

    test('context with invalid target plan returns safe 4xx', async () => {
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'invalid_plan', changeAttemptId: CHANGE_ATTEMPT });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('PLAN_NOT_FOUND');
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
    });

    test('context for user without active manageable PayPal subscription returns safe domain error', async () => {
      const noPaypalUser = await User.create({
        firebaseUid: 'no-paypal-teacher',
        email: 'no-paypal@example.com',
        role: 'teacher',
        plan: free._id
      });
      const noPaypalAttemptId = '00000000-0000-4000-8000-000000000090';
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth(noPaypalUser))
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: noPaypalAttemptId });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE');
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
    });



    test('context never invokes provider revise', async () => {
      const newAttemptId = '00000000-0000-4000-8000-000000000097';
      await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: newAttemptId });
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
      expect(paypalMock.cancelSubscription).not.toHaveBeenCalled();
    });

    test('context returns conflict when existing pending change exists', async () => {
      const existingAttemptId = '00000000-0000-4000-8000-000000000096';
      await PaymentManagementAttempt.create({
        provider: 'paypal',
        attemptId: existingAttemptId,
        userId: teacher._id,
        providerSubscriptionId: SUBSCRIPTION,
        operation: 'CHANGE_PLAN',
        sourcePlanKey: 'essential_monthly',
        sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY',
        targetPlanKey: 'pro_monthly',
        targetProviderPlanId: 'P-PRO-MONTHLY',
        status: 'processing',
        activeOperationKey: `paypal:${SUBSCRIPTION}`
      });
      const newAttemptId = '00000000-0000-4000-8000-000000000095';
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: newAttemptId });
      // When there's an existing active change, return conflict
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT');
    });

    test('context reuses existing attempt with same UUID', async () => {
      const existingAttemptId = '00000000-0000-4000-8000-000000000094';
      await PaymentManagementAttempt.create({
        provider: 'paypal',
        attemptId: existingAttemptId,
        userId: teacher._id,
        providerSubscriptionId: SUBSCRIPTION,
        operation: 'CHANGE_PLAN',
        sourcePlanKey: 'essential_monthly',
        sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY',
        targetPlanKey: 'pro_monthly',
        targetProviderPlanId: 'P-PRO-MONTHLY',
        status: 'processing'
      });
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: existingAttemptId });
      expect(response.status).toBe(200);
      expect(response.body.data.changeAttemptId).toBe(existingAttemptId);
      expect(await PaymentManagementAttempt.countDocuments({ attemptId: existingAttemptId })).toBe(1);
      expect(paypalMock.reviseSubscription).not.toHaveBeenCalled();
    });

    test('context rejects cancelled attempt', async () => {
      const cancelledAttemptId = '00000000-0000-4000-8000-000000000093';
      await PaymentManagementAttempt.create({
        provider: 'paypal',
        attemptId: cancelledAttemptId,
        userId: teacher._id,
        providerSubscriptionId: SUBSCRIPTION,
        operation: 'CHANGE_PLAN',
        sourcePlanKey: 'essential_monthly',
        sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY',
        targetPlanKey: 'pro_monthly',
        targetProviderPlanId: 'P-PRO-MONTHLY',
        status: 'cancelled'
      });
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: cancelledAttemptId });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT');
    });

    test('context rejects completed attempt', async () => {
      const completedAttemptId = '00000000-0000-4000-8000-000000000092';
      await PaymentManagementAttempt.create({
        provider: 'paypal',
        attemptId: completedAttemptId,
        userId: teacher._id,
        providerSubscriptionId: SUBSCRIPTION,
        operation: 'CHANGE_PLAN',
        sourcePlanKey: 'essential_monthly',
        sourceProviderPlanId: 'P-ESSENTIAL-MONTHLY',
        targetPlanKey: 'pro_monthly',
        targetProviderPlanId: 'P-PRO-MONTHLY',
        status: 'completed'
      });
      const response = await request(app).post('/api/subscription/paypal/change-plan/context').set(auth())
        .send({ targetPlanCode: 'pro_monthly', changeAttemptId: completedAttemptId });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PAYPAL_MANAGEMENT_ATTEMPT_CONFLICT');
    });
  });
});
