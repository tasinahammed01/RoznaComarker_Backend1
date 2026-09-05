'use strict';

const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const Notification = require('../src/models/notification.model');
const NotificationService = require('../src/services/notification.service');
const CreditService = require('../src/services/credit.service');
const NudgeService = require('../src/services/creditUsageNudge.service');

let teacher;
beforeAll(async () => { await connectInMemoryMongo(); await Notification.syncIndexes(); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); jest.restoreAllMocks();
  const plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, billingInterval: 'month',
    features: { essayAnalysesPerMonth: 10 } });
  teacher = await User.create({ firebaseUid: `nudge-${new mongoose.Types.ObjectId()}`,
    email: `nudge-${new mongoose.Types.ObjectId()}@example.com`, role: 'teacher', plan: plan._id,
    planStartedAt: new Date('2026-08-17T00:00:00.000Z') });
});

async function consume(id) {
  return CreditService.consumeAssessmentCredit({ userId: teacher._id,
    submissionId: new mongoose.Types.ObjectId(), assessmentId: id });
}
async function wallet() { return CreditWallet.findOne({ userId: teacher._id }); }
async function nudges() { return Notification.find({ recipient: teacher._id, type: 'credit_usage_nudge' }).sort({ createdAt: 1 }).lean(); }
async function setUsed(monthlyCreditsUsed, extras = {}) {
  const state = await CreditService.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed, ...extras } });
}

test('below 50 percent creates no nudge', async () => {
  await setUsed(3); await consume('below-50');
  expect(await nudges()).toHaveLength(0);
});

test('crossing 50 emits once and staying above does not duplicate it', async () => {
  await setUsed(4); await consume('cross-50'); await consume('above-50');
  const items = await nudges();
  expect(items).toHaveLength(1); expect(items[0].data.threshold).toBe(50);
});

test('crossing 80 emits one 80 notification', async () => {
  await setUsed(7); await consume('cross-80');
  expect((await nudges()).map((item) => item.data.threshold)).toEqual([80]);
});

test('crossing 100 emits one 100 notification and repeated requests stay idempotent', async () => {
  await setUsed(9);
  const submissionId = new mongoose.Types.ObjectId();
  await CreditService.consumeAssessmentCredit({ userId: teacher._id, submissionId, assessmentId: 'cross-100' });
  await CreditService.consumeAssessmentCredit({ userId: teacher._id, submissionId, assessmentId: 'cross-100' });
  expect((await nudges()).map((item) => item.data.threshold)).toEqual([100]);
});

test('simultaneous completion cannot duplicate a threshold notification', async () => {
  await setUsed(4);
  await Promise.all([consume('parallel-a'), consume('parallel-b')]);
  expect(await Notification.countDocuments({ recipient: teacher._id, 'data.threshold': 50 })).toBe(1);
});

test('failed or rolled-back assessment work creates no nudge', async () => {
  await setUsed(4);
  expect(await nudges()).toHaveLength(0);
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(0);
});

test('purchased and bonus credits are excluded from monthly percentage', async () => {
  await setUsed(3, { purchasedCredits: 500, bonusCredits: 500 }); await consume('monthly-only');
  expect(await nudges()).toHaveLength(0);
});

test('100 percent with purchased credits explains that additional credits remain', async () => {
  await setUsed(9, { purchasedCredits: 2 }); await consume('extra-at-100');
  const item = (await nudges())[0];
  expect(item.description).toContain('Future assessments will use your additional credits');
  expect(item.data.additionalCreditsRemaining).toBe(2);
});

test('100 percent with no total credits uses the exhausted copy and Add credits action', async () => {
  await setUsed(9); await consume('zero-at-100');
  const item = (await nudges())[0];
  expect(item.description).toBe("You've used all available assessment credits for this cycle.");
  expect(item.data.actionLabel).toBe('Add credits');
});

