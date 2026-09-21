const mongoose = require('mongoose');
const CreditWallet = require('../models/CreditWallet');
const CreditTransaction = require('../models/CreditTransaction');
const User = require('../models/user.model');
const { ensureActivePlan } = require('../middlewares/usage.middleware');
const logger = require('../utils/logger');
const { evaluateCreditUsageNudge } = require('./creditUsageNudge.service');

const DAY = 24 * 60 * 60 * 1000;
const insufficient = () => Object.assign(new Error('You have used all your Assessment Credits for this billing cycle.'), {
  statusCode: 403, code: 'INSUFFICIENT_ASSESSMENT_CREDITS'
});
const available = (wallet) => Math.max(Number(wallet.monthlyCredits) - Number(wallet.monthlyCreditsUsed), 0) +
  Number(wallet.purchasedCredits || 0) + Number(wallet.bonusCredits);

function cycleFor(user, plan, now = new Date(), wallet) {
  // The allowance is monthly even when PayPal bills annually. A persisted wallet
  // anchor remains stable through plan changes and ignores historical Stripe dates.
  const raw = wallet?.allowanceCycleAnchor || wallet?.billingCycleStart || user.planStartedAt || user.createdAt || now;
  let anchor = new Date(raw);
  if (!Number.isFinite(anchor.getTime()) || anchor > now) anchor = new Date(now);
  const boundary = offset => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(anchor.getUTCMonth() + offset);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    return date;
  };
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (boundary(months) > now) months -= 1;
  return { start: boundary(months), end: boundary(months + 1), anchor };
}

