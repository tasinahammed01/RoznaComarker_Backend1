'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'bonus-reward-test-secret';

const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const BonusRewardGrant = require('../src/models/BonusRewardGrant');
const Notification = require('../src/models/notification.model');
const CreditService = require('../src/services/credit.service');
const NotificationService = require('../src/services/notification.service');
const BonusRewardService = require('../src/services/bonusReward.service');
const { bonusRewardConfig } = require('../src/config/bonusRewards');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

const KEYS = ['ONBOARDING', 'FIRST_ASSESSMENT', 'RENEWAL', 'ANNUAL_UPGRADE', 'PROFESSIONAL_MILESTONE'];
describe('bonus reward lifecycle', () => {
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
  let teacher; let plan;
  beforeEach(async () => {
    await clearDatabase(); jest.restoreAllMocks();
    for (const key of KEYS) { delete process.env[`BONUS_REWARD_${key}_ENABLED`]; delete process.env[`BONUS_REWARD_${key}_AMOUNT`]; }
    plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, billingInterval: 'month', features: { essayAnalysesPerMonth: 10 } });
    teacher = await User.create({ firebaseUid: `bonus-${Date.now()}`, email: `bonus-${Date.now()}@example.test`, role: 'teacher', plan: plan._id });
  });
  function enable(key, amount = 3) { process.env[`BONUS_REWARD_${key}_ENABLED`] = 'true'; process.env[`BONUS_REWARD_${key}_AMOUNT`] = String(amount); }

  test('supported rewards are disabled by default and grant nothing', async () => {
    expect((await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id })).reason).toBe('DISABLED');
    expect(await BonusRewardGrant.countDocuments()).toBe(0); expect(await CreditWallet.countDocuments()).toBe(0);
  });
  test('enabled reward requires an approved positive integer amount', () => {
    process.env.BONUS_REWARD_ONBOARDING_ENABLED = 'true';
    expect(() => bonusRewardConfig()).toThrow(/positive integer/);
  });
  test('onboarding is once per account and ignores caller event keys', async () => {
    enable('ONBOARDING', 4);
    await Promise.all([BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', eventKey: 'forged-a', userId: teacher._id }),
      BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', eventKey: 'forged-b', userId: teacher._id })]);
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(4);
    expect(await CreditTransaction.countDocuments({ userId: teacher._id, type: 'BONUS_REWARD' })).toBe(1);
  });
  test('first assessment reward is once and independent of its source id', async () => {
    enable('FIRST_ASSESSMENT', 2);
    await BonusRewardService.grantConfiguredBonus({ eventType: 'FIRST_SUCCESSFUL_ASSESSMENT', userId: teacher._id, sourceId: 'run-1' });
    await BonusRewardService.grantConfiguredBonus({ eventType: 'FIRST_SUCCESSFUL_ASSESSMENT', userId: teacher._id, sourceId: 'run-2' });
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(2);
  });
  test('repeatable renewal uses one grant per stable billing period', async () => {
    enable('RENEWAL', 2);
    await Promise.all([1, 2].map(() => BonusRewardService.grantConfiguredBonus({ eventType: 'SUBSCRIPTION_RENEWAL',
      eventKey: 'sub-1:2026-09-01', userId: teacher._id, sourceId: 'invoice-1' })));
    await BonusRewardService.grantConfiguredBonus({ eventType: 'SUBSCRIPTION_RENEWAL', eventKey: 'sub-1:2026-10-01', userId: teacher._id });
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(4);
    expect(await BonusRewardGrant.countDocuments()).toBe(2);
  });
  test('annual upgrades and future milestones require their own stable event keys', async () => {
    enable('ANNUAL_UPGRADE', 5); enable('PROFESSIONAL_MILESTONE', 6);
    await BonusRewardService.grantConfiguredBonus({ eventType: 'ANNUAL_UPGRADE', eventKey: 'sub:period', userId: teacher._id });
    await BonusRewardService.grantConfiguredBonus({ eventType: 'PROFESSIONAL_MILESTONE', eventKey: 'milestone:100', userId: teacher._id });
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(11);
  });
  test('wallet and transaction remain exactly once under concurrent calls', async () => {
    enable('FIRST_ASSESSMENT', 5);
    await Promise.all(Array.from({ length: 4 }, () => BonusRewardService.grantConfiguredBonus({ eventType: 'FIRST_SUCCESSFUL_ASSESSMENT', userId: teacher._id })));
    expect(await CreditWallet.findOne({ userId: teacher._id })).toMatchObject({ monthlyCredits: 10, monthlyCreditsUsed: 0, purchasedCredits: 0, bonusCredits: 5 });
    expect(await CreditTransaction.countDocuments({ type: 'BONUS_REWARD' })).toBe(1);
  });
  test('wallet failure is retryable without a false granted state', async () => {
    enable('ONBOARDING', 3); const original = CreditService.adjustBonusCredits;
    jest.spyOn(CreditService, 'adjustBonusCredits').mockRejectedValueOnce(new Error('wallet unavailable'));
    await expect(BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id })).rejects.toThrow('wallet unavailable');
    expect((await BonusRewardGrant.findOne()).status).toBe('FAILED');
    CreditService.adjustBonusCredits.mockImplementation(original);
    await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id });
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(3);
  });
  test('notification failure does not duplicate credit and notification retries once', async () => {
    enable('ONBOARDING', 3); const original = NotificationService.createNotification;
    jest.spyOn(NotificationService, 'createNotification').mockRejectedValueOnce(new Error('notification unavailable'));
    await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id });
    NotificationService.createNotification.mockImplementation(original);
    await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id });
    expect((await CreditWallet.findOne({ userId: teacher._id })).bonusCredits).toBe(3);
    expect(await Notification.countDocuments({ recipient: teacher._id, type: 'bonus_reward' })).toBe(1);
  });
  test('disabled teachers receive no new reward', async () => {
    enable('ONBOARDING'); await User.updateOne({ _id: teacher._id }, { $set: { isActive: false } });
    expect((await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id })).reason).toBe('INELIGIBLE');
  });
  test('monthly reset preserves bonus and purchased balances', async () => {
    enable('ONBOARDING', 3); await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id });
    const wallet = await CreditWallet.findOne({ userId: teacher._id }); await CreditWallet.updateOne({ _id: wallet._id }, { $set: { purchasedCredits: 7, billingCycleEnd: new Date('2020-01-01') } });
    const state = await CreditService.getOrCreateWallet(teacher);
    expect(state.wallet).toMatchObject({ bonusCredits: 3, purchasedCredits: 7, monthlyCreditsUsed: 0 });
  });
  test('reward history is ownership scoped and omits internal keys', async () => {
    enable('ONBOARDING', 3); await BonusRewardService.grantConfiguredBonus({ eventType: 'ONBOARDING_COMPLETION', userId: teacher._id });
    const other = await User.create({ firebaseUid: 'bonus-other', email: 'bonus-other@example.test', role: 'teacher', plan: plan._id });
    expect(await BonusRewardService.rewardHistory(other._id)).toHaveLength(0);
    const history = await BonusRewardService.rewardHistory(teacher._id); expect(history).toHaveLength(1);
    expect(history[0]).not.toHaveProperty('idempotencyKey');
  });
});