test('a new billing cycle allows thresholds again without deleting old notifications', async () => {
  await setUsed(4); await consume('old-cycle-50');
  const oldWallet = await wallet();
  const nextStart = new Date(oldWallet.billingCycleEnd); const nextEnd = new Date(nextStart); nextEnd.setMonth(nextEnd.getMonth() + 1);
  await CreditWallet.updateOne({ _id: oldWallet._id }, { $set: { monthlyCreditsUsed: 4,
    billingCycleStart: nextStart, billingCycleEnd: nextEnd, lastCreditReset: nextStart,
    usageNudges: { cycleKey: 'old', handledThresholds: [50, 80, 100], updatedAt: new Date() } } });
  await consume('new-cycle-50');
  expect(await Notification.countDocuments({ recipient: teacher._id, 'data.threshold': 50 })).toBe(2);
});

test('credit purchases and bonus grants do not reset handled thresholds', async () => {
  await setUsed(4); await consume('handled-50');
  await CreditWallet.updateOne({ userId: teacher._id }, { $inc: { purchasedCredits: 10, bonusCredits: 10 }, $set: { monthlyCreditsUsed: 4 } });
  await consume('cross-50-again');
  expect(await Notification.countDocuments({ recipient: teacher._id, 'data.threshold': 50 })).toBe(1);
});

test('restoring monthly credits does not cause the same threshold to fire twice', async () => {
  await setUsed(7); await consume('handled-80');
  await CreditWallet.updateOne({ userId: teacher._id }, { $set: { monthlyCreditsUsed: 6 } });
  await consume('back-to-70'); await consume('back-to-80');
  expect(await Notification.countDocuments({ recipient: teacher._id, 'data.threshold': 80 })).toBe(1);
});

test('free-plan integer crossing uses exact ratio rather than rounded equality', async () => {
  await Plan.updateOne({ _id: teacher.plan }, { $set: { 'features.essayAnalysesPerMonth': 25 } });
  await setUsed(12); await consume('free-13-of-25');
  const item = (await nudges())[0];
  expect(item.data).toMatchObject({ threshold: 50, monthlyUsed: 13, monthlyAllowance: 25 });
});

test('49 to 83 emits only 80 and marks 50 and 80 handled', async () => {
  const state = await CreditService.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 83, monthlyCredits: 100 } });
  const after = await wallet();
  await NudgeService.evaluateCreditUsageNudge({ userId: teacher._id,
    beforeWallet: { ...after.toObject(), monthlyCreditsUsed: 49 }, afterWallet: after,
    transaction: { type: 'ASSESSMENT_DEBIT', status: 'committed' } });
  expect((await nudges()).map((item) => item.data.threshold)).toEqual([80]);
  expect((await wallet()).usageNudges.handledThresholds.sort()).toEqual([50, 80]);
});

test('79 to 100 emits only 100 and handles every lower threshold', async () => {
  const state = await CreditService.getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 100, monthlyCredits: 100 } });
  const after = await wallet();
  await NudgeService.evaluateCreditUsageNudge({ userId: teacher._id,
    beforeWallet: { ...after.toObject(), monthlyCreditsUsed: 79 }, afterWallet: after,
    transaction: { type: 'ASSESSMENT_DEBIT', status: 'committed' } });
  expect((await nudges()).map((item) => item.data.threshold)).toEqual([100]);
  expect((await wallet()).usageNudges.handledThresholds.sort((a, b) => a - b)).toEqual([50, 80, 100]);
});

test('notification failure never fails the committed assessment and later consumption retries', async () => {
  await setUsed(4, { purchasedCredits: 1 });
  const original = NotificationService.createNotification;
  jest.spyOn(NotificationService, 'createNotification').mockRejectedValueOnce(new Error('temporary notification outage'));
  await expect(consume('notification-fails')).resolves.toMatchObject({ charged: true });
  expect((await wallet()).monthlyCreditsUsed).toBe(5);
  NotificationService.createNotification.mockImplementation(original);
  await consume('retry-after-failure');
  expect((await nudges()).map((item) => item.data.threshold)).toEqual([50]);
});

