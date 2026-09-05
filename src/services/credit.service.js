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

function cycleFor(user, plan, now = new Date()) {
  const stripeStart = user.stripeCurrentPeriodStart && new Date(user.stripeCurrentPeriodStart);
  const stripeEnd = user.stripeCurrentPeriodEnd && new Date(user.stripeCurrentPeriodEnd);
  if (stripeStart && stripeEnd && stripeEnd > stripeStart) return { start: stripeStart, end: stripeEnd };
  const anchor = user.planStartedAt ? new Date(user.planStartedAt) : now;
  const start = new Date(anchor);
  const interval = String(plan.billingInterval || plan.billingType || 'monthly').toLowerCase();
  const months = interval === 'yearly' ? 12 : 1;
  while (new Date(start).setMonth(start.getMonth() + months) <= now.getTime()) start.setMonth(start.getMonth() + months);
  const end = new Date(start); end.setMonth(end.getMonth() + months);
  return { start, end };
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
    billingCycleStart: cycle.start, billingCycleEnd: cycle.end, lastCreditReset: cycle.start
  } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (wallet.createdAt && wallet.createdAt.getTime() === wallet.updatedAt.getTime()) logger.info({ event: 'credit.wallet.created', userId: String(user._id) });
  wallet = await resetMonthlyCreditsIfNeeded(user, plan, wallet, now);
  return { user, plan, wallet };
}

async function resetMonthlyCreditsIfNeeded(user, plan, wallet, now = new Date()) {
  const cycle = cycleFor(user, plan, now); const nextAllowance = allowance(plan);
  const expired = new Date(wallet.billingCycleEnd) <= now;
  const changed = Number(wallet.monthlyCredits) !== nextAllowance;
  if (!expired && !changed) return wallet;
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
  const idempotencyKey = `assessment:${submissionId}:${assessmentId}`;
  const waitForCommitted = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const item = await CreditTransaction.findOne({ idempotencyKey });
      if (item && item.status !== 'pending') return item;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return CreditTransaction.findOne({ idempotencyKey, status: 'committed' });
  };
  const existing = await CreditTransaction.findOne({ idempotencyKey });
  if (existing) {
    const transaction = existing.status === 'pending' ? await waitForCommitted() : existing;
    if (transaction) return { charged: false, transaction, availableCredits: transaction.balanceAfter };
  }
  try {
    await CreditTransaction.create({ userId, type: 'ASSESSMENT_DEBIT', status: 'pending', amount: -1,
      balanceAfter: 0, reason, submissionId, assignmentId, assessmentId, idempotencyKey });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const transaction = await waitForCommitted();
    if (transaction) return { charged: false, transaction, availableCredits: transaction.balanceAfter };
    throw Object.assign(new Error('Assessment credit transaction is still processing'), { code: 'CREDIT_DEBIT_PROCESSING', statusCode: 409 });
  }
  const state = await getOrCreateWallet(userId); const beforeWallet = state.wallet.toObject();
  const monthlyRemaining = Math.max(state.wallet.monthlyCredits - state.wallet.monthlyCreditsUsed, 0);
  const purchasedRemaining = Number(state.wallet.purchasedCredits || 0);
  const bucket = monthlyRemaining > 0 ? 'monthly' : purchasedRemaining > 0 ? 'purchased' : 'bonus';
  const inc = bucket === 'monthly' ? { monthlyCreditsUsed: 1 } : bucket === 'purchased' ? { purchasedCredits: -1 } : { bonusCredits: -1 };
  const condition = monthlyRemaining > 0
    ? { _id: state.wallet._id, monthlyCreditsUsed: { $lt: state.wallet.monthlyCredits } }
    : purchasedRemaining > 0 ? { _id: state.wallet._id, purchasedCredits: { $gte: 1 } }
      : { _id: state.wallet._id, bonusCredits: { $gte: 1 } };
  const wallet = await CreditWallet.findOneAndUpdate(condition, { $inc: inc }, { new: true });
  if (!wallet) { await CreditTransaction.deleteOne({ idempotencyKey, status: 'pending' }); throw insufficient(); }
  try {
    const transaction = await CreditTransaction.findOneAndUpdate({ idempotencyKey, status: 'pending' }, { $set: {
      status: 'committed', balanceAfter: available(wallet), 'metadata.creditBucket': bucket } }, { returnDocument: 'after' });
    if (!transaction) throw new Error('Assessment debit claim was lost');
    logger.info({ event: 'credit.assessment.consumed', userId: String(userId), submissionId: String(submissionId), assessmentId,
      transactionId: String(transaction._id), remainingCredits: available(wallet) });
    try {
      await evaluateCreditUsageNudge({ userId, beforeWallet, afterWallet: wallet, transaction });
    } catch (nudgeError) {
      logger.error({ event: 'credit_usage_nudge_failed', userId: String(userId), transactionId: String(transaction._id),
        error: nudgeError?.message });
    }
    return { charged: true, transaction, availableCredits: available(wallet) };
  } catch (error) {
    await CreditWallet.updateOne({ _id: wallet._id }, { $inc: bucket === 'monthly' ? { monthlyCreditsUsed: -1 } : bucket === 'purchased' ? { purchasedCredits: 1 } : { bonusCredits: 1 } });
    await CreditTransaction.deleteOne({ idempotencyKey, status: 'pending' });
    throw error;
  }
}

