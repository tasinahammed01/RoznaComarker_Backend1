'use strict';
const User = require('../models/user.model');
const BonusRewardGrant = require('../models/BonusRewardGrant');
const NotificationService = require('./notification.service');
const { publishToUser } = require('./notificationRealtime.service');
const RetentionSettings = require('./retentionSettings.service');
const logger = require('../utils/logger');

const COPY = Object.freeze({
  ONBOARDING_COMPLETION: ['Welcome bonus unlocked', 'Your onboarding bonus credits were added to your account.'],
  FIRST_SUCCESSFUL_ASSESSMENT: ['First assessment bonus earned', 'Your first assessment bonus credits were added to your account.'],
  SUBSCRIPTION_RENEWAL: ['Renewal bonus added', 'Your subscription renewal bonus credits were added to your account.'],
  ANNUAL_UPGRADE: ['Annual plan bonus added', 'Your annual plan bonus credits were added to your account.'],
  PROFESSIONAL_MILESTONE: ['Professional milestone reward earned', 'Your milestone bonus credits were added to your account.']
});

function canonicalEventKey(rule, userId, eventKey) {
  if (rule.repeatPolicy === 'ONCE_PER_ACCOUNT') return String(userId);
  const key = String(eventKey || '').trim();
  if (!key) throw Object.assign(new Error('eventKey is required for this repeat policy'), { code: 'BONUS_REWARD_EVENT_KEY_REQUIRED' });
  return key;
}

async function grantConfiguredBonus({ eventType, eventKey, userId, sourceId }) {
  const rule = (await RetentionSettings.getBonusRewardConfig())[eventType];
  logger.info({ event: 'bonus_reward_evaluated', userId: String(userId), eventType });
  if (!rule?.enabled) { logger.info({ event: 'bonus_reward_skipped', userId: String(userId), eventType, reason: 'DISABLED' }); return { granted: false, reason: 'DISABLED' }; }
  const user = await User.findOne({ _id: userId, role: 'teacher', isActive: { $ne: false } }).select('_id').lean();
  if (!user) { logger.info({ event: 'bonus_reward_skipped', userId: String(userId), eventType, reason: 'INELIGIBLE' }); return { granted: false, reason: 'INELIGIBLE' }; }
  const resolvedKey = canonicalEventKey(rule, userId, eventKey);
  const idempotencyKey = `bonus-reward:${eventType}:${userId}:${resolvedKey}`;
  let grant;
  try {
    grant = await BonusRewardGrant.create({ userId, eventType, eventKey: resolvedKey, amount: rule.amount,
      sourceId: sourceId == null ? undefined : String(sourceId), repeatPolicy: rule.repeatPolicy, idempotencyKey });
    logger.info({ event: 'bonus_reward_claimed', userId: String(userId), eventType, rewardGrantId: String(grant._id), amount: rule.amount });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    grant = await BonusRewardGrant.findOne({ idempotencyKey });
    logger.info({ event: 'bonus_reward_retry', userId: String(userId), eventType, rewardGrantId: String(grant?._id) });
  }
  if (grant.creditStatus !== 'GRANTED') {
    if (grant.creditStatus === 'PENDING') grant = await BonusRewardGrant.findOneAndUpdate({ _id: grant._id, creditStatus: 'PENDING' },
      { $set: { creditStatus: 'PROCESSING', failureReason: null } }, { returnDocument: 'after' }) || await BonusRewardGrant.findById(grant._id);
    try {
      await require('./credit.service').adjustBonusCredits({ userId, amount: grant.amount, reason: `${eventType} bonus reward`,
        idempotencyKey: `bonus-reward-credit:${grant._id}`, transactionType: 'BONUS_REWARD', rewardGrantId: grant._id,
        metadata: { eventType, eventKey: resolvedKey, sourceId: grant.sourceId, rewardGrantId: String(grant._id) } });
      grant = await BonusRewardGrant.findByIdAndUpdate(grant._id, { $set: { creditStatus: 'GRANTED', status: 'GRANTED',
        grantedAt: grant.grantedAt || new Date(), failureReason: null } }, { returnDocument: 'after' });
      publishToUser({ userId, event: 'credits_updated', payload: { type: 'bonus_reward', rewardGrantId: String(grant._id), eventType } });
      logger.info({ event: 'bonus_reward_granted', userId: String(userId), eventType, rewardGrantId: String(grant._id), amount: grant.amount });
    } catch (error) {
      await BonusRewardGrant.updateOne({ _id: grant._id, creditStatus: { $ne: 'GRANTED' } }, { $set: { status: 'FAILED', failureReason: String(error?.message || 'Grant failed').slice(0, 500) } });
      logger.error({ event: 'bonus_reward_failed', userId: String(userId), eventType, rewardGrantId: String(grant._id), error: error?.message }); throw error;
    }
  }
  if (grant.notificationStatus !== 'SENT') {
    const [title, description] = COPY[eventType] || ['Bonus reward earned', 'Bonus credits were added to your account.'];
    try {
      await NotificationService.createNotification({ recipientId: userId, type: 'bonus_reward', title, description,
        idempotencyKey: `bonus-reward-notification:${grant._id}`, data: { rewardGrantId: String(grant._id), eventType,
          bonusCredits: grant.amount, route: { path: '/billing/paypal/manage' } } });
      grant = await BonusRewardGrant.findByIdAndUpdate(grant._id, { $set: { notificationStatus: 'SENT' } }, { returnDocument: 'after' });
    } catch (error) { logger.error({ event: 'bonus_reward_notification_failed', userId: String(userId), eventType,
      rewardGrantId: String(grant._id), error: error?.message }); }
  }
  return { granted: true, grant };
}

async function rewardHistory(userId, limit = 20) {
  return BonusRewardGrant.find({ userId, status: 'GRANTED' }).sort({ grantedAt: -1, _id: -1 }).limit(Math.min(50, limit))
    .select('eventType amount grantedAt').lean();
}

module.exports = { grantConfiguredBonus, rewardHistory, canonicalEventKey };
