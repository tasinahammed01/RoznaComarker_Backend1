'use strict';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const service = require('../src/services/credit.service');

let teacher;
beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  const plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, billingInterval: 'month',
    features: { essayAnalysesPerMonth: 2 } });
  teacher = await User.create({ firebaseUid: `teacher-${Date.now()}`, email: `teacher-${Date.now()}@example.com`,
    role: 'teacher', plan: plan._id, planStartedAt: new Date() });
});

test('legacy teacher wallet is created once from the canonical plan allowance', async () => {
  const first = await service.getOrCreateWallet(teacher); const second = await service.getOrCreateWallet(teacher);
  expect(String(first.wallet._id)).toBe(String(second.wallet._id));
  expect(service.toDto(first)).toMatchObject({ monthlyCredits: 2, monthlyCreditsUsed: 0, bonusCredits: 0, availableCredits: 2 });
  expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(1);
});

test('monthly credits are consumed before bonus and each mutation is audited', async () => {
  await service.adjustBonusCredits({ userId: teacher._id, amount: 2, reason: 'Test bonus', idempotencyKey: 'bonus:test:1' });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'draft-a' });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'draft-b' });
  let wallet = await CreditWallet.findOne({ userId: teacher._id });
  expect(wallet).toMatchObject({ monthlyCreditsUsed: 2, bonusCredits: 2 });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'draft-c' });
  wallet = await CreditWallet.findOne({ userId: teacher._id });
  expect(wallet).toMatchObject({ monthlyCreditsUsed: 2, bonusCredits: 1 });
  expect(await CreditTransaction.countDocuments({ userId: teacher._id })).toBe(4);
});

test('duplicate and concurrent success callbacks charge exactly once', async () => {
  const submissionId = new mongoose.Types.ObjectId();
  const calls = await Promise.all(Array.from({ length: 2 }, () => service.consumeAssessmentCredit({
    userId: teacher._id, submissionId, assessmentId: 'same-source-hash' })));
  expect(calls.filter((item) => item.charged).length).toBe(1);
  expect((await CreditWallet.findOne({ userId: teacher._id })).monthlyCreditsUsed).toBe(1);
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(1);
});

test('concurrent final-credit consumption cannot overspend', async () => {
  const wallet = (await service.getOrCreateWallet(teacher)).wallet;
  await CreditWallet.updateOne({ _id: wallet._id }, { $set: { monthlyCreditsUsed: 1 } });
  const results = await Promise.allSettled(['a', 'b'].map((assessmentId) => service.consumeAssessmentCredit({
    userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId })));
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(service.available(await CreditWallet.findById(wallet._id))).toBe(0);
});

test('monthly reset preserves bonus credits and is idempotent', async () => {
  const state = await service.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 2, bonusCredits: 3,
    billingCycleStart: new Date('2025-01-01'), billingCycleEnd: new Date('2025-02-01'), lastCreditReset: new Date('2025-01-01') } });
  const first = await service.getOrCreateWallet(teacher); const second = await service.getOrCreateWallet(teacher);
  expect(first.wallet).toMatchObject({ monthlyCreditsUsed: 0, bonusCredits: 3 });
  expect(String(first.wallet.lastCreditReset)).toBe(String(second.wallet.lastCreditReset));
  expect(await CreditTransaction.countDocuments({ type: 'MONTHLY_RESET' })).toBe(1);
});

test('purchased credits are consumed after monthly and before bonus and survive reset', async () => {
  const state = await service.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 2, purchasedCredits: 2, bonusCredits: 2 } });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'purchased-run' });
  let wallet = await CreditWallet.findById(state.wallet._id);
  expect(wallet).toMatchObject({ monthlyCreditsUsed: 2, purchasedCredits: 1, bonusCredits: 2 });
  await CreditWallet.updateOne({ _id: wallet._id }, { $set: { billingCycleEnd: new Date('2020-01-01') } });
  wallet = (await service.getOrCreateWallet(teacher)).wallet;
  expect(wallet).toMatchObject({ monthlyCreditsUsed: 0, purchasedCredits: 1, bonusCredits: 2 });
});

test('admin removal cannot create a negative available balance', async () => {
  await expect(service.adjustBonusCredits({ userId: teacher._id, amount: -3, reason: 'Correction',
    idempotencyKey: 'admin:debit:1', actorId: new mongoose.Types.ObjectId() })).rejects.toMatchObject({ code: 'INSUFFICIENT_ASSESSMENT_CREDITS' });
  expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(0);
});

test('five retries and a duplicate completion callback for one backend run debit once', async () => {
  const submissionId = new mongoose.Types.ObjectId();
  await Promise.all(Array.from({ length: 5 }, () => service.consumeAssessmentCredit({
    userId: teacher._id, submissionId, assessmentId: 'backend-run-1' })));
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId, assessmentId: 'backend-run-1' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(1);
  expect((await CreditWallet.findOne({ userId: teacher._id })).monthlyCreditsUsed).toBe(1);
});

test('a revised draft and a legitimate new run use distinct backend run identities', async () => {
  const submissionId = new mongoose.Types.ObjectId();
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId, assessmentId: 'run-draft-1' });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId, assessmentId: 'run-draft-2', reason: 'Revised Draft Assessment' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(2);
  expect((await CreditWallet.findOne({ userId: teacher._id })).monthlyCreditsUsed).toBe(2);
});

