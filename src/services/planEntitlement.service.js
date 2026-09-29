'use strict';

const crypto = require('crypto');
const Plan = require('../models/Plan');
const User = require('../models/user.model');
const PlanEntitlement = require('../models/PlanEntitlement');
const PlanEntitlementLock = require('../models/PlanEntitlementLock');
const { createNotification } = require('./notification.service');

const LOCK_MS = 30_000;

function addCalendarPeriod(start, period) {
  const date = new Date(start);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid entitlement start date');
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (period === 'annual') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (period === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
  else throw Object.assign(new Error('Invalid billing period'), { code: 'PLAN_PERIOD_INVALID', statusCode: 400 });
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date;
}

function recurringPaidThrough(user, now = new Date()) {
  const status = String(user.paypalSubscriptionStatus || '').toUpperCase();
  if (status === 'ACTIVE' && user.paypalSubscriptionId) return true;
  const end = user.paypalCurrentPeriodEnd ? new Date(user.paypalCurrentPeriodEnd) : null;
  return status === 'CANCELLED' && end && end > now;
}

async function acquire(userId, owner = crypto.randomUUID()) {
  const now = new Date(); const leaseExpiresAt = new Date(now.getTime() + LOCK_MS);
  try { await PlanEntitlementLock.create({ userId, owner, leaseExpiresAt }); return owner; }
  catch (error) { if (error?.code !== 11000) throw error; }
  const lock = await PlanEntitlementLock.findOneAndUpdate({ userId, leaseExpiresAt: { $lte: now } },
    { $set: { owner, leaseExpiresAt } }, { new: true });
  if (!lock) throw Object.assign(new Error('Plan update is already processing'), { code: 'PLAN_ENTITLEMENT_BUSY', statusCode: 409 });
  return owner;
}

async function release(userId, owner) {
  await PlanEntitlementLock.deleteOne({ userId, owner });
}

async function syncCompatibility(userId, entitlement, plan, observedUser = null) {
  await User.updateOne({ _id: userId, ...(observedUser ? { plan: observedUser.plan || null,
    planStartedAt: observedUser.planStartedAt || null } : {}) }, { $set: { plan: plan._id, planStartedAt: entitlement?.startsAt || new Date(),
    planExpiresAt: entitlement?.endsAt || null } });
}

async function freePlan() {
  const plan = await Plan.findOne({ slug: 'free', isActive: true }) || await Plan.findOne({ name: 'Free', isActive: true });
  if (!plan) throw new Error('Free plan is not configured');
  return plan;
}

async function expireAndPromote(user, now = new Date()) {
  // Provider-recurring accounts are deliberately outside prepaid expiry.
  if (recurringPaidThrough(user, now)) {
    const manualOverride = String(user.paypalSubscriptionStatus).toUpperCase() !== 'ACTIVE'
      && await PlanEntitlement.exists({ userId: user._id, source: 'admin', adminOperationId: { $type: 'string' } });
    if (!manualOverride) return null;
  }
  await PlanEntitlement.updateMany({ userId: user._id, status: { $in: ['active', 'scheduled'] },
    endsAt: { $ne: null, $lte: now } }, { $set: { status: 'expired', expiredAt: now } });
  const due = await PlanEntitlement.findOneAndUpdate({ userId: user._id, status: 'scheduled', startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }, { $set: { status: 'active', activatedAt: now } },
  { new: true, sort: { startsAt: 1, createdAt: 1 } });
  const current = due || await PlanEntitlement.findOne({ userId: user._id, status: 'active', startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ startsAt: -1 });
  if (current) {
    const plan = await Plan.findById(current.planId);
    if (plan?.isActive) { await syncCompatibility(user._id, current, plan, user); return { entitlement: current, plan }; }
  }
  const fallback = await freePlan();
  await syncCompatibility(user._id, null, fallback, user);
  return { entitlement: null, plan: fallback };
}

async function resolveEffectivePlan(user, now = new Date()) {
  return expireAndPromote(user, now);
}

async function fulfillPlanPurchase({ attempt, plan, capture, now = new Date() }) {
  const existing = await PlanEntitlement.findOne({ providerCaptureId: capture.id });
  if (existing) return existing;
  const owner = await acquire(attempt.userId, `capture:${capture.id}`);
  try {
    const replay = await PlanEntitlement.findOne({ providerCaptureId: capture.id });
    if (replay) return replay;
    const indefinite = await PlanEntitlement.findOne({ userId: attempt.userId,
      status: { $in: ['active', 'scheduled'] }, endsAt: null });
    if (indefinite) throw Object.assign(new Error('An indefinite admin plan must be reviewed before prepaid checkout'),
      { code: 'PLAN_ENTITLEMENT_CONFLICT', statusCode: 409 });
    const tail = await PlanEntitlement.findOne({ userId: attempt.userId,
      status: { $in: ['active', 'scheduled'] }, endsAt: { $gt: now } }).sort({ endsAt: -1 });
    const startsAt = tail?.endsAt && tail.endsAt > now ? new Date(tail.endsAt) : new Date(now);
    const endsAt = addCalendarPeriod(startsAt, attempt.billingPeriod);
    const status = startsAt > now ? 'scheduled' : 'active';
    const entitlement = await PlanEntitlement.create({ userId: attempt.userId, planId: plan._id, planSlug: plan.slug,
      billingPeriod: attempt.billingPeriod, status, source: 'paypal', startsAt, endsAt, autoRenew: false,
      paymentProvider: 'paypal', paymentAttemptId: attempt._id, providerOrderId: attempt.providerOrderId,
      providerCaptureId: capture.id, ...(status === 'active' ? { activatedAt: now } : {}) });
    if (status === 'active') await syncCompatibility(attempt.userId, entitlement, plan);
    return entitlement;
  } finally { await release(attempt.userId, owner); }
}

async function reconcileRefund({ attempt, eventId, now = new Date() }) {
  const entitlement = await PlanEntitlement.findOneAndUpdate({ paymentAttemptId: attempt._id,
    status: { $nin: ['refunded', 'revoked'] } }, { $set: { status: 'refunded', revokedAt: now, refundEventId: eventId } }, { new: true });
  const user = await User.findById(attempt.userId);
  if (user && !recurringPaidThrough(user, now)) await expireAndPromote(user, now);
  return entitlement || PlanEntitlement.findOne({ paymentAttemptId: attempt._id });
}

async function assignAdmin() {
  throw Object.assign(new Error('Use the audited billing preview and confirmation workflow.'),
    { code: 'ADMIN_PLAN_CONFIRMATION_REQUIRED', statusCode: 409 });
}

async function processExpiriesAndReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + 2 * 86400000);
  const candidates = await PlanEntitlement.find({ status: 'active', endsAt: { $gt: now, $lte: horizon } }).lean();
  for (const item of candidates) {
    const ms = new Date(item.endsAt).getTime() - now.getTime();
    const days = ms > 86400000 ? 2 : 1;
    await createNotification({ recipientId: item.userId, type: 'plan_expiry', category: 'ACCOUNT',
      priority: 'HIGH', title: days === 2 ? `Your ${item.planSlug} plan expires in 2 days` : `Your ${item.planSlug} plan expires tomorrow`,
      description: days === 2 ? `Renew to continue using ${item.planSlug} limits and features.`
        : 'Your account will move to the Free plan if you do not renew.',
      data: { entitlementId: String(item._id), endsAt: item.endsAt, route: { path: '/pricing' } },
      idempotencyKey: `plan-expiry:${item._id}:${days}-days` });
  }
  const expired = await PlanEntitlement.find({ status: { $in: ['active', 'scheduled'] }, endsAt: { $ne: null, $lte: now } }).lean();
  for (const item of expired) {
    const user = await User.findById(item.userId);
    if (!user) continue;
    const effective = await expireAndPromote(user, now);
    if (!effective) continue;
    await createNotification({ recipientId: item.userId, type: 'plan_expired', category: 'ACCOUNT', priority: 'NORMAL',
      title: `Your ${item.planSlug} plan has expired`,
      description: effective?.plan?.slug === 'free'
        ? 'Your account has moved to the Free plan. Your existing classes, assignments and learning materials are still available.'
        : `Your scheduled ${effective?.plan?.name || 'next'} plan is now active. Your existing content remains available.`,
      data: { entitlementId: String(item._id), route: { path: '/pricing' } },
      idempotencyKey: `plan-expired:${item._id}` });
  }
  return { reminders: candidates.length, expired: expired.length };
}

module.exports = { LOCK_MS, addCalendarPeriod, recurringPaidThrough, resolveEffectivePlan, fulfillPlanPurchase,
  reconcileRefund, assignAdmin, processExpiriesAndReminders, acquire, release };