function allowance(plan) {
  const value = plan?.features?.essayAnalysesPerMonth;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

async function getUser(userOrId) {
  if (userOrId && userOrId._id && typeof userOrId.role !== 'undefined') return userOrId;
  const user = await User.findById(userOrId);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  return user;
}

async function getOrCreateWallet(userOrId) {
  const user = await getUser(userOrId);
  if (user.role !== 'teacher') throw Object.assign(new Error('Credit wallets are available to teachers only'), { statusCode: 403 });
  const plan = await ensureActivePlan(user);
  const now = new Date(); const cycle = cycleFor(user, plan, now); const monthlyCredits = allowance(plan);
  let wallet = await CreditWallet.findOneAndUpdate({ userId: user._id }, { $setOnInsert: {
    userId: user._id, monthlyCredits, monthlyCreditsUsed: 0, purchasedCredits: 0, bonusCredits: 0,
    billingCycleStart: cycle.start, billingCycleEnd: cycle.end, lastCreditReset: cycle.start, allowanceCycleAnchor: cycle.anchor
  } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (wallet.createdAt && wallet.createdAt.getTime() === wallet.updatedAt.getTime()) logger.info({ event: 'credit.wallet.created', userId: String(user._id) });
  wallet = await resetMonthlyCreditsIfNeeded(user, plan, wallet, now);
  return { user, plan, wallet };
}

async function resetMonthlyCreditsIfNeeded(user, plan, wallet, now = new Date()) {
  if (!wallet.allowanceCycleAnchor) {
    const initialCycle = cycleFor(user, plan, now, wallet);
    await CreditWallet.updateOne({ _id: wallet._id, allowanceCycleAnchor: { $exists: false } },
      { $set: { allowanceCycleAnchor: initialCycle.anchor } });
    wallet = await CreditWallet.findById(wallet._id);
  }
  // Recompute after loading the persisted anchor: another reader may have reset.
  const cycle = cycleFor(user, plan, now, wallet); const nextAllowance = allowance(plan);
  const expired = new Date(wallet.billingCycleEnd) <= now || new Date(wallet.billingCycleStart) < cycle.start;
  const changed = Number(wallet.monthlyCredits) !== nextAllowance;
  if (!expired && !changed) {
    if (new Date(wallet.billingCycleEnd).getTime() !== cycle.end.getTime()) {
      return await CreditWallet.findOneAndUpdate({ _id: wallet._id, updatedAt: wallet.updatedAt },
        { $set: { billingCycleEnd: cycle.end } }, { new: true }) || await CreditWallet.findById(wallet._id);
    }
    return wallet;
  }
  const cycleKey = `${cycle.start.toISOString()}_${cycle.end.toISOString()}`;
  const set = expired ? { monthlyCredits: nextAllowance, monthlyCreditsUsed: 0, billingCycleStart: cycle.start,
    billingCycleEnd: cycle.end, lastCreditReset: now, nudgeCycleStart: cycle.start, nudge80AcknowledgedAt: null,
    usageNudges: { cycleKey, handledThresholds: [], updatedAt: now } } : { monthlyCredits: nextAllowance };
  const updated = await CreditWallet.findOneAndUpdate({ _id: wallet._id, updatedAt: wallet.updatedAt }, { $set: set }, { new: true });
  if (!updated) return CreditWallet.findById(wallet._id);
  const key = expired ? `monthly-reset:${user._id}:${cycle.start.toISOString()}` : `allowance-change:${user._id}:${nextAllowance}:${cycle.start.toISOString()}`;
  await CreditTransaction.updateOne({ idempotencyKey: key }, { $setOnInsert: { userId: user._id,
    type: expired ? 'MONTHLY_RESET' : 'PLAN_ALLOWANCE_CHANGE', amount: 0, balanceAfter: available(updated),
    reason: expired ? 'Monthly credit reset' : 'Plan allowance change', idempotencyKey: key,
    metadata: { plan: plan.slug || plan.name } } }, { upsert: true });
  logger.info({ event: expired ? 'credit.monthly_reset' : 'credit.plan_allowance_change', userId: String(user._id), remainingCredits: available(updated) });
  return updated;
}

async function canRunAssessment(userOrId) {
  const state = await getOrCreateWallet(userOrId); const count = available(state.wallet);
  logger.info({ event: 'credit.assessment.checked', userId: String(state.user._id), remainingCredits: count });
  return { ...state, availableCredits: count, allowed: count >= 1 };
}

async function consumeAssessmentCredit({ userId, submissionId, assignmentId, assessmentId, reason = 'AI Assessment' }) {
  const state = await getOrCreateWallet(userId);
  const result = await require('./durableCreditMutation.service').mutate({
    walletId: state.wallet._id,
    entry: { userId, type: 'ASSESSMENT_DEBIT', amount: -1, reason, submissionId, assignmentId, assessmentId,
      idempotencyKey: `assessment:${submissionId}:${assessmentId}` },
    available,
    decide(wallet) {
      if (available(wallet) < 1) throw insufficient();
      if (wallet.monthlyCreditsUsed < wallet.monthlyCredits) return { increments: { monthlyCreditsUsed: 1 }, bucket: 'monthly' };
      if (wallet.purchasedCredits > 0) return { increments: { purchasedCredits: -1 }, bucket: 'purchased' };
      return { increments: { bonusCredits: -1 }, bucket: 'bonus' };
    }
  });
  if (result.transaction?.status === 'committed') {
    try {
      await evaluateCreditUsageNudge({ userId, beforeWallet: result.beforeWallet,
        afterWallet: result.afterWallet || await CreditWallet.findById(state.wallet._id), transaction: result.transaction });
    } catch (error) {
      logger.error({ event: 'credit_usage_nudge_failed', userId: String(userId), error: error?.message });
    }
  }
  return result;
}

async function adjustBonusCredits({ userId, amount, reason, idempotencyKey, actorId, metadata = {}, transactionType, referralId, rewardGrantId }) {
  if (!Number.isInteger(amount) || amount === 0) throw Object.assign(new Error('amount must be a non-zero integer'), { statusCode: 400 });
  if (!reason || !String(reason).trim()) throw Object.assign(new Error('reason is required'), { statusCode: 400 });
  const state = await getOrCreateWallet(userId);
  const result = await require('./durableCreditMutation.service').mutate({
    walletId: state.wallet._id, available,
    entry: { userId, amount, reason: String(reason).trim(), idempotencyKey, referralId, rewardGrantId,
      type: transactionType || (actorId ? (amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT') : 'BONUS_CREDIT'),
      metadata: { ...metadata, ...(actorId ? { adminActorId: String(actorId) } : {}) } },
    decide(wallet) {
      if (amount > 0) return { increments: { bonusCredits: amount }, bucket: 'bonus' };
      const monthly = Math.max(wallet.monthlyCredits - wallet.monthlyCreditsUsed, 0);
      if (monthly + wallet.bonusCredits < -amount) throw Object.assign(new Error('Insufficient available credits'), { statusCode: 409, code: 'INSUFFICIENT_ASSESSMENT_CREDITS' });
      const fromMonthly = Math.min(monthly, -amount);
      return { increments: { monthlyCreditsUsed: fromMonthly, bonusCredits: amount + fromMonthly }, bucket: 'monthly_bonus' };
    }
  });
  return result.transaction;
}

const toDto = ({ plan, wallet }) => ({ plan: plan.slug || plan.name, monthlyCredits: wallet.monthlyCredits,
  monthlyCreditsUsed: wallet.monthlyCreditsUsed, monthlyCreditsRemaining: Math.max(wallet.monthlyCredits - wallet.monthlyCreditsUsed, 0),
  purchasedCredits: Number(wallet.purchasedCredits || 0), bonusCredits: wallet.bonusCredits, availableCredits: available(wallet),
  billingCycleStart: wallet.billingCycleStart, billingCycleEnd: wallet.billingCycleEnd, resetDate: wallet.billingCycleEnd,
  usagePercent: wallet.monthlyCredits > 0 ? Math.min(100, Math.round((wallet.monthlyCreditsUsed / wallet.monthlyCredits) * 100)) : 100,
  nudgeThresholds: { soft: plan.assessmentCreditNudges?.softThresholdPercent ?? 50,
    warning: plan.assessmentCreditNudges?.warningThresholdPercent ?? 80 },
  warningAcknowledged: !!wallet.nudge80AcknowledgedAt &&
    String(wallet.nudgeCycleStart || wallet.billingCycleStart) === String(wallet.billingCycleStart) });

async function acknowledgeNudge(userOrId, threshold) {
  if (Number(threshold) !== 80) throw Object.assign(new Error('Only the 80% warning can be acknowledged'), { statusCode: 400 });
  const state = await getOrCreateWallet(userOrId);
  const percent = state.wallet.monthlyCredits > 0 ? (state.wallet.monthlyCreditsUsed / state.wallet.monthlyCredits) * 100 : 100;
  const warning = state.plan.assessmentCreditNudges?.warningThresholdPercent ?? 80;
  if (percent < warning) throw Object.assign(new Error('The usage warning is not active'), { statusCode: 409 });
  state.wallet = await CreditWallet.findByIdAndUpdate(state.wallet._id, { $set: { nudgeCycleStart: state.wallet.billingCycleStart,
    nudge80AcknowledgedAt: new Date() } }, { new: true });
  return state;
}

module.exports = { cycleFor, available, allowance, getOrCreateWallet, resetMonthlyCreditsIfNeeded, canRunAssessment,
  consumeAssessmentCredit, addBonusCredits: adjustBonusCredits, adjustBonusCredits, acknowledgeNudge, toDto, insufficient };