test('stable notification idempotency key is unique and ownership-scoped', async () => {
  await setUsed(4); await consume('stable-key');
  const item = (await nudges())[0];
  expect(item.idempotencyKey).toContain(`credit-usage:${teacher._id}:`);
  await expect(Notification.create({ recipient: teacher._id, type: 'credit_usage_nudge', title: 'duplicate',
    description: 'duplicate', idempotencyKey: item.idempotencyKey })).rejects.toMatchObject({ code: 11000 });
  expect(await Notification.countDocuments({ idempotencyKey: item.idempotencyKey })).toBe(1);
});

test('50 percent copy reports monthly used and remaining values', async () => {
  await setUsed(4); await consume('copy-50');
  expect((await nudges())[0]).toMatchObject({ title: 'Half of your monthly credits used',
    description: "You've used 5 of 10 monthly assessment credits. You have 5 monthly credits remaining." });
});

test('80 percent copy reports correct monthly remaining credits', async () => {
  await setUsed(7); await consume('copy-80');
  expect((await nudges())[0].description).toContain('2 monthly credits remain');
});

test('an allowance change alone does not create a nudge', async () => {
  await setUsed(5);
  await Plan.updateOne({ _id: teacher.plan }, { $set: { 'features.essayAnalysesPerMonth': 6 } });
  await CreditService.getOrCreateWallet(teacher._id);
  expect(await nudges()).toHaveLength(0);
});

test('a wallet read above a threshold does not create a nudge', async () => {
  await setUsed(8);
  await CreditService.getOrCreateWallet(teacher._id);
  expect(await nudges()).toHaveLength(0);
});

test('a bonus grant above a threshold does not create a nudge', async () => {
  await setUsed(8);
  await CreditService.adjustBonusCredits({ userId: teacher._id, amount: 2, reason: 'Support bonus',
    idempotencyKey: 'bonus:no-nudge' });
  expect(await nudges()).toHaveLength(0);
});

test('a zero monthly allowance never divides or emits', async () => {
  await Plan.updateOne({ _id: teacher.plan }, { $set: { 'features.essayAnalysesPerMonth': 0 } });
  const state = await CreditService.getOrCreateWallet(teacher._id);
  await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { bonusCredits: 1 } });
  await consume('zero-allowance');
  expect(await nudges()).toHaveLength(0);
});

test('different teachers receive independent cycle notifications', async () => {
  await setUsed(4); await consume('owner-one');
  const second = await User.create({ firebaseUid: `nudge-second-${new mongoose.Types.ObjectId()}`,
    email: `nudge-second-${new mongoose.Types.ObjectId()}@example.com`, role: 'teacher', plan: teacher.plan,
    planStartedAt: teacher.planStartedAt });
  const secondState = await CreditService.getOrCreateWallet(second);
  await CreditWallet.updateOne({ _id: secondState.wallet._id }, { $set: { monthlyCreditsUsed: 4 } });
  await CreditService.consumeAssessmentCredit({ userId: second._id, submissionId: new mongoose.Types.ObjectId(),
    assessmentId: 'owner-two' });
  expect(await Notification.countDocuments({ recipient: teacher._id, type: 'credit_usage_nudge' })).toBe(1);
  expect(await Notification.countDocuments({ recipient: second._id, type: 'credit_usage_nudge' })).toBe(1);
});

test('a debit finalization rollback restores the wallet and emits no nudge', async () => {
  await setUsed(4);
  jest.spyOn(CreditTransaction, 'findOneAndUpdate').mockRejectedValueOnce(new Error('commit failed'));
  await expect(consume('rolled-back')).rejects.toThrow('commit failed');
  expect((await wallet()).monthlyCreditsUsed).toBe(4);
  expect(await nudges()).toHaveLength(0);
});
