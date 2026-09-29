'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const Plan = require('../models/Plan');
const User = require('../models/user.model');
const Entitlement = require('../models/PlanEntitlement');
const Attempt = require('../models/PaymentPurchaseAttempt');
const Account = require('../models/BillingAccount');
const Quote = require('../models/BillingQuote');
const Audit = require('../models/AdminAuditLog');
const Promo = require('./promoCode.service');
const { fail, minor, money, prorate } = require('./billingMoney.service');
const terms = () => require('./planEntitlement.service');
const QUOTE_MS = 10 * 60 * 1000;
const ORDER_MS = 30 * 60 * 1000;
const rank = slug => ({ free: 0, essential: 1, pro: 2 })[String(slug).replace(/_(monthly|annual|yearly)$/, '')];
const recurring = user => Boolean(user.paypalSubscriptionId && ['ACTIVE', 'SUSPENDED', 'APPROVAL_PENDING', 'APPROVED'].includes(String(user.paypalSubscriptionStatus).toUpperCase()));
const recurringMessage = 'This user has an active legacy recurring PayPal subscription. Review or resolve the recurring billing before manually changing the plan.';
const adminTier = slug => /^(free|essential|pro)(?:_(monthly|annual))?$/.exec(String(slug || ''))?.[1] || null;
const adminPeriods = plan => {
  if (plan.slug === 'free') return [];
  if (plan.slug.endsWith('_monthly')) return ['monthly'];
  if (plan.slug.endsWith('_annual')) return ['annual'];
  return [Number(plan.price) > 0 ? 'monthly' : null, Number(plan.annualPrice) > 0 ? 'annual' : null].filter(Boolean);
};

