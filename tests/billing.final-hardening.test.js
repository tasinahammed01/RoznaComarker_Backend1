'use strict';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY = 'P-EM';
process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL = 'P-EA';
process.env.PAYPAL_SANDBOX_PLAN_PRO_MONTHLY = 'P-PM';
process.env.PAYPAL_SANDBOX_PRODUCT_ID = 'PROD-FINAL';
process.env.APP_PUBLIC_URL = 'http://localhost:4200';
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Pack = require('../src/models/CreditPack');
const Checkout = require('../src/models/PaymentCheckoutAttempt');
const Management = require('../src/models/PaymentManagementAttempt');
const Wallet = require('../src/models/CreditWallet');
const Transaction = require('../src/models/CreditTransaction');
const Subscription = require('../src/services/paypal/paypalSubscription.service');
const Manage = require('../src/services/paypal/paypalSubscriptionManagement.service');
const Credits = require('../src/services/credit.service');
const Topup = require('../src/services/topup.service');
const Mapping = require('../src/services/paypal/paypalPlanMapping.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { randomUUID } = require('crypto');
const { migrate } = require('../scripts/migrateBillingContracts');
const mongoose = require('mongoose');
let user, essential, client;
const provider = planId => ({ id: 'I-FINAL', plan_id: planId, status: 'ACTIVE',
  start_time: '2026-01-31T12:00:00Z', billing_info: { next_billing_time: '2027-01-31T12:00:00Z' } });
beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Checkout.init(), Management.init(), Transaction.init(), Wallet.init(), Pack.init(), Plan.init(), User.init()]); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  const free = await Plan.create({ name: 'Free', slug: 'free', price: 0, features: { essayAnalysesPerMonth: 25 } });
  essential = await Plan.create({ name: 'Essential', slug: 'essential', price: 24.99, annualPrice: 249,
    billingInterval: 'month', features: { essayAnalysesPerMonth: 100 } });
  await Plan.create({ name: 'Pro', slug: 'pro', price: 49.99, features: { essayAnalysesPerMonth: 200 } });
  user = await User.create({ firebaseUid: randomUUID(), email: `${randomUUID()}@example.com`, role: 'teacher', plan: free._id });
  client = { createSubscription: jest.fn().mockResolvedValue({ id: 'I-FINAL', links: [
    { rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve' }] }),
    getSubscription: jest.fn().mockResolvedValue(provider('P-EM')),
    getPlan: jest.fn().mockResolvedValue({ product_id: 'PROD-FINAL' }),
    reviseSubscription: jest.fn().mockResolvedValue({ links: [{ rel: 'approve', method: 'GET', href: 'https://www.sandbox.paypal.com/approve' }] }) };
});
test.each([['monthly', 'monthly', 'P-EM'], ['annual', 'yearly', 'P-EA']])('checkout %s stores interval and trusted mapping', async (billingPeriod, interval, id) => {
  const attemptId = randomUUID();
  const attempt = await Subscription.createSubscription({ user, planKey: 'essential', billingPeriod, attemptId, client });
  expect(attempt.billingInterval).toBe(interval);
  expect(client.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ plan_id: id }), attemptId);
  await expect(Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: billingPeriod === 'monthly' ? 'annual' : 'monthly', attemptId, client }))
    .rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
});
test('combined records require explicit period and cannot silently bill monthly', async () => {
  await expect(Subscription.createSubscription({ user, planKey: 'essential', attemptId: randomUUID(), client }))
    .rejects.toMatchObject({ code: 'PAYPAL_BILLING_INTERVAL_REQUIRED' });
});
test('two concurrent checkout UUIDs create one provider subscription', async () => {
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map(attemptId =>
    Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: 'annual', attemptId, client })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(client.createSubscription).toHaveBeenCalledTimes(1);
  expect(await Checkout.countDocuments()).toBe(1);
});
test('provider create timeout reserves the operation and same-key recovery replays its identity', async () => {
  const attemptId = randomUUID();
  client.createSubscription.mockRejectedValueOnce(new Error('response lost'));
  await expect(Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: 'annual', attemptId, client })).rejects.toThrow();
  expect((await Checkout.findOne({ attemptId })).activeOperationKey).toBe(`paypal:${user._id}`);
  await Checkout.updateOne({ attemptId }, { $set: { updatedAt: new Date(Date.now() - 180000), processingLeaseExpiresAt: new Date(0) } }, { timestamps: false });
  const recovered = await Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: 'annual', attemptId, client });
  expect(recovered.attemptId).toBe(attemptId);
  expect(client.createSubscription.mock.calls.map(call => call[1])).toEqual([attemptId, attemptId]);
});
test.each([['monthly', 'annual', 'P-EM', 'P-EA'], ['annual', 'monthly', 'P-EA', 'P-EM']])('same-tier %s to %s uses interval identity', async (_, billingPeriod, source, target) => {
  user.paypalSubscriptionId = 'I-FINAL'; user.paypalPlanId = source; user.paypalSubscriptionStatus = 'ACTIVE'; await user.save();
  client.getSubscription.mockResolvedValue(provider(source));
  const result = await Manage.changePlan({ user, targetPlanCode: 'essential', billingPeriod, changeAttemptId: randomUUID(), client });
  expect(result.attempt.targetProviderPlanId).toBe(target);
});
test('fresh prepared attempt immediately has one backend worker', async () => {
  user.paypalSubscriptionId = 'I-FINAL'; user.paypalPlanId = 'P-EM'; user.paypalSubscriptionStatus = 'ACTIVE'; await user.save();
  const attemptId = randomUUID();
  await Management.create({ provider: 'paypal', attemptId, userId: user._id, providerSubscriptionId: 'I-FINAL', operation: 'CHANGE_PLAN',
    sourcePlanKey: 'essential', sourceProviderPlanId: 'P-EM', targetPlanKey: 'essential', targetProviderPlanId: 'P-EA',
    billingInterval: 'yearly', status: 'prepared', activeOperationKey: 'paypal:I-FINAL', providerRequestId: `revise-${attemptId}` });
  await Promise.all([1, 2].map(() => Manage.changePlan({ user, targetPlanCode: 'essential', billingPeriod: 'annual', changeAttemptId: attemptId, client })));
  expect(client.reviseSubscription).toHaveBeenCalledTimes(1);
});
test('SDK claim excludes backend mutation and another SDK worker', async () => {
  user.paypalSubscriptionId = 'I-FINAL'; user.paypalPlanId = 'P-EM'; await user.save();
  const attemptId = randomUUID();
  await Management.create({ provider: 'paypal', attemptId, userId: user._id, providerSubscriptionId: 'I-FINAL', operation: 'CHANGE_PLAN',
    sourcePlanKey: 'essential', sourceProviderPlanId: 'P-EM', targetPlanKey: 'essential', targetProviderPlanId: 'P-EA',
    billingInterval: 'yearly', status: 'prepared', activeOperationKey: 'paypal:I-FINAL' });
  await Manage.claimSdkTransport({ user, changeAttemptId: attemptId });
  await expect(Manage.claimSdkTransport({ user, changeAttemptId: attemptId })).rejects.toMatchObject({ code: 'PAYPAL_CHANGE_RECONCILIATION_REQUIRED' });
  await Manage.changePlan({ user, targetPlanCode: 'essential', billingPeriod: 'annual', changeAttemptId: attemptId, client });
  expect(client.reviseSubscription).not.toHaveBeenCalled();
});
test('completed authorized revision remains correlated on later webhook fetch-back', async () => {
  const attemptId = randomUUID();
  await Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: 'monthly', attemptId, client });
  await Subscription.syncSubscription(provider('P-EM'));
  user = await User.findById(user._id);
  await Manage.changePlan({ user, targetPlanCode: 'pro', billingPeriod: 'monthly', changeAttemptId: randomUUID(), client });
  await Subscription.syncSubscription(provider('P-PM'));
  const again = await Subscription.syncSubscription(provider('P-PM'));
  expect(again.plan.slug).toBe('pro');
  expect(again.managementAttempt.status).toBe('completed');
});
test('unauthorized provider transition is rejected', async () => {
  await Subscription.createSubscription({ user, planKey: 'essential', billingPeriod: 'monthly', attemptId: randomUUID(), client });
  await expect(Subscription.syncSubscription(provider('P-PM'))).rejects.toMatchObject({ code: 'PAYPAL_SUBSCRIPTION_PLAN_MISMATCH' });
});
test('inactive-for-sale combined annual plan still maps existing entitlement', async () => {
  essential.isActive = false; await essential.save();
  expect((await Mapping.getPlanByPayPalPlanId('P-EA')).slug).toBe('essential');
  await expect(Mapping.getPayPalPlanId({ planKey: 'essential', billingInterval: 'yearly' })).rejects.toThrow();
});
test('annual monthly cycles clamp month ends and ignore historical Stripe dates', () => {
  const u = { planStartedAt: new Date('2024-01-31T12:00:00Z'), stripeCurrentPeriodStart: new Date('2024-01-01'), stripeCurrentPeriodEnd: new Date('2025-01-01') };
  const cycle = Credits.cycleFor(u, { billingInterval: 'yearly' }, new Date('2024-03-01'));
  expect(cycle.start.toISOString()).toBe('2024-02-29T12:00:00.000Z');
  expect(cycle.end.toISOString()).toBe('2024-03-31T12:00:00.000Z');
});
test.each(['free', 'essential'])('%s receives normalized eligible personal packs', async slug => {
  user.plan = (await Plan.findOne({ slug }))._id; await user.save();
  await Pack.create({ name: 'Approved ten', code: 'APPROVED_10', credits: 10, price: 7.25, currency: 'USD', active: true, allowedPlans: [' Free ', 'Essential'], displayOrder: 1 });
  expect((await Topup.listPacks(user)).map(p => p.code)).toEqual(['APPROVED_10']);
});
test('eligibility-only migration preserves commercial values and institution-only packs', async () => {
  await Plan.create({ name: 'Institution', slug: 'institution' });
  await Pack.collection.insertMany([{ code: 'EXISTING', name: 'Existing', credits: 17, price: 12.34, currency: 'USD', active: true, displayOrder: 1, allowedPlans: [' Essential '] },
    { code: 'SCHOOL', name: 'School', credits: 100, price: 99, currency: 'USD', active: true, displayOrder: 2, allowedPlans: ['institution'] }]);
  await migrate(mongoose.connection.db, { apply: true, backupConfirmed: true });
  await migrate(mongoose.connection.db, { apply: true, backupConfirmed: true });
  expect(await Pack.findOne({ code: 'EXISTING' }).lean()).toMatchObject({ price: 12.34, credits: 17, allowedPlans: ['essential', 'free'] });
  expect((await Pack.findOne({ code: 'SCHOOL' })).allowedPlans).toEqual(['institution']);
});