async function adjustBonusCredits({ userId, amount, reason, idempotencyKey, actorId, metadata = {}, transactionType, referralId, rewardGrantId, _casAttempt = 0 }) {
  if (!Number.isInteger(amount) || amount === 0) throw Object.assign(new Error('amount must be a non-zero integer'), { statusCode: 400 });
  if (!reason || !String(reason).trim()) throw Object.assign(new Error('reason is required'), { statusCode: 400 });
  const old = await CreditTransaction.findOne({ idempotencyKey }); if (old) return old;
  const state = await getOrCreateWallet(userId);
  const monthlyRemaining = Math.max(state.wallet.monthlyCredits - state.wallet.monthlyCreditsUsed, 0);
  const removeMonthly = amount < 0 ? Math.min(monthlyRemaining, -amount) : 0;
  const removeBonus = amount < 0 ? (-amount - removeMonthly) : 0;
  const increments = amount > 0 ? { bonusCredits: amount } : { monthlyCreditsUsed: removeMonthly, bonusCredits: -removeBonus };
  const wallet = await CreditWallet.findOneAndUpdate({ _id: state.wallet._id, updatedAt: state.wallet.updatedAt,
    ...(amount < 0 ? { $expr: { $gte: [{ $add: [{ $max: [{ $subtract: ['$monthlyCredits', '$monthlyCreditsUsed'] }, 0] }, '$bonusCredits'] }, -amount] } } : {}) },
    { $inc: increments }, { new: true });
  if (!wallet) {
    if (amount > 0 && _casAttempt < 3) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const committed = await CreditTransaction.findOne({ idempotencyKey });
        if (committed) return committed;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return adjustBonusCredits({ userId, amount, reason, idempotencyKey, actorId, metadata,
        transactionType, referralId, rewardGrantId, _casAttempt: _casAttempt + 1 });
    }
    throw Object.assign(new Error('Insufficient available credits'), { statusCode: 409, code: 'INSUFFICIENT_ASSESSMENT_CREDITS' });
  }
  const type = transactionType || (actorId ? (amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT') : 'BONUS_CREDIT');
  try { return await CreditTransaction.create({ userId, type,
    amount, balanceAfter: available(wallet), reason: String(reason).trim(), idempotencyKey, referralId, rewardGrantId,
    metadata: { ...metadata, ...(actorId ? { adminActorId: String(actorId) } : {}) } });
  } catch (error) {
    await CreditWallet.updateOne({ _id: wallet._id }, { $inc: Object.fromEntries(Object.entries(increments).map(([key, value]) => [key, -value])) });
    if (error?.code === 11000) return CreditTransaction.findOne({ idempotencyKey });
    throw error;
  }
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

module.exports = { available, allowance, getOrCreateWallet, resetMonthlyCreditsIfNeeded, canRunAssessment,
  consumeAssessmentCredit, addBonusCredits: adjustBonusCredits, adjustBonusCredits, acknowledgeNudge, toDto, insufficient };