async function transaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
  catch (error) {
    if (error?.code === 20) throw fail('BILLING_TRANSACTIONS_REQUIRED', 'Billing requires a replica-set database. Contact support.', 503);
    if (error?.code === 11000) throw fail('BILLING_CONFLICT', 'This code or operation already exists, or another billing update is processing.', 409);
    throw error;
  } finally { await session.endSession(); }
}
async function lock(userId, session) {
  return Account.findOneAndUpdate({ userId }, { $inc: { revision: 1 } }, { upsert: true, returnDocument: 'after', session });
}
async function context(userId, now = new Date(), session = null) {
  const user = await User.findById(userId).select('email displayName role plan planStartedAt planExpiresAt paypalSubscriptionId paypalSubscriptionStatus paypalCurrentPeriodEnd').session(session);
  if (!user || user.role !== 'teacher') throw fail('BILLING_USER_NOT_FOUND', 'An eligible teacher account was not found.', 404);
  const entitlements = await Entitlement.find({ userId, status: { $in: ['active', 'scheduled'] },
    $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ startsAt: 1 }).limit(51).session(session).lean();
  if (entitlements.length > 50) throw fail('BILLING_REVIEW_REQUIRED', 'This account requires billing review.', 409);
  const current = entitlements.find(item => new Date(item.startsAt) <= now) || null;
  const future = entitlements.filter(item => new Date(item.startsAt) > now);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ recurring: user.paypalSubscriptionId || null,
    recurringStatus: user.paypalSubscriptionStatus || null,
    rows: entitlements.map(item => [String(item._id), item.planSlug, item.startsAt, item.endsAt]),
    legacyPlan: entitlements.length ? null : String(user.plan || ''), legacyExpiry: entitlements.length ? null : user.planExpiresAt })).digest('hex');
  return { user, entitlements, current, future, fingerprint };
}
async function selectedPlan(planSlug, billingPeriod, session = null, allowFree = false) {
  if (typeof planSlug !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(planSlug) || !['monthly', 'annual'].includes(billingPeriod))
    throw fail('PLAN_INPUT_INVALID', 'Invalid plan or billing period.');
  const plan = await Plan.findOne({ slug: planSlug, isActive: true }).session(session).lean();
  if (allowFree && (!plan || !adminTier(plan.slug) || (adminTier(plan.slug) === 'free' && plan.slug !== 'free') ||
    (plan.slug !== 'free' && !adminPeriods(plan).includes(billingPeriod))))
    throw fail('PLAN_UNAVAILABLE', 'Select an available plan and term.');
  if (!plan || ['custom', 'institution'].includes(plan.slug) || (!allowFree && plan.slug === 'free')) throw fail('PLAN_UNAVAILABLE', 'This plan is not available for this operation.');
  if (!Promo.CURRENCIES.has(String(plan.currency).toUpperCase())) throw fail('BILLING_CURRENCY_UNSUPPORTED', 'This currency requires billing review.', 409);
  return plan;
}
async function createQuote({ userId, planSlug, billingPeriod, promoCode, now = new Date() }) {
  const plan = await selectedPlan(planSlug, billingPeriod);
  const ctx = await context(userId, now);
  if (recurring(ctx.user) || terms().recurringPaidThrough(ctx.user, now)) throw fail('LEGACY_SUBSCRIPTION_ACTIVE', 'Manage existing recurring billing before prepaid checkout.', 409);
  if ((ctx.future.length && (!ctx.current || ctx.current.planSlug === 'free'))
    || ctx.entitlements.filter(item => new Date(item.startsAt) <= now).length > 1)
    throw fail('SCHEDULED_PLAN_REVIEW_REQUIRED', 'Review overlapping or future paid terms before starting a new plan.', 409);
  const base = minor(billingPeriod === 'annual' ? plan.annualPrice : plan.price);
  if (base < 1) throw fail('PLAN_PRICE_INVALID', 'Plan checkout requires a positive price.');
  let transition = 'purchase'; let credit = 0; let historicalPayment = null;
  if (ctx.current && ctx.current.planSlug !== 'free') {
    if (!ctx.current.endsAt || (ctx.current.planSlug !== plan.slug && (rank(ctx.current.planSlug) == null || rank(plan.slug) == null)))
      throw fail('PRORATION_REVIEW_REQUIRED', 'This plan change requires billing review.', 409);
    transition = ctx.current.planSlug === plan.slug ? 'renewal'
      : rank(plan.slug) > rank(ctx.current.planSlug) ? 'upgrade' : rank(plan.slug) < rank(ctx.current.planSlug) ? 'downgrade' : 'renewal';
    if (transition === 'upgrade') {
      if (ctx.future.length) throw fail('SCHEDULED_PLAN_REVIEW_REQUIRED', 'Review scheduled paid terms before upgrading.', 409);
      historicalPayment = await Attempt.findOne({ _id: ctx.current.paymentAttemptId, userId,
        purpose: 'plan_purchase', planSlug: ctx.current.planSlug, providerCaptureId: ctx.current.providerCaptureId,
        status: { $in: ['fulfilled', 'captured'] }, currency: String(plan.currency).toUpperCase() }).lean();
      if (!historicalPayment?.providerCaptureId || ctx.current.source !== 'paypal')
        throw fail('PRORATION_REVIEW_REQUIRED', 'The amount paid for the current term could not be verified. Contact billing support.', 409);
      credit = Math.min(base, prorate(minor(historicalPayment.expectedAmount), ctx.current.startsAt, ctx.current.endsAt, now));
    }
  } else if (!ctx.entitlements.length && ctx.user.plan) {
    const cached = await Plan.findById(ctx.user.plan).select('slug').lean();
    if (cached && cached.slug !== 'free' && (!ctx.user.planExpiresAt || ctx.user.planExpiresAt > now))
      throw fail('LEGACY_ENTITLEMENT_REVIEW_REQUIRED', 'Migrate or review this historical paid term before checkout.', 409);
  }
  const subtotal = base - credit;
  if (subtotal < 1) throw fail('MINIMUM_PAYMENT', 'This transition needs billing review because no positive payment is due.', 409);
  const snapshot = { pricingVersion: 1, planId: String(plan._id), planSlug: plan.slug, billingPeriod,
    currency: String(plan.currency).toUpperCase(), transition, quotedAt: now, fingerprint: ctx.fingerprint,
    currentEntitlementId: ctx.current ? String(ctx.current._id) : null,
    historicalPaymentId: historicalPayment ? String(historicalPayment._id) : null,
    historicalPaidAmount: historicalPayment?.expectedAmount || null,
    currentStartsAt: ctx.current?.startsAt || null, currentEndsAt: ctx.current?.endsAt || null,
    scheduledStartsAt: ctx.entitlements.at(-1)?.endsAt || null,
    baseAmount: money(base), prorationCredit: money(credit), subtotalBeforeDiscount: money(subtotal) };
  snapshot.promo = promoCode ? await Promo.quote(promoCode, snapshot, userId, subtotal) : null;
  snapshot.discountAmount = snapshot.promo?.discountAmount || '0.00';
  snapshot.finalAmount = money(subtotal - minor(snapshot.discountAmount));
  const quote = await Quote.create({ userId, kind: 'purchase', snapshot, expiresAt: new Date(now.getTime() + QUOTE_MS) });
  return quoteDto(quote);
}
function quoteDto(quote) { return { quoteId: String(quote._id), expiresAt: quote.expiresAt, ...quote.snapshot }; }
async function prepareAttempt({ user, planSlug, billingPeriod, quoteId, attemptId, providerEnvironment, lease }) {
  if (!quoteId) quoteId = (await createQuote({ userId: user._id, planSlug, billingPeriod })).quoteId;
  return transaction(async session => {
    const account = await lock(user._id, session);
    if (account.pendingAttempt && account.pendingAttempt !== attemptId) throw fail('BILLING_CHECKOUT_PENDING', 'Finish or cancel the existing plan checkout first.', 409);
    const quote = await Quote.findOne({ _id: quoteId, userId: user._id, kind: 'purchase', expiresAt: { $gt: new Date() } }).session(session);
    if (!quote || quote.snapshot.planSlug !== planSlug || quote.snapshot.billingPeriod !== billingPeriod) throw fail('BILLING_QUOTE_EXPIRED', 'Refresh your price quote before paying.', 409);
    const ctx = await context(user._id, new Date(), session);
    if (ctx.fingerprint !== quote.snapshot.fingerprint || recurring(ctx.user)) throw fail('BILLING_QUOTE_CHANGED', 'Your plan changed. Refresh the quote.', 409);
    await selectedPlan(planSlug, billingPeriod, session);
    await Promo.reserve(quote.snapshot, user._id, session);
    const attempt = (await Attempt.create([{ provider: 'paypal', providerEnvironment, purpose: 'plan_purchase', purchaseType: undefined,
      attemptId, userId: user._id, fundingSource: 'paypal', planSlug, billingPeriod,
      expectedAmount: quote.snapshot.finalAmount, currency: quote.snapshot.currency,
      pricingSnapshot: { ...quote.snapshot, quoteId: String(quote._id) }, promoState: quote.snapshot.promo ? 'reserved' : undefined,
      checkoutExpiresAt: new Date(Date.now() + ORDER_MS), createRequestId: `plan-create:${attemptId}`,
      captureRequestId: `plan-capture:${attemptId}`, status: 'creating', ...lease }], { session }))[0];
    account.pendingAttempt = attemptId; await account.save({ session });
    return attempt;
  });
}
async function assertCaptureAllowed(attempt) {
  if (!attempt.pricingSnapshot || attempt.providerCaptureId) return;
  if (attempt.checkoutExpiresAt <= new Date()) throw fail('BILLING_ORDER_EXPIRED', 'This checkout expired. Cancel it and request a new quote.', 409);
  const ctx = await context(attempt.userId);
  if (ctx.fingerprint !== attempt.pricingSnapshot.fingerprint || recurring(ctx.user)) throw fail('BILLING_QUOTE_CHANGED', 'Your billing state changed. Contact support before paying.', 409);
}
async function fulfill(attempt, plan, capture, now = new Date()) {
  return transaction(async session => {
    const account = await lock(attempt.userId, session);
    const saved = await Attempt.findById(attempt._id).session(session);
    const existing = await Entitlement.findOne({ providerCaptureId: capture.id }).session(session);
    if (existing && String(existing.paymentAttemptId) === String(saved._id)) return existing;
    if (['cancelled', 'refunded', 'review_required'].includes(saved.status) || account.pendingAttempt !== saved.attemptId)
      throw fail('BILLING_REVIEW_REQUIRED', 'Payment requires billing review before fulfillment.', 409);
    const ctx = await context(saved.userId, now, session);
    if (ctx.fingerprint !== saved.pricingSnapshot.fingerprint || recurring(ctx.user)) throw fail('BILLING_REVIEW_REQUIRED', 'Your plan changed during payment. Contact billing support.', 409);
    const snap = saved.pricingSnapshot;
    if (snap.historicalPaymentId) {
      // Write the source payment in this transaction too: a concurrent refund
      // must conflict and recheck rather than mint credit from refunded money.
      const verified = await Attempt.updateOne({ _id: snap.historicalPaymentId, userId: saved.userId,
        status: { $in: ['fulfilled', 'captured'] }, expectedAmount: snap.historicalPaidAmount,
        currency: saved.currency, refundedAt: null }, { $set: { prorationAppliedAt: now } }, { session });
      if (!verified.matchedCount) throw fail('BILLING_REVIEW_REQUIRED', 'The original payment changed. Billing review is required.', 409);
    }
    await Entitlement.updateMany({ userId: saved.userId, status: { $in: ['active', 'scheduled'] }, endsAt: { $ne: null, $lte: now } }, { $set: { status: 'expired', expiredAt: now } }, { session });
    const id = new mongoose.Types.ObjectId();
    if (snap.transition === 'upgrade' || ctx.current?.planSlug === 'free') await Entitlement.updateOne({ _id: ctx.current._id, status: { $in: ['active', 'scheduled'] } },
      { $set: { status: 'superseded', supersededAt: now, supersededBy: id, supersededReason: 'Verified prepaid upgrade/purchase' } }, { session });
    const startsAt = ['renewal', 'downgrade'].includes(snap.transition) && snap.scheduledStartsAt && new Date(snap.scheduledStartsAt) > now
      ? new Date(snap.scheduledStartsAt) : now;
    const status = startsAt > now ? 'scheduled' : 'active';
    const entitlement = (await Entitlement.create([{ _id: id, userId: saved.userId, planId: snap.planId, planSlug: snap.planSlug,
      billingPeriod: saved.billingPeriod, status, source: 'paypal', startsAt, endsAt: terms().addCalendarPeriod(startsAt, saved.billingPeriod),
      paymentProvider: 'paypal', paymentAttemptId: saved._id, providerOrderId: saved.providerOrderId,
      providerCaptureId: capture.id, paidAmount: saved.expectedAmount, paidCurrency: saved.currency,
      ...(status === 'active' ? { activatedAt: now } : {}) }], { session }))[0];
    if (status === 'active') await User.updateOne({ _id: saved.userId }, { $set: { plan: plan._id, planStartedAt: startsAt, planExpiresAt: entitlement.endsAt } }, { session });
    await Promo.transition(saved, 'consumed', session);
    saved.status = 'fulfilled'; saved.entitlementId = id; saved.providerCaptureId = capture.id; saved.processingLeaseExpiresAt = null;
    await saved.save({ session }); account.pendingAttempt = null; await account.save({ session });
    return entitlement;
  });
}
async function cancel(userId, attemptId, expiredOnly = false) {
  return transaction(async session => {
    const account = await lock(userId, session);
    const attempt = await Attempt.findOne({ userId, attemptId, purpose: 'plan_purchase' }).session(session);
    if (!attempt || !attempt.pricingSnapshot) throw fail('BILLING_ATTEMPT_NOT_FOUND', 'Checkout was not found.', 404);
    if (attempt.status === 'cancelled') return attempt;
    // Never release a slot while capture might have reached PayPal.
    if (!['creating', 'approval_pending', 'failed'].includes(attempt.status) || attempt.providerCaptureId
      || attempt.captureAttemptedAt
      || (expiredOnly && attempt.checkoutExpiresAt > new Date())) throw fail('BILLING_RECONCILIATION_REQUIRED', 'Payment confirmation requires review before cancellation.', 409);
    await Promo.transition(attempt, 'released', session); attempt.status = 'cancelled'; attempt.processingLeaseExpiresAt = null;
    await attempt.save({ session }); if (account.pendingAttempt === attemptId) { account.pendingAttempt = null; await account.save({ session }); }
    return attempt;
  });
}
async function expireReservations() {
  const attempts = await Attempt.find({ purpose: 'plan_purchase', checkoutExpiresAt: { $lte: new Date() },
    captureAttemptedAt: null, providerCaptureId: null,
    status: { $in: ['creating', 'approval_pending', 'failed'] } }).sort({ checkoutExpiresAt: 1 }).select('userId attemptId').limit(100).lean();
  for (const attempt of attempts) { try { await cancel(attempt.userId, attempt.attemptId, true); } catch (error) { if (error.statusCode !== 409) throw error; } }
}
async function lookup(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw fail('EMAIL_INVALID', 'Enter a valid email address.');
  const matches = await User.find({ email: email.trim().toLowerCase() }).select('_id').limit(2).lean();
  if (matches.length !== 1) throw fail('USER_LOOKUP_REVIEW', matches.length ? 'Multiple accounts match this email. Contact support.' : 'User not found.', matches.length ? 409 : 404);
  const ctx = await context(matches[0]._id);
  const cacheExpired = !ctx.current && ctx.user.planExpiresAt && ctx.user.planExpiresAt <= new Date();
  const currentPlan = ctx.current ? await Plan.findById(ctx.current.planId).select('name slug').lean()
    : cacheExpired ? await Plan.findOne({ slug: 'free', isActive: true }).select('name slug').lean()
      : await Plan.findById(ctx.user.plan).select('name slug').lean();
  return { userId: String(ctx.user._id), email: ctx.user.email, displayName: ctx.user.displayName,
    currentPlan: currentPlan?.name || 'Free', currentExpiry: ctx.current ? ctx.current.endsAt : cacheExpired ? null : ctx.user.planExpiresAt || null,
    scheduled: ctx.future.map(item => ({ planSlug: item.planSlug, startsAt: item.startsAt, endsAt: item.endsAt })),
    blocked: recurring(ctx.user), message: recurring(ctx.user) ? recurringMessage : null };
}
async function previewAdmin({ actor, email, planSlug, billingPeriod, reason, now = new Date() }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw fail('ADMIN_REASON_REQUIRED', 'Enter a reason of at most 500 characters.');
  const target = await lookup(email);
  if (target.blocked) throw fail('LEGACY_SUBSCRIPTION_ACTIVE', recurringMessage, 409);
  const plan = await selectedPlan(planSlug, billingPeriod, null, true);
  const ctx = await context(target.userId, now);
  const snapshot = { ...target, targetUserId: target.userId, planId: String(plan._id), planSlug: plan.slug,
    billingPeriod, reason: reason.trim(), startsAt: now, endsAt: plan.slug === 'free' ? null : terms().addCalendarPeriod(now, billingPeriod), fingerprint: ctx.fingerprint };
  return quoteDto(await Quote.create({ userId: actor, kind: 'admin', snapshot, expiresAt: new Date(now.getTime() + QUOTE_MS) }));
}
async function assignAdmin({ actor, quoteId, operationId }) {
  const operation = `${actor}:${operationId}`;
  return transaction(async session => {
    const replay = await Entitlement.findOne({ adminOperationId: operation }).session(session);
    if (replay) {
      if (replay.adminQuoteId !== quoteId) throw fail('ADMIN_OPERATION_CONFLICT', 'Use a new operation for a different assignment.', 409);
      return replay;
    }
    const quote = await Quote.findOne({ _id: quoteId, userId: actor, kind: 'admin', expiresAt: { $gt: new Date() } }).session(session);
    if (!quote) throw fail('ADMIN_PREVIEW_EXPIRED', 'Preview and confirm the assignment again.', 409);
    const snap = quote.snapshot;
    const account = await lock(snap.targetUserId, session);
    if (account.pendingAttempt || await Attempt.exists({ userId: snap.targetUserId, purpose: 'plan_purchase',
      $or: [{ status: { $in: ['creating', 'approval_pending', 'capturing', 'captured', 'review_required'] } },
        { status: 'failed', retryCount: { $gt: 0 } }] }).session(session))
      throw fail('BILLING_CHECKOUT_PENDING', 'Resolve pending plan payments before assigning a plan.', 409);
    const ctx = await context(snap.targetUserId, new Date(), session);
    if (recurring(ctx.user)) throw fail('LEGACY_SUBSCRIPTION_ACTIVE', recurringMessage, 409);
    if (ctx.fingerprint !== snap.fingerprint) throw fail('ADMIN_PREVIEW_CHANGED', 'The account changed. Preview and confirm again.', 409);
    await selectedPlan(snap.planSlug, snap.billingPeriod, session, true);
    const id = new mongoose.Types.ObjectId();
    const now = new Date();
    await Entitlement.updateMany({ userId: ctx.user._id, status: { $in: ['active', 'scheduled'] } },
      { $set: { status: 'superseded', supersededAt: now, supersededBy: id, supersededReason: snap.reason } }, { session });
    const entitlement = (await Entitlement.create([{ _id: id, userId: ctx.user._id, planId: snap.planId, planSlug: snap.planSlug,
      billingPeriod: snap.billingPeriod, source: 'admin', status: 'active', startsAt: snap.startsAt, endsAt: snap.endsAt,
      activatedAt: now, assignedBy: actor, adminReason: snap.reason, adminOperationId: operation, adminQuoteId: quoteId }], { session }))[0];
    await User.updateOne({ _id: ctx.user._id }, { $set: { plan: snap.planId, planStartedAt: snap.startsAt, planExpiresAt: snap.endsAt } }, { session });
    await Audit.create([{ adminUserId: actor, action: 'ADMIN_PLAN_ASSIGNMENT', targetType: 'User', targetId: String(ctx.user._id),
      idempotencyKey: operation, reason: snap.reason, before: { currentPlan: snap.currentPlan, currentExpiry: snap.currentExpiry, entitlements: ctx.entitlements },
      after: { entitlementId: String(id), source: 'admin_manual', planSlug: snap.planSlug, billingPeriod: snap.billingPeriod,
        effectiveAt: snap.startsAt, expiresAt: snap.endsAt, supersededIds: ctx.entitlements.map(item => String(item._id)) } }], { session });
    return entitlement;
  });
}
module.exports = { transaction, createQuote, quoteDto, prepareAttempt, assertCaptureAllowed, fulfill, cancel,
  expireReservations, lookup, previewAdmin, assignAdmin, context, rank, recurring, adminTier, adminPeriods, QUOTE_MS, ORDER_MS };