test('failed and partial work creates no debit unless complete is explicitly consumed', async () => {
  await service.getOrCreateWallet(teacher);
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(0);
  expect((await CreditWallet.findOne({ userId: teacher._id })).monthlyCreditsUsed).toBe(0);
});

test('zero credits blocks assessment checks without modifying normal user state', async () => {
  const state = await service.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 2, bonusCredits: 0 } });
  const before = await User.findById(teacher._id).lean();
  expect((await service.canRunAssessment(teacher._id)).allowed).toBe(false);
  await expect(service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(),
    assessmentId: 'blocked-run' })).rejects.toMatchObject({ code: 'INSUFFICIENT_ASSESSMENT_CREDITS' });
  const after = await User.findById(teacher._id).lean();
  expect(after.email).toBe(before.email); expect(after.role).toBe(before.role); expect(after.isActive).toBe(before.isActive);
});

test('plan allowance refresh changes monthly allowance and preserves bonus', async () => {
  const state = await service.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { bonusCredits: 4 } });
  await Plan.updateOne({ _id: teacher.plan }, { $set: { 'features.essayAnalysesPerMonth': 7 } });
  const refreshed = await service.getOrCreateWallet(teacher._id);
  expect(refreshed.wallet).toMatchObject({ monthlyCredits: 7, bonusCredits: 4 });
  expect(await CreditTransaction.countDocuments({ type: 'PLAN_ALLOWANCE_CHANGE' })).toBe(1);
});

test('legacy wallet initialization is race safe', async () => {
  const states = await Promise.all(Array.from({ length: 5 }, () => service.getOrCreateWallet(teacher._id)));
  expect(new Set(states.map((state) => String(state.wallet._id))).size).toBe(1);
  expect(await CreditWallet.countDocuments({ userId: teacher._id })).toBe(1);
});

test('admin add and remove create actor-attributed audit transactions', async () => {
  const actorId = new mongoose.Types.ObjectId();
  await service.adjustBonusCredits({ userId: teacher._id, amount: 3, reason: 'Support grant', idempotencyKey: 'admin:add:2', actorId });
  await service.adjustBonusCredits({ userId: teacher._id, amount: -2, reason: 'Correction', idempotencyKey: 'admin:remove:2', actorId });
  const transactions = await CreditTransaction.find({ userId: teacher._id }).sort({ createdAt: 1 }).lean();
  expect(transactions.map((item) => item.type)).toEqual(['ADMIN_CREDIT', 'ADMIN_DEBIT']);
  expect(transactions.every((item) => item.metadata.adminActorId === String(actorId))).toBe(true);
  expect(transactions[1]).toMatchObject({ amount: -2, reason: 'Correction', balanceAfter: 3 });
});

test('available balance formula never reports a negative monthly remainder', async () => {
  expect(service.available({ monthlyCredits: 2, monthlyCreditsUsed: 9, bonusCredits: 3 })).toBe(3);
});

test('one successful assessment creates exactly one committed debit', async () => {
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'success-run' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT', status: 'committed', amount: -1 })).toBe(1);
});

test('bonus fallback leaves exhausted monthly usage unchanged', async () => {
  const state = await service.getOrCreateWallet(teacher); await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 2, bonusCredits: 1 } });
  await service.consumeAssessmentCredit({ userId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assessmentId: 'bonus-run' });
  expect(await CreditWallet.findById(state.wallet._id)).toMatchObject({ monthlyCreditsUsed: 2, bonusCredits: 0 });
});

test('repeated reset checks do not create another reset transaction', async () => {
  const state = await service.getOrCreateWallet(teacher); await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { billingCycleEnd: new Date('2020-01-01') } });
  await service.getOrCreateWallet(teacher); await service.getOrCreateWallet(teacher);
  expect(await CreditTransaction.countDocuments({ type: 'MONTHLY_RESET' })).toBe(1);
});

test('admin add increases bonus without overwriting monthly fields', async () => {
  const actorId = new mongoose.Types.ObjectId(); await service.adjustBonusCredits({ userId: teacher._id, amount: 4, reason: 'Grant', idempotencyKey: 'admin:add:standalone', actorId });
  expect(await CreditWallet.findOne({ userId: teacher._id })).toMatchObject({ monthlyCredits: 2, monthlyCreditsUsed: 0, bonusCredits: 4 });
});

test('admin remove consumes available monthly credits safely', async () => {
  await service.adjustBonusCredits({ userId: teacher._id, amount: -1, reason: 'Correction', idempotencyKey: 'admin:remove:standalone', actorId: new mongoose.Types.ObjectId() });
  expect(await CreditWallet.findOne({ userId: teacher._id })).toMatchObject({ monthlyCreditsUsed: 1, bonusCredits: 0 });
});

test('80 percent nudge acknowledgement persists for one cycle and resets in the next cycle', async () => {
  const state = await service.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 2 } });
  const acknowledged = await service.acknowledgeNudge(teacher._id, 80);
  expect(service.toDto(acknowledged).warningAcknowledged).toBe(true);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { billingCycleEnd: new Date('2020-01-01') } });
  expect(service.toDto(await service.getOrCreateWallet(teacher._id)).warningAcknowledged).toBe(false);
});
