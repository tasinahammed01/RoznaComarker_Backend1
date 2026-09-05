'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'referral-test-secret';

const User = require('../src/models/user.model');
const Plan = require('../src/models/Plan');
const Referral = require('../src/models/Referral');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const Notification = require('../src/models/notification.model');
const CreditService = require('../src/services/credit.service');
const NotificationService = require('../src/services/notification.service');
const ReferralService = require('../src/services/referral.service');
const { ensureReferralCode, claimReferral, referralSummary, qualifyReferral } = ReferralService;
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('referral attribution', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  let freePlan;
  beforeEach(async () => {
    await clearDatabase(); jest.restoreAllMocks();
    delete process.env.REFERRAL_MAX_REWARDED_LIFETIME;
    freePlan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, billingInterval: 'month',
      features: { essayAnalysesPerMonth: 10 } });
  });

  async function user(suffix) {
    return User.create({ firebaseUid: `ref-${suffix}`, email: `ref-${suffix}@example.test`, role: 'teacher', plan: freePlan._id });
  }

  async function attributed(suffix = 'pair') {
    const referrer = await user(`${suffix}-owner`); const referred = await user(`${suffix}-referred`);
    await claimReferral(referred, await ensureReferralCode(referrer));
    return { referrer, referred, referral: await Referral.findOne({ referredUserId: referred._id }) };
  }

  test('codes are stable and unique and attribution is write-once', async () => {
    const referrer = await user('owner'); const invitee = await user('invitee'); const other = await user('other');
    const code = await ensureReferralCode(referrer);
    expect(await ensureReferralCode(referrer)).toBe(code);
    expect(await ensureReferralCode(other)).not.toBe(code);
    expect((await claimReferral(invitee, code)).applied).toBe(true);
    expect((await claimReferral(invitee, await ensureReferralCode(other))).applied).toBe(false);
    expect((await referralSummary(referrer)).count).toBe(1);
  });

  test('self and invalid referrals are ignored and never reward', async () => {
    const teacher = await user('self'); const code = await ensureReferralCode(teacher);
    expect((await claimReferral(teacher, code)).applied).toBe(false);
    expect((await claimReferral(teacher, 'NOT-A-CODE')).applied).toBe(false);
    expect((await User.findById(teacher._id)).referredBy).toBeNull();
  });

  test('case-insensitive valid code creates one lifecycle attribution', async () => {
    const owner = await user('case-owner'); const invitee = await user('case-invitee');
    const result = await claimReferral(invitee, (await ensureReferralCode(owner)).toLowerCase());
    expect(result.applied).toBe(true);
    expect(await Referral.countDocuments({ referrerUserId: owner._id, referredUserId: invitee._id })).toBe(1);
  });

  test('an invalid code leaves signup state intact and creates no lifecycle record', async () => {
    const invitee = await user('invalid');
    await expect(claimReferral(invitee, 'MISSING-CODE')).resolves.toEqual({ applied: false });
    expect(await Referral.countDocuments()).toBe(0);
  });

  test('same-email self referral is rejected without invasive identity matching', async () => {
    const owner = await user('email-owner'); const invitee = await user('email-invitee');
    invitee.email = owner.email;
    expect((await claimReferral(invitee, await ensureReferralCode(owner))).applied).toBe(false);
  });

  test('existing attribution cannot be overwritten in the lifecycle record', async () => {
    const { referred, referral } = await attributed('immutable'); const other = await user('immutable-other');
    await claimReferral(referred, await ensureReferralCode(other));
    expect(String((await Referral.findById(referral._id)).referrerUserId)).toBe(String(referral.referrerUserId));
  });

  test('account creation and attribution alone grant no reward', async () => {
    const { referrer, referred } = await attributed('no-early');
    expect(await CreditWallet.countDocuments({ userId: { $in: [referrer._id, referred._id] } })).toBe(0);
    expect(await CreditTransaction.countDocuments({ type: /^REFERRAL_/ })).toBe(0);
  });

  test('first successful assessment qualification rewards both sides with five bonus credits', async () => {
    const { referrer, referred } = await attributed('reward');
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'assessment-1' });
    expect((await CreditWallet.findOne({ userId: referrer._id })).bonusCredits).toBe(5);
    expect((await CreditWallet.findOne({ userId: referred._id })).bonusCredits).toBe(5);
  });

  test('qualification persists the first successful assessment identity and timestamp', async () => {
    const { referred } = await attributed('qualify');
    const result = await qualifyReferral({ referredUserId: referred._id, qualificationId: 'run-first' });
    expect(result.referral).toMatchObject({ status: 'REWARDED', qualificationType: 'FIRST_SUCCESSFUL_AI_ASSESSMENT',
      qualificationId: 'run-first' });
    expect(result.referral.qualifiedAt).toBeInstanceOf(Date);
  });

  test('both reward transactions are committed and audit the referral', async () => {
    const { referred, referral } = await attributed('audit');
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'run-audit' });
    const tx = await CreditTransaction.find({ referralId: referral._id }).sort({ type: 1 }).lean();
    expect(tx.map((item) => item.type).sort()).toEqual(['REFERRAL_REFERRED_BONUS', 'REFERRAL_REFERRER_BONUS']);
    expect(tx.every((item) => item.amount === 5 && item.metadata.qualificationId === 'run-audit')).toBe(true);
  });

  test('repeated qualifying assessments cannot duplicate either reward', async () => {
    const { referred } = await attributed('repeat');
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'run-1' });
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'run-2' });
    expect(await CreditTransaction.countDocuments({ type: /^REFERRAL_/ })).toBe(2);
  });

  test('concurrent qualification calls grant each reward exactly once', async () => {
    const { referred } = await attributed('concurrent');
    await Promise.all(Array.from({ length: 4 }, (_, index) => qualifyReferral({
      referredUserId: referred._id, qualificationId: `run-${index}` })));
    expect(await CreditTransaction.countDocuments({ type: 'REFERRAL_REFERRER_BONUS' })).toBe(1);
    expect(await CreditTransaction.countDocuments({ type: 'REFERRAL_REFERRED_BONUS' })).toBe(1);
  });

  test('partial reward failure retries only the missing side', async () => {
    const { referrer, referred } = await attributed('partial');
    const original = CreditService.adjustBonusCredits;
    jest.spyOn(CreditService, 'adjustBonusCredits').mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('referred wallet unavailable'));
    await expect(qualifyReferral({ referredUserId: referred._id, qualificationId: 'partial-run' })).rejects.toThrow();
    expect((await CreditWallet.findOne({ userId: referrer._id })).bonusCredits).toBe(5);
    CreditService.adjustBonusCredits.mockImplementation(original);
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'retry-run' });
    expect((await CreditWallet.findOne({ userId: referrer._id })).bonusCredits).toBe(5);
    expect((await CreditWallet.findOne({ userId: referred._id })).bonusCredits).toBe(5);
  });

  test('referrer-side idempotency prevents a second wallet mutation', async () => {
    const { referrer, referred } = await attributed('referrer-idem');
    await Promise.all([qualifyReferral({ referredUserId: referred._id, qualificationId: 'a' }),
      qualifyReferral({ referredUserId: referred._id, qualificationId: 'b' })]);
    expect((await CreditWallet.findOne({ userId: referrer._id })).bonusCredits).toBe(5);
  });

  test('referred-side idempotency prevents a second wallet mutation', async () => {
    const { referred } = await attributed('referred-idem');
    await Promise.all([qualifyReferral({ referredUserId: referred._id, qualificationId: 'a' }),
      qualifyReferral({ referredUserId: referred._id, qualificationId: 'b' })]);
    expect((await CreditWallet.findOne({ userId: referred._id })).bonusCredits).toBe(5);
  });

  test('reward notifications use stable keys and are not duplicated', async () => {
    const { referred } = await attributed('notify');
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'notify-1' });
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'notify-2' });
    const notifications = await Notification.find({ type: 'referral_reward' }).lean();
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((item) => item.idempotencyKey)).size).toBe(2);
  });

  test('a notification failure is recoverable without duplicating credits', async () => {
    const { referrer, referred } = await attributed('notify-retry');
    const original = NotificationService.createNotification;
    jest.spyOn(NotificationService, 'createNotification').mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(qualifyReferral({ referredUserId: referred._id, qualificationId: 'notify-fail' })).rejects.toThrow();
    NotificationService.createNotification.mockImplementation(original);
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'notify-retry' });
    expect((await CreditWallet.findOne({ userId: referrer._id })).bonusCredits).toBe(5);
    expect(await Notification.countDocuments({ type: 'referral_reward' })).toBe(2);
  });

  test('referral bonus survives monthly reset', async () => {
    const { referred } = await attributed('reset'); await qualifyReferral({ referredUserId: referred._id, qualificationId: 'reset-run' });
    const current = await CreditWallet.findOne({ userId: referred._id });
    await CreditWallet.updateOne({ _id: current._id }, { $set: { monthlyCreditsUsed: 10, billingCycleEnd: new Date('2020-01-01') } });
    expect((await CreditService.getOrCreateWallet(referred._id)).wallet.bonusCredits).toBe(5);
  });

  test('rewards do not alter monthly or purchased balances', async () => {
    const { referred } = await attributed('buckets');
    const state = await CreditService.getOrCreateWallet(referred);
    await CreditWallet.updateOne({ _id: state.wallet._id }, { $set: { monthlyCreditsUsed: 3, purchasedCredits: 7 } });
    await qualifyReferral({ referredUserId: referred._id, qualificationId: 'bucket-run' });
    expect(await CreditWallet.findById(state.wallet._id)).toMatchObject({ monthlyCreditsUsed: 3, purchasedCredits: 7, bonusCredits: 5 });
  });

  test('normal wallet consumption order remains monthly then purchased then referral bonus', async () => {
    const { referred } = await attributed('consume'); await qualifyReferral({ referredUserId: referred._id, qualificationId: 'consume-qualify' });
    const wallet = await CreditWallet.findOne({ userId: referred._id });
    await CreditWallet.updateOne({ _id: wallet._id }, { $set: { monthlyCreditsUsed: 9, purchasedCredits: 1 } });
    await CreditService.consumeAssessmentCredit({ userId: referred._id, submissionId: new (require('mongoose').Types.ObjectId)(), assessmentId: 'monthly' });
    await CreditService.consumeAssessmentCredit({ userId: referred._id, submissionId: new (require('mongoose').Types.ObjectId)(), assessmentId: 'purchased' });
    const final = await CreditWallet.findById(wallet._id);
    expect(final).toMatchObject({ monthlyCreditsUsed: 10, purchasedCredits: 0, bonusCredits: 5 });
  });

  test('configured lifetime cap of two atomically suppresses the third referrer reward', async () => {
    process.env.REFERRAL_MAX_REWARDED_LIFETIME = '2';
    const first = await attributed('cap-first');
    const secondReferred = await user('cap-second-referred');
    const thirdReferred = await user('cap-third-referred');
    await claimReferral(secondReferred, await ensureReferralCode(first.referrer));
    await claimReferral(thirdReferred, await ensureReferralCode(first.referrer));
    await Promise.all([qualifyReferral({ referredUserId: first.referred._id, qualificationId: 'cap-1' }),
      qualifyReferral({ referredUserId: secondReferred._id, qualificationId: 'cap-2' }),
      qualifyReferral({ referredUserId: thirdReferred._id, qualificationId: 'cap-3' })]);
    expect(await CreditTransaction.countDocuments({ userId: first.referrer._id, type: 'REFERRAL_REFERRER_BONUS' })).toBe(2);
    expect(await Referral.countDocuments({ referrerUserId: first.referrer._id, referrerRewardStatus: 'CAPPED' })).toBe(1);
  });

  test('a referred teacher still receives five credits when the referrer is capped', async () => {
    process.env.REFERRAL_MAX_REWARDED_LIFETIME = '1';
    const first = await attributed('cap-user-first'); await qualifyReferral({ referredUserId: first.referred._id, qualificationId: 'first' });
    const second = await user('cap-user-second'); await claimReferral(second, await ensureReferralCode(first.referrer));
    await qualifyReferral({ referredUserId: second._id, qualificationId: 'second' });
    expect((await CreditWallet.findOne({ userId: second._id })).bonusCredits).toBe(5);
    expect((await Referral.findOne({ referredUserId: second._id })).referrerRewardStatus).toBe('CAPPED');
  });

  test('no configured cap leaves referrals unlimited and omits cap from the summary', async () => {
    const first = await attributed('uncapped-first');
    const referredUsers = [first.referred];
    for (let index = 2; index <= 11; index += 1) {
      const referred = await user(`uncapped-${index}`);
      await claimReferral(referred, await ensureReferralCode(first.referrer));
      referredUsers.push(referred);
    }
    for (const [index, referred] of referredUsers.entries()) {
      await qualifyReferral({ referredUserId: referred._id, qualificationId: `uncapped-${index + 1}` });
    }
    expect(await CreditTransaction.countDocuments({ userId: first.referrer._id, type: 'REFERRAL_REFERRER_BONUS' })).toBe(11);
    expect(await Referral.countDocuments({ referrerUserId: first.referrer._id, referrerRewardStatus: 'CAPPED' })).toBe(0);
    expect(await CreditTransaction.countDocuments({ type: 'REFERRAL_REFERRED_BONUS' })).toBe(11);
    expect(await referralSummary(first.referrer)).not.toHaveProperty('cap');
  });

  test('referral summary is ownership-scoped and exposes no email addresses', async () => {
    const { referrer, referred } = await attributed('summary'); await qualifyReferral({ referredUserId: referred._id, qualificationId: 'summary-run' });
    const foreign = await user('summary-foreign'); const own = await referralSummary(referrer); const other = await referralSummary(foreign);
    expect(own).toMatchObject({ attributed: 1, qualified: 1, rewarded: 1, pending: 0, bonusCreditsEarned: 5 });
    expect(JSON.stringify(own)).not.toContain('@'); expect(other.attributed).toBe(0);
  });

  test('disabled unqualified referred account is rejected and receives no reward', async () => {
    const { referred } = await attributed('disabled'); await User.updateOne({ _id: referred._id }, { $set: { isActive: false } });
    const result = await qualifyReferral({ referredUserId: referred._id, qualificationId: 'disabled-run' });
    expect(result).toMatchObject({ qualified: false, reason: 'REJECTED' });
    expect(await CreditTransaction.countDocuments({ type: /^REFERRAL_/ })).toBe(0);
  });

  test('student and admin accounts are ineligible participants', async () => {
    const owner = await user('role-owner'); const student = await User.create({ firebaseUid: 'ref-role-student',
      email: 'ref-role-student@example.test', role: 'student', plan: freePlan._id });
    expect((await claimReferral(student, await ensureReferralCode(owner))).applied).toBe(false);
    expect(await Referral.countDocuments()).toBe(0);
  });

  test('failed or missing qualification activity does not invoke reward processing', async () => {
    const { referred } = await attributed('failed-activity');
    expect((await Referral.findOne({ referredUserId: referred._id })).status).toBe('ATTRIBUTED');
    expect(await CreditTransaction.countDocuments({ type: /^REFERRAL_/ })).toBe(0);
  });
});
