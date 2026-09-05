'use strict';

const CreditWallet = require('../models/CreditWallet');
const NotificationService = require('./notification.service');
const logger = require('../utils/logger');

const THRESHOLDS = [50, 80, 100];

function cycleKeyFor(wallet) {
  const start = new Date(wallet.billingCycleStart);
  const end = new Date(wallet.billingCycleEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Credit wallet has no valid billing cycle');
  return `${start.toISOString()}_${end.toISOString()}`;
}

function snapshot(wallet) {
  const monthlyAllowance = Math.max(0, Number(wallet.monthlyCredits) || 0);
  const monthlyUsed = Math.min(monthlyAllowance, Math.max(0, Number(wallet.monthlyCreditsUsed) || 0));
  const monthlyRemaining = Math.max(0, monthlyAllowance - monthlyUsed);
  const additionalCreditsRemaining = Math.max(0, Number(wallet.purchasedCredits) || 0) +
    Math.max(0, Number(wallet.bonusCredits) || 0);
  return { monthlyAllowance, monthlyUsed, monthlyRemaining, additionalCreditsRemaining };
}

function notificationCopy(threshold, usage) {
  const route = { path: '/billing/paypal/manage' };
  if (threshold === 50) return {
    title: 'Half of your monthly credits used',
    description: `You've used ${usage.monthlyUsed} of ${usage.monthlyAllowance} monthly assessment credits. You have ${usage.monthlyRemaining} monthly credits remaining.`,
    actionLabel: 'View usage', route
  };
  if (threshold === 80) return {
    title: '80% of monthly credits used',
    description: `You've used ${usage.monthlyUsed} of ${usage.monthlyAllowance} monthly assessment credits. ${usage.monthlyRemaining} monthly credits remain.`,
    actionLabel: 'Add credits', route
  };
  if (usage.additionalCreditsRemaining > 0) return {
    title: 'Monthly credits fully used',
    description: `You've used all ${usage.monthlyAllowance} monthly plan credits. Future assessments will use your additional credits.`,
    actionLabel: 'View usage', route
  };
  return {
    title: 'All assessment credits used',
    description: "You've used all available assessment credits for this cycle.",
    actionLabel: 'Add credits', route
  };
}

async function currentCycleState(wallet, cycleKey) {
  if (wallet.usageNudges?.cycleKey === cycleKey) return wallet;
  await CreditWallet.updateOne({ _id: wallet._id, billingCycleStart: wallet.billingCycleStart,
    'usageNudges.cycleKey': { $ne: cycleKey } }, { $set: { usageNudges: {
      cycleKey, handledThresholds: [], updatedAt: new Date()
    } } });
  return CreditWallet.findById(wallet._id);
}

async function evaluateCreditUsageNudge({ userId, beforeWallet, afterWallet, transaction }) {
  if (!afterWallet || transaction?.status !== 'committed' || transaction?.type !== 'ASSESSMENT_DEBIT') return null;
  const cycleKey = cycleKeyFor(afterWallet);
  const usage = snapshot(afterWallet);
  const before = beforeWallet ? snapshot(beforeWallet) : null;
  logger.info({ event: 'credit_usage_threshold_evaluated', userId: String(userId), cycleKey,
    monthlyAllowance: usage.monthlyAllowance, monthlyRemaining: usage.monthlyRemaining,
    previousMonthlyRemaining: before?.monthlyRemaining });
  if (usage.monthlyAllowance <= 0) return null;

  const current = await currentCycleState(afterWallet, cycleKey);
  const handled = new Set((current?.usageNudges?.handledThresholds || []).map(Number));
  const configured = (await require('./retentionSettings.service').getCreditNudgeConfig()).thresholds || THRESHOLDS;
  const crossedAndUnsent = configured.filter((threshold) =>
    usage.monthlyUsed * 100 >= usage.monthlyAllowance * threshold && !handled.has(threshold));
  const threshold = crossedAndUnsent.at(-1);
  if (!threshold) {
    logger.info({ event: 'credit_usage_nudge_skipped', userId: String(userId), cycleKey,
      monthlyAllowance: usage.monthlyAllowance, monthlyRemaining: usage.monthlyRemaining });
    return null;
  }

  const idempotencyKey = `credit-usage:${userId}:${cycleKey}:${threshold}`;
  logger.info({ event: 'credit_usage_nudge_claimed', userId: String(userId), threshold, cycleKey,
    monthlyAllowance: usage.monthlyAllowance, monthlyRemaining: usage.monthlyRemaining });
  try {
    const copy = notificationCopy(threshold, usage);
    const notification = await NotificationService.createNotification({ recipientId: userId, type: 'credit_usage_nudge',
      title: copy.title, description: copy.description, idempotencyKey, data: {
        threshold, cycleKey, ...usage, actionLabel: copy.actionLabel, route: copy.route
      } });
    await CreditWallet.updateOne({ _id: afterWallet._id, billingCycleStart: afterWallet.billingCycleStart,
      'usageNudges.cycleKey': cycleKey }, { $addToSet: {
        'usageNudges.handledThresholds': { $each: crossedAndUnsent }
      }, $set: { 'usageNudges.updatedAt': new Date() } });
    logger.info({ event: 'credit_usage_nudge_sent', userId: String(userId), threshold, cycleKey,
      monthlyAllowance: usage.monthlyAllowance, monthlyRemaining: usage.monthlyRemaining });
    return notification;
  } catch (error) {
    logger.error({ event: 'credit_usage_nudge_failed', userId: String(userId), threshold, cycleKey,
      monthlyAllowance: usage.monthlyAllowance, monthlyRemaining: usage.monthlyRemaining, error: error?.message });
    throw error;
  }
}

module.exports = { THRESHOLDS, cycleKeyFor, snapshot, notificationCopy, evaluateCreditUsageNudge };
