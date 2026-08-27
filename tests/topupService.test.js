'use strict';
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const CreditPack = require('../src/models/CreditPack');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const service = require('../src/services/topup.service');

let teacher; let pack;
beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  await Plan.create({ name: 'Free', slug: 'free', isActive: true, features: { essayAnalysesPerMonth: 25 } });
  const plan = await Plan.create({ name: 'Essential', slug: 'essential', isActive: true, features: { essayAnalysesPerMonth: 100 } });
  teacher = await User.create({ firebaseUid: `topup-${Date.now()}`, email: `topup-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
  pack = await CreditPack.create({ name: 'Small', code: 'TOPUP_SMALL', credits: 10, price: 4.99, currency: 'USD',
    stripePriceId: 'price_small', allowedPlans: ['essential'], active: true });
});

test('pack lookup enforces canonical plan eligibility', async () => {
  expect((await service.eligiblePack(teacher, 'topup_small')).pack.credits).toBe(10);
  pack.allowedPlans = ['pro']; await pack.save();
  await expect(service.eligiblePack(teacher, 'TOPUP_SMALL')).rejects.toMatchObject({ code: 'CREDIT_PACK_NOT_ELIGIBLE' });
});

test('paid webhook identity grants purchased credits exactly once and creates an audit transaction', async () => {
  const session = { id: 'cs_paid_once', payment_intent: 'pi_once', amount_total: 499, currency: 'usd' };
  const first = await service.grantPurchasedCredits({ userId: teacher._id, pack, session });
  const duplicate = await service.grantPurchasedCredits({ userId: teacher._id, pack, session });
  expect(first.granted).toBe(true); expect(duplicate.granted).toBe(false);
  expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
  expect(await CreditTransaction.countDocuments({ idempotencyKey: 'topup:cs_paid_once', type: 'TOPUP_PURCHASE_COMPLETED' })).toBe(1);
});

test('refund removes unused purchased credits without touching monthly or bonus inventory', async () => {
  const session = { id: 'cs_refund', payment_intent: 'pi_refund', amount_total: 499, currency: 'usd' };
  await service.grantPurchasedCredits({ userId: teacher._id, pack, session });
  const transaction = await service.refundPurchase({ id: 'ch_refund', payment_intent: 'pi_refund', amount_refunded: 499, currency: 'usd' });
  expect(transaction).toMatchObject({ type: 'TOPUP_REFUND', status: 'refunded', amount: -10 });
  expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
});

test('refund after purchased credits were consumed is flagged for review and never creates debt', async () => {
  const session = { id: 'cs_review', payment_intent: 'pi_review', amount_total: 499, currency: 'usd' };
  await service.grantPurchasedCredits({ userId: teacher._id, pack, session });
  await CreditWallet.updateOne({ userId: teacher._id }, { $set: { purchasedCredits: 4 } });
  const transaction = await service.refundPurchase({ id: 'ch_review', payment_intent: 'pi_review', amount_refunded: 499, currency: 'usd' });
  expect(transaction).toMatchObject({ type: 'TOPUP_REFUND', status: 'review_required', amount: 0 });
  expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(4);
});

test('payment failure is audited and grants zero credits', async () => {
  await service.recordFailedPurchase({ userId: teacher._id, packCode: pack.code, session: { id: 'cs_failed' } });
  expect(await CreditTransaction.countDocuments({ type: 'TOPUP_PURCHASE_FAILED', status: 'failed', amount: 0 })).toBe(1);
  expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(0);
});
