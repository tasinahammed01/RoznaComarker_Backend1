'use strict';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.FRONTEND_URL = 'http://localhost:4200';
require('./helpers/phase1Setup');

const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const PaymentPurchaseAttempt = require('../src/models/PaymentPurchaseAttempt');
const PlanEntitlement = require('../src/models/PlanEntitlement');
const PlanEntitlementLock = require('../src/models/PlanEntitlementLock');
const CreditWallet = require('../src/models/CreditWallet');
const Notification = require('../src/models/notification.model');
const service = require('../src/services/planEntitlement.service');
const purchaseService = require('../src/services/paypal/paypalPlanPurchase.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('fixed-term prepaid plan entitlements', () => {
  beforeAll(async () => { await connectInMemoryMongo({ replicaSet: true }); await Promise.all([
    PaymentPurchaseAttempt.init(), PlanEntitlement.init(), PlanEntitlementLock.init(), Notification.init()]); });
  afterAll(disconnectInMemoryMongo);
  let free; let essential; let pro; let user;
  beforeEach(async () => {
    await clearDatabase();
    free = await Plan.create({ name: 'Free', slug: 'free', price: 0, isActive: true, features: { essayAnalysesPerMonth: 5 } });
    essential = await Plan.create({ name: 'Essential', slug: 'essential', price: 10, annualPrice: 100, currency: 'USD', isActive: true,
      features: { essayAnalysesPerMonth: 100 } });
    pro = await Plan.create({ name: 'Pro', slug: 'pro', price: 20, annualPrice: 200, currency: 'USD', isActive: true,
      features: { essayAnalysesPerMonth: 300 } });
    user = await User.create({ firebaseUid: `prepaid-${Date.now()}`, email: `prepaid-${Date.now()}@test.invalid`, role: 'teacher', plan: free._id });
  });
  const attempt = async (suffix, plan, period = 'monthly') => PaymentPurchaseAttempt.create({ provider: 'paypal', purpose: 'plan_purchase',
    attemptId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`, userId: user._id, fundingSource: 'paypal',
    planSlug: plan.slug, billingPeriod: period, expectedAmount: period === 'annual' ? String(plan.annualPrice) + '.00' : String(plan.price) + '.00',
    currency: 'USD', createRequestId: `create-${suffix}`, captureRequestId: `capture-${suffix}`, status: 'captured' });

  test('calendar periods preserve month-end and leap-year semantics', () => {
    expect(service.addCalendarPeriod(new Date('2024-01-31T12:00:00Z'), 'monthly').toISOString()).toBe('2024-02-29T12:00:00.000Z');
    expect(service.addCalendarPeriod(new Date('2024-02-29T12:00:00Z'), 'annual').toISOString()).toBe('2025-02-28T12:00:00.000Z');
  });

  test('duplicate capture fulfills once and same-plan renewal preserves paid time', async () => {
    const now = new Date('2026-09-25T10:00:00Z'); const first = await attempt(1, essential);
    const a = await service.fulfillPlanPurchase({ attempt: first, plan: essential, capture: { id: 'CAPTURE-1' }, now });
    const replay = await service.fulfillPlanPurchase({ attempt: first, plan: essential, capture: { id: 'CAPTURE-1' }, now });
    expect(String(replay._id)).toBe(String(a._id));
    const second = await attempt(2, essential);
    const renewed = await service.fulfillPlanPurchase({ attempt: second, plan: essential, capture: { id: 'CAPTURE-2' }, now: new Date('2026-10-20T10:00:00Z') });
    expect(renewed.status).toBe('scheduled'); expect(renewed.startsAt.toISOString()).toBe(a.endsAt.toISOString());
    expect(await PlanEntitlement.countDocuments()).toBe(2);
  });

  test('annual term is one calendar year and a different plan is scheduled at current expiry', async () => {
    const now = new Date('2024-02-29T12:00:00Z'); const first = await attempt(3, essential, 'annual');
    const active = await service.fulfillPlanPurchase({ attempt: first, plan: essential, capture: { id: 'CAPTURE-3' }, now });
    expect(active.endsAt.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    const changed = await service.fulfillPlanPurchase({ attempt: await attempt(4, pro), plan: pro, capture: { id: 'CAPTURE-4' }, now });
    expect(changed.status).toBe('scheduled'); expect(changed.startsAt.toISOString()).toBe(active.endsAt.toISOString());
  });

  test('expiry falls back to Free without clearing purchased or bonus credits', async () => {
    const past = new Date('2026-01-01T00:00:00Z');
    await PlanEntitlement.create({ userId: user._id, planId: pro._id, planSlug: 'pro', billingPeriod: 'monthly', status: 'active',
      source: 'paypal', startsAt: new Date('2025-12-01T00:00:00Z'), endsAt: past, autoRenew: false,
      paymentProvider: 'paypal', providerCaptureId: 'CAPTURE-EXPIRED' });
    await CreditWallet.create({ userId: user._id, monthlyCredits: 300, monthlyCreditsUsed: 7, purchasedCredits: 19, bonusCredits: 11,
      billingCycleStart: new Date('2025-12-01T00:00:00Z'), billingCycleEnd: past, lastCreditReset: new Date('2025-12-01T00:00:00Z') });
    const result = await service.resolveEffectivePlan(user, new Date('2026-01-02T00:00:00Z'));
    expect(result.plan.slug).toBe('free');
    expect(await CreditWallet.findOne({ userId: user._id })).toMatchObject({ purchasedCredits: 19, bonusCredits: 11 });
  });

  test('reminders and expiry messages are exactly-once across repeated worker runs', async () => {
    const now = new Date('2026-09-25T00:00:00Z');
    await PlanEntitlement.create({ userId: user._id, planId: pro._id, planSlug: 'pro', billingPeriod: 'monthly', status: 'active',
      source: 'paypal', startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2026-09-27T00:00:00Z'), autoRenew: false,
      paymentProvider: 'paypal', providerCaptureId: 'CAPTURE-REMINDER' });
    await service.processExpiriesAndReminders(now); await service.processExpiriesAndReminders(now);
    expect(await Notification.countDocuments({ type: 'plan_expiry' })).toBe(1);
    const expiredAt = new Date('2026-09-28T00:00:00Z');
    await service.processExpiriesAndReminders(expiredAt); await service.processExpiriesAndReminders(expiredAt);
    expect(await Notification.countDocuments({ type: 'plan_expired' })).toBe(1);
  });

  test('legacy active recurring subscriptions are not downgraded by prepaid resolution', async () => {
    user.paypalSubscriptionId = 'I-LEGACY'; user.paypalSubscriptionStatus = 'ACTIVE'; user.plan = pro._id; await user.save();
    await PlanEntitlement.create({ userId: user._id, planId: essential._id, planSlug: 'essential', billingPeriod: 'monthly', status: 'expired',
      source: 'paypal', startsAt: new Date('2025-01-01T00:00:00Z'), endsAt: new Date('2025-02-01T00:00:00Z'), autoRenew: false,
      paymentProvider: 'paypal', providerCaptureId: 'CAPTURE-OLD' });
    expect(await service.resolveEffectivePlan(user, new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(String((await User.findById(user._id)).plan)).toBe(String(pro._id));
  });

  test('trusted plan Order capture verifies amount, currency, owner and purpose', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000099'; const orderId = 'ORDER-PLAN'; const captureId = 'CAPTURE-PLAN';
    const completed = (amount = '10.00', currency = 'USD') => ({ id: orderId, status: 'COMPLETED', purchase_units: [{
      reference_id: attemptId, custom_id: `paypal-plan:${attemptId}`, amount: { value: amount, currency_code: currency },
      payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { value: amount, currency_code: currency } }] }
    }] });
    const client = { createOrder: jest.fn().mockResolvedValue({ id: orderId, links: [{ rel: 'approve', method: 'GET',
      href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] }),
    captureOrder: jest.fn().mockResolvedValue(completed()), getOrder: jest.fn().mockResolvedValue(completed()) };
    const created = await purchaseService.createOrder({ user, planSlug: 'essential', billingPeriod: 'monthly', attemptId, client });
    expect(created.orderId).toBe(orderId);
    expect(client.createOrder.mock.calls[0][0].purchase_units[0]).toMatchObject({ amount: { value: '10.00', currency_code: 'USD' } });
    const fulfilled = await purchaseService.captureOrder({ user, attemptId, client });
    expect(fulfilled.fulfilled).toBe(true);
    expect((await purchaseService.captureOrder({ user, attemptId, client })).fulfilled).toBe(true);
    expect(await PlanEntitlement.countDocuments({ providerCaptureId: captureId })).toBe(1);
    const stranger = await User.create({ firebaseUid: 'prepaid-stranger', email: 'stranger@test.invalid', role: 'teacher', plan: free._id });
    await expect(purchaseService.captureOrder({ user: stranger, attemptId, client })).rejects.toMatchObject({ code: 'PAYPAL_PURCHASE_NOT_FOUND' });
  });

  test('INSTRUMENT_DECLINED restarts the same Order, then fulfills exactly once across replay and webhook', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000097'; const orderId = 'ORDER-DECLINED'; const captureId = 'CAPTURE-RETRY';
    const approved = { id: orderId, status: 'APPROVED', purchase_units: [] };
    const completed = { id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: attemptId,
      custom_id: `paypal-plan:${attemptId}`, amount: { value: '10.00', currency_code: 'USD' },
      payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } }] } }] };
    const client = { createOrder: jest.fn().mockResolvedValue({ id: orderId, links: [{ rel: 'approve', method: 'GET',
      href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] }),
    captureOrder: jest.fn().mockRejectedValueOnce(Object.assign(new Error('declined'), { providerStatus: 422,
      providerIssue: 'INSTRUMENT_DECLINED', debugId: 'plan-decline-debug' }))
      .mockRejectedValueOnce(Object.assign(new Error('declined again'), { providerStatus: 422,
        providerIssue: 'INSTRUMENT_DECLINED' })).mockResolvedValue(completed),
    getOrder: jest.fn().mockResolvedValueOnce(approved).mockResolvedValueOnce(approved).mockResolvedValue(completed) };
    await purchaseService.createOrder({ user, planSlug: 'essential', billingPeriod: 'monthly', attemptId, client });
    const originalCaptureRequestId = (await PaymentPurchaseAttempt.findOne({ attemptId })).captureRequestId;
    await expect(purchaseService.captureOrder({ user, attemptId, client })).rejects.toMatchObject({
      code: 'INSTRUMENT_DECLINED', statusCode: 422 });
    const firstDecline = await PaymentPurchaseAttempt.findOne({ attemptId });
    expect(firstDecline).toMatchObject({ status: 'approval_pending',
      failureClass: 'retryable', failureCode: 'INSTRUMENT_DECLINED', providerDebugId: 'plan-decline-debug',
      processingLeaseExpiresAt: null });
    expect(firstDecline.captureRequestId).not.toBe(originalCaptureRequestId);
    expect(client.captureOrder).toHaveBeenNthCalledWith(1, orderId, originalCaptureRequestId);
    expect(await purchaseService.get({ user, attemptId })).toMatchObject({ status: 'approval_pending',
      failureCode: 'INSTRUMENT_DECLINED', retryable: true, fulfilled: false });
    expect(await PlanEntitlement.countDocuments()).toBe(0);

    await expect(purchaseService.captureOrder({ user, attemptId, client })).rejects.toMatchObject({
      code: 'INSTRUMENT_DECLINED', statusCode: 422 });
    const secondDecline = await PaymentPurchaseAttempt.findOne({ attemptId });
    expect(secondDecline.captureRequestId).not.toBe(firstDecline.captureRequestId);
    expect(client.captureOrder).toHaveBeenNthCalledWith(2, orderId, firstDecline.captureRequestId);
    expect(await PlanEntitlement.countDocuments()).toBe(0);

    expect((await purchaseService.captureOrder({ user, attemptId, client })).fulfilled).toBe(true);
    expect(client.captureOrder).toHaveBeenNthCalledWith(3, orderId, secondDecline.captureRequestId);
    expect((await purchaseService.captureOrder({ user, attemptId, client })).fulfilled).toBe(true);
    await purchaseService.reconcileCaptureWebhook({ orderId, captureId, client });
    expect(await PlanEntitlement.countDocuments({ providerCaptureId: captureId })).toBe(1);
    expect(await PaymentPurchaseAttempt.findOne({ attemptId })).toMatchObject({ status: 'fulfilled',
      failureCode: undefined, safeFailureMessage: undefined });
  });

  test.each([
    ['timeout', new Error('timeout')],
    ['provider 5xx', Object.assign(new Error('provider unavailable'), { providerStatus: 500, providerIssue: 'INTERNAL_SERVER_ERROR' })]
  ])('%s ambiguity retains the same capture idempotency key across retry', async (_label, ambiguousError) => {
    const attemptId = '00000000-0000-4000-8000-000000000095'; const orderId = 'ORDER-AMBIGUOUS'; const captureId = 'CAPTURE-AMBIGUOUS';
    const completed = { id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: attemptId,
      custom_id: `paypal-plan:${attemptId}`, amount: { value: '10.00', currency_code: 'USD' },
      payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } }] } }] };
    const client = { createOrder: jest.fn().mockResolvedValue({ id: orderId, links: [{ rel: 'approve', method: 'GET',
      href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] }),
    captureOrder: jest.fn().mockRejectedValueOnce(ambiguousError).mockResolvedValue(completed),
    getOrder: jest.fn().mockRejectedValueOnce(new Error('response unavailable')) };
    await purchaseService.createOrder({ user, planSlug: 'essential', billingPeriod: 'monthly', attemptId, client });
    const captureRequestId = (await PaymentPurchaseAttempt.findOne({ attemptId })).captureRequestId;
    await expect(purchaseService.captureOrder({ user, attemptId, client })).rejects.toMatchObject({ statusCode: 502 });
    expect(await PaymentPurchaseAttempt.findOne({ attemptId })).toMatchObject({ status: 'failed',
      failureClass: 'retryable', captureRequestId });
    expect((await purchaseService.captureOrder({ user, attemptId, client })).fulfilled).toBe(true);
    expect(client.captureOrder.mock.calls.map((call) => call[1])).toEqual([captureRequestId, captureRequestId]);
    expect(await PlanEntitlement.countDocuments({ providerCaptureId: captureId })).toBe(1);
  });

  test('generic PayPal 422 remains permanent and creates no entitlement', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000096'; const orderId = 'ORDER-PERMANENT';
    const client = { createOrder: jest.fn().mockResolvedValue({ id: orderId, links: [{ rel: 'approve', method: 'GET',
      href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] }),
    captureOrder: jest.fn().mockRejectedValue(Object.assign(new Error('unprocessable'), { providerStatus: 422,
      providerIssue: 'UNPROCESSABLE_ENTITY' })), getOrder: jest.fn().mockResolvedValue({ id: orderId, status: 'APPROVED' }) };
    await purchaseService.createOrder({ user, planSlug: 'essential', billingPeriod: 'monthly', attemptId, client });
    await expect(purchaseService.captureOrder({ user, attemptId, client })).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY', statusCode: 409 });
    expect(await PaymentPurchaseAttempt.findOne({ attemptId })).toMatchObject({ status: 'failed',
      failureClass: 'permanent', failureCode: 'UNPROCESSABLE_ENTITY' });
    expect(await PlanEntitlement.countDocuments()).toBe(0);
    await expect(purchaseService.captureOrder({ user, attemptId, client })).rejects.toMatchObject({
      code: 'PAYPAL_PURCHASE_ATTEMPT_TERMINAL', statusCode: 409 });
    expect(client.captureOrder).toHaveBeenCalledTimes(1);
  });

  test.each([['9.99', 'USD'], ['10.00', 'EUR']])('mismatched provider money %s %s grants no plan', async (amount, currency) => {
    const doc = await attempt(currency === 'EUR' ? 81 : 80, essential); doc.providerEnvironment = 'sandbox'; doc.providerOrderId = 'ORDER-BAD';
    await doc.save();
    const order = { id: 'ORDER-BAD', status: 'COMPLETED', purchase_units: [{ reference_id: doc.attemptId,
      custom_id: `paypal-plan:${doc.attemptId}`, amount: { value: amount, currency_code: currency },
      payments: { captures: [{ id: `CAPTURE-BAD-${currency}`, status: 'COMPLETED', amount: { value: amount, currency_code: currency } }] } }] };
    expect(() => purchaseService.validate(order, doc)).toThrow();
    expect(await PlanEntitlement.countDocuments({ paymentAttemptId: doc._id })).toBe(0);
  });
});