test('legacy annual wallet resets monthly once and preserves purchased and bonus credits', async () => {
  const start=new Date('2024-01-31T12:00:00Z');
  let wallet=await Wallet.create({userId:user._id,monthlyCredits:100,monthlyCreditsUsed:40,purchasedCredits:17,bonusCredits:9,
    billingCycleStart:start,billingCycleEnd:new Date('2025-01-31T12:00:00Z'),lastCreditReset:start});
  wallet=await Credits.resetMonthlyCreditsIfNeeded(user,essential,wallet,new Date('2024-02-10'));
  expect(wallet.monthlyCreditsUsed).toBe(40);
  expect(wallet.billingCycleEnd.toISOString()).toBe('2024-02-29T12:00:00.000Z');
  wallet=await Credits.resetMonthlyCreditsIfNeeded(user,essential,wallet,new Date('2024-03-01'));
  expect(wallet.monthlyCreditsUsed).toBe(0);
  expect(wallet.purchasedCredits).toBe(17);expect(wallet.bonusCredits).toBe(9);
  wallet.monthlyCreditsUsed=3;await wallet.save();
  wallet=await Credits.resetMonthlyCreditsIfNeeded(user,essential,wallet,new Date('2024-03-02'));
  expect(wallet.monthlyCreditsUsed).toBe(3);
  expect(await Transaction.countDocuments({userId:user._id,type:'MONTHLY_RESET'})).toBe(1);
});
