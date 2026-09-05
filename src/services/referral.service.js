'use strict';

const crypto = require('crypto');
const User = require('../models/user.model');
const Referral = require('../models/Referral');
const CreditTransaction = require('../models/CreditTransaction');
const CreditService = require('./credit.service');
const NotificationService = require('./notification.service');
const { publishToUser } = require('./notificationRealtime.service');
const RetentionSettings = require('./retentionSettings.service');
const logger = require('../utils/logger');

function normalizeReferralCode(value) { return typeof value === 'string' ? value.trim().toUpperCase() : ''; }
function createReferralCode() { return crypto.randomBytes(6).toString('base64url').toUpperCase(); }

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const referralCode = createReferralCode();
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, $or: [{ referralCode: null }, { referralCode: { $exists: false } }] },
        { $set: { referralCode } }, { returnDocument: 'after' });
      if (updated?.referralCode) { user.referralCode = updated.referralCode; return updated.referralCode; }
      const current = await User.findById(user._id).select('referralCode').lean();
      if (current?.referralCode) return current.referralCode;
    } catch (error) { if (error?.code !== 11000) throw error; }
  }
  throw new Error('Failed to allocate referral code');
}

async function ensureReferralRecord(referredUser) {
  if (!referredUser?.referredBy || String(referredUser.referredBy) === String(referredUser._id)) return null;
  const referrer = await User.findById(referredUser.referredBy).select('_id referralCode').lean();
  if (!referrer) return null;
  return Referral.findOneAndUpdate({ referredUserId: referredUser._id }, { $setOnInsert: {
    referrerUserId: referrer._id, referredUserId: referredUser._id, codeUsed: referrer.referralCode,
    status: 'ATTRIBUTED', attributedAt: referredUser.createdAt || new Date(), fraudStatus: 'CLEAR',
    referrerRewardStatus: 'PENDING', referredRewardStatus: 'PENDING'
  } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
}

async function claimReferral(user, rawCode) {
  const code = normalizeReferralCode(rawCode);
  if (user.referredBy) { await ensureReferralRecord(user); return { applied: false }; }
  if (!code || user.role !== 'teacher' || user.isActive === false) return { applied: false };
  const referrer = await User.findOne({ referralCode: code }).select('_id email role isActive referralCode').lean();
  const sameEmail = referrer?.email && user.email && String(referrer.email).trim().toLowerCase() === String(user.email).trim().toLowerCase();
  if (!referrer || referrer.role !== 'teacher' || referrer.isActive === false ||
      String(referrer._id) === String(user._id) || sameEmail) return { applied: false };
  const result = await User.updateOne(
    { _id: user._id, role: 'teacher', isActive: { $ne: false }, $or: [{ referredBy: null }, { referredBy: { $exists: false } }] },
    { $set: { referredBy: referrer._id } });
  if (result.modifiedCount) user.referredBy = referrer._id;
  if (result.modifiedCount || user.referredBy) await ensureReferralRecord(user);
  return { applied: result.modifiedCount === 1 };
}

async function claimReferrerRewardSlot(referral, cap) {
  if (['REWARDED', 'CAPPED'].includes(referral.referrerRewardStatus) || referral.referrerRewardSlot) return referral;
  if (cap == null) {
    const claimed = await Referral.findOneAndUpdate({ _id: referral._id, referrerRewardStatus: 'PENDING' },
      { $set: { referrerRewardStatus: 'PROCESSING' } }, { returnDocument: 'after' });
    return claimed || Referral.findById(referral._id);
  }
  for (let slot = 1; slot <= cap; slot += 1) {
    try {
      const claimed = await Referral.findOneAndUpdate({ _id: referral._id, referrerRewardStatus: 'PENDING',
        referrerRewardSlot: { $exists: false } }, { $set: { referrerRewardSlot: slot,
          referrerRewardStatus: 'PROCESSING' } }, { returnDocument: 'after' });
      if (claimed) return claimed;
      return Referral.findById(referral._id);
    } catch (error) { if (error?.code !== 11000) throw error; }
  }
  return Referral.findOneAndUpdate({ _id: referral._id, referrerRewardStatus: 'PENDING',
    referrerRewardSlot: { $exists: false } }, { $set: { referrerRewardStatus: 'CAPPED' } },
  { returnDocument: 'after' }) || Referral.findById(referral._id);
}

async function rewardSide({ referral, side, userId, amount, transactionType, title, description }) {
  const statusField = `${side}RewardStatus`;
  if (referral[statusField] === 'CAPPED') return referral;
  if (referral[statusField] === 'PENDING') {
    referral = await Referral.findOneAndUpdate({ _id: referral._id, [statusField]: 'PENDING' },
      { $set: { [statusField]: 'PROCESSING' } }, { returnDocument: 'after' }) || await Referral.findById(referral._id);
  }
  const idempotencyKey = `referral:${referral.referredUserId}:${side}`;
  let transaction;
  if (referral[statusField] === 'PROCESSING') {
    transaction = await CreditService.adjustBonusCredits({ userId, amount,
      reason: side === 'referrer' ? 'Qualified referral reward' : 'Referred account activation reward',
      idempotencyKey, transactionType, referralId: referral._id,
      metadata: { referralId: String(referral._id), referrerUserId: String(referral.referrerUserId),
        referredUserId: String(referral.referredUserId), qualificationType: referral.qualificationType,
        qualificationId: referral.qualificationId }
    });
    referral = await Referral.findByIdAndUpdate(referral._id, { $set: {
      [statusField]: 'REWARDED', [`${side}RewardCredits`]: amount
    } }, { returnDocument: 'after' });
  } else if (referral[statusField] === 'REWARDED') {
    transaction = await CreditTransaction.findOne({ idempotencyKey });
  } else return referral;
  await NotificationService.createNotification({ recipientId: userId, type: 'referral_reward', title, description,
    idempotencyKey: `referral-notification:${referral._id}:${side}`,
    data: { referralId: String(referral._id), rewardSide: side, bonusCredits: amount,
      route: { path: '/billing/paypal/manage' } }
  });
  publishToUser({ userId, event: 'credits_updated', payload: {
    type: 'referral_reward', referralId: String(referral._id), transactionId: String(transaction._id)
  } });
  return referral;
}

async function qualifyReferral({ referredUserId, qualificationId, qualificationType }) {
  const config = await RetentionSettings.getReferralConfig();
  const referred = await User.findById(referredUserId).select('_id referredBy role isActive createdAt').lean();
  if (!referred?.referredBy) return { qualified: false, reason: 'NO_REFERRAL' };
  let referral = await ensureReferralRecord(referred);
  if (!referral) return { qualified: false, reason: 'REFERRER_NOT_FOUND' };
  const referrer = await User.findById(referral.referrerUserId).select('_id role isActive').lean();
  const unsafe = String(referral.referrerUserId) === String(referred._id) || referred.role !== 'teacher' ||
    referrer?.role !== 'teacher' || referred.isActive === false || referrer?.isActive === false;
  if (unsafe) {
    const status = referred.isActive === false || !referrer || referrer.isActive === false ? 'REJECTED' : 'REVIEW_REQUIRED';
    await Referral.updateOne({ _id: referral._id, status: 'ATTRIBUTED' }, { $set: { status,
      fraudStatus: status === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'CLEAR',
      reviewReason: status === 'REVIEW_REQUIRED' ? 'INELIGIBLE_PARTICIPANTS' : 'INACTIVE_PARTICIPANT' } });
    return { qualified: false, reason: status };
  }
  const resolvedType = qualificationType || config.qualificationType;
  referral = await Referral.findOneAndUpdate({ _id: referral._id, status: 'ATTRIBUTED' }, { $set: {
    status: 'QUALIFIED', qualifiedAt: new Date(), qualificationType: resolvedType,
    qualificationId: String(qualificationId || '')
  } }, { returnDocument: 'after' }) || await Referral.findById(referral._id);
  if (!['QUALIFIED', 'REWARDED'].includes(referral.status)) return { qualified: false, reason: referral.status };
  if (referral.status === 'REWARDED') return { qualified: true, referral };

  referral = await claimReferrerRewardSlot(referral, config.maxRewardedReferralsPerReferrer);
  if (referral.referrerRewardStatus !== 'CAPPED') {
    referral = await rewardSide({ referral, side: 'referrer', userId: referral.referrerUserId,
      amount: config.referrerRewardCredits, transactionType: 'REFERRAL_REFERRER_BONUS',
      title: 'Referral reward earned', description: `Your referral qualified. ${config.referrerRewardCredits} bonus credits were added to your account.` });
  }
  referral = await rewardSide({ referral, side: 'referred', userId: referral.referredUserId,
    amount: config.referredRewardCredits, transactionType: 'REFERRAL_REFERRED_BONUS',
    title: 'Referral bonus unlocked', description: `You earned ${config.referredRewardCredits} bonus credits through a referral.` });
  if (referral.referredRewardStatus === 'REWARDED' && ['REWARDED', 'CAPPED'].includes(referral.referrerRewardStatus)) {
    referral = await Referral.findByIdAndUpdate(referral._id, { $set: { status: 'REWARDED',
      rewardedAt: referral.rewardedAt || new Date() } }, { returnDocument: 'after' });
  }
  logger.info({ event: 'referral_reward_processed', referralId: String(referral._id),
    referrerUserId: String(referral.referrerUserId), referredUserId: String(referral.referredUserId),
    status: referral.status, referrerRewardStatus: referral.referrerRewardStatus,
    referredRewardStatus: referral.referredRewardStatus });
  await require('./professionalMilestone.service').evaluateProfessionalMilestonesSafely(
    referral.referrerUserId, ['QUALIFIED_REFERRALS']);
  return { qualified: true, referral };
}

async function referralSummary(user) {
  const config = await RetentionSettings.getReferralConfig();
  const code = await ensureReferralCode(user);
  const [attributed, grouped, earned, recent] = await Promise.all([
    User.countDocuments({ referredBy: user._id }),
    Referral.aggregate([{ $match: { referrerUserId: user._id } }, { $group: { _id: null,
      qualified: { $sum: { $cond: [{ $in: ['$status', ['QUALIFIED', 'REWARDED']] }, 1, 0] } },
      rewarded: { $sum: { $cond: [{ $eq: ['$status', 'REWARDED'] }, 1, 0] } },
      reviewRequired: { $sum: { $cond: [{ $eq: ['$status', 'REVIEW_REQUIRED'] }, 1, 0] } }
    } }]),
    CreditTransaction.aggregate([{ $match: { userId: user._id, type: 'REFERRAL_REFERRER_BONUS', status: 'committed' } },
      { $group: { _id: null, credits: { $sum: '$amount' } } }]),
    Referral.find({ referrerUserId: user._id }).sort({ createdAt: -1 }).limit(10)
      .populate('referredUserId', 'displayName').lean()
  ]);
  const counts = grouped[0] || {};
  return { code, count: attributed, attributed, qualified: counts.qualified || 0,
    rewarded: counts.rewarded || 0, pending: Math.max(0, attributed - (counts.qualified || 0)),
    reviewRequired: counts.reviewRequired || 0, bonusCreditsEarned: earned[0]?.credits || 0,
    rewardCreditsEach: config.referrerRewardCredits,
    ...(config.maxRewardedReferralsPerReferrer == null ? {} : { cap: config.maxRewardedReferralsPerReferrer }),
    referrals: recent.map((item) => ({ id: String(item._id), name: item.referredUserId?.displayName || 'Teacher',
      status: item.status, date: item.qualifiedAt || item.attributedAt }))
  };
}

module.exports = { normalizeReferralCode, ensureReferralCode, ensureReferralRecord, claimReferral,
  qualifyReferral, referralSummary, claimReferrerRewardSlot, rewardSide };
