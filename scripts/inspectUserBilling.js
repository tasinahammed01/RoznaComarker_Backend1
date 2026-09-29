'use strict';

// Read-only billing evidence collection. Do not call entitlement resolution:
// that service can expire/promote records and update the User compatibility cache.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../src/models/user.model');
const Plan = require('../src/models/Plan');
const Entitlement = require('../src/models/PlanEntitlement');
const Attempt = require('../src/models/PaymentPurchaseAttempt');
const CheckoutAttempt = require('../src/models/PaymentCheckoutAttempt');
const ManagementAttempt = require('../src/models/PaymentManagementAttempt');
const BillingAccount = require('../src/models/BillingAccount');
const EntitlementLock = require('../src/models/PlanEntitlementLock');

const TARGET_SLUG = 'pro_monthly';
const MAX_TIME_MS = 8000;
const statusAllowsQuote = status => ['active', 'scheduled'].includes(status);
const iso = value => value ? new Date(value).toISOString() : null;
const id = value => value == null ? null : String(value);
const mask = value => value ? `***${String(value).slice(-4)}` : null;
const rank = slug => ({ free: 0, essential: 1, pro: 2 })[String(slug || '').replace(/_(monthly|annual|yearly)$/u, '')];

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new Error('EMAIL_REQUIRED');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('EMAIL_INVALID');
  return email;
}

function quoteEligible(entitlement, now) {
  return statusAllowsQuote(entitlement.status) &&
    (entitlement.endsAt == null || new Date(entitlement.endsAt) > now);
}

function futureCandidate(entitlement, now) {
  return quoteEligible(entitlement, now) && new Date(entitlement.startsAt) > now;
}

function recurringPaidThrough(user, now) {
  if (user.paypalSubscriptionId && user.paypalSubscriptionStatus === 'ACTIVE') return true;
  return user.paypalSubscriptionStatus === 'CANCELLED' && user.paypalCurrentPeriodEnd &&
    new Date(user.paypalCurrentPeriodEnd) > now;
}

function internallyVerifiedPayment(entitlement, attempt) {
  return Boolean(entitlement.source === 'paypal' && attempt && attempt.purpose === 'plan_purchase' &&
    ['fulfilled', 'captured'].includes(attempt.status) &&
    attempt.providerCaptureId && entitlement.providerCaptureId &&
    String(attempt.providerCaptureId) === String(entitlement.providerCaptureId) &&
    Number(attempt.expectedAmount) > 0 && attempt.currency);
}

function classifyBlocker(entitlement, attempt, current, preceding) {
  if (entitlement.source === 'admin') return entitlement.adminOperationId || entitlement.assignedBy
    ? 'ADMIN_MANUAL_TERM' : 'CANNOT_CLASSIFY_SAFELY';
  if (entitlement.source !== 'paypal') return 'CANNOT_CLASSIFY_SAFELY';
  if (!attempt || !entitlement.paymentAttemptId || id(attempt._id) !== id(entitlement.paymentAttemptId) ||
    !internallyVerifiedPayment(entitlement, attempt)) return 'ORPHANED_OR_INCONSISTENT';
  const transition = attempt.pricingSnapshot?.transition;
  if (preceding && preceding.planSlug === entitlement.planSlug &&
    new Date(preceding.endsAt).getTime() === new Date(entitlement.startsAt).getTime())
    return 'SAME_PLAN_RENEWAL';
  if (transition === 'renewal' || entitlement.planSlug === current?.planSlug) return 'SAME_PLAN_RENEWAL';
  if (transition === 'downgrade' ||
    (rank(entitlement.planSlug) != null && rank(current?.planSlug) != null && rank(entitlement.planSlug) < rank(current.planSlug)))
    return 'SCHEDULED_DOWNGRADE';
  return 'GENUINE_PAID_SCHEDULED_TERM';
}

async function inspect(emailInput, now = new Date()) {
  const email = normalizeEmail(emailInput);
  const users = await User.find({ email }).select('_id email role plan planStartedAt planExpiresAt paypalSubscriptionId paypalPlanId paypalSubscriptionStatus paypalCurrentPeriodStart paypalCurrentPeriodEnd')
    .limit(2).lean().maxTimeMS(MAX_TIME_MS);
  if (users.length !== 1) throw Object.assign(new Error(users.length ? 'AMBIGUOUS_EMAIL' : 'USER_NOT_FOUND'), { exitCode: 1 });
  const user = users[0];
  if (user.role !== 'teacher') throw Object.assign(new Error('NOT_A_TEACHER'), { exitCode: 1 });

  // Fetch each collection once; no N+1 lookups or mutation-capable services.
  const [entitlements, attempts, recurringAttempts, managementAttempts, account, lock, targetPlan] = await Promise.all([
    Entitlement.find({ userId: user._id }).select('_id planId planSlug status source startsAt endsAt billingPeriod paymentAttemptId paymentProvider providerOrderId providerCaptureId supersededAt supersededBy createdAt updatedAt adminOperationId adminQuoteId assignedBy adminReason paidAmount paidCurrency activatedAt expiredAt revokedAt refundEventId')
      .sort({ startsAt: 1, createdAt: 1, _id: 1 }).lean().maxTimeMS(MAX_TIME_MS),
    Attempt.find({ userId: user._id, purpose: 'plan_purchase' }).select('_id attemptId purpose planSlug billingPeriod status expectedAmount currency provider providerEnvironment providerOrderId providerCaptureId capturedAt refundedAt entitlementId pricingSnapshot createdAt updatedAt')
      .sort({ createdAt: 1, _id: 1 }).lean().maxTimeMS(MAX_TIME_MS),
    CheckoutAttempt.find({ userId: user._id, provider: 'paypal' }).select('_id planKey billingInterval status providerSubscriptionId createdAt completedAt cancelledAt')
      .sort({ createdAt: 1 }).lean().maxTimeMS(MAX_TIME_MS),
    ManagementAttempt.find({ userId: user._id, provider: 'paypal' }).select('_id operation status sourcePlanKey targetPlanKey billingInterval completedAt createdAt')
      .sort({ createdAt: 1 }).lean().maxTimeMS(MAX_TIME_MS),
    BillingAccount.findOne({ userId: user._id }).select('_id revision pendingAttempt updatedAt').lean().maxTimeMS(MAX_TIME_MS),
    EntitlementLock.findOne({ userId: user._id }).select('_id leaseExpiresAt updatedAt').lean().maxTimeMS(MAX_TIME_MS),
    Plan.findOne({ slug: TARGET_SLUG, isActive: true }).select('_id slug name isActive').lean().maxTimeMS(MAX_TIME_MS)
  ]);
  const planIds = [...new Set([user.plan, ...entitlements.map(item => item.planId)].filter(Boolean).map(id))];
  const plans = await Plan.find({ _id: { $in: planIds } }).select('_id slug name isActive').lean().maxTimeMS(MAX_TIME_MS);
  const planById = new Map(plans.map(plan => [id(plan._id), plan]));
  const attemptById = new Map(attempts.map(attempt => [id(attempt._id), attempt]));

  // Exact quote context: only active/scheduled records whose end is null or
  // later than now, sorted by startsAt, then the first startsAt <= now.
  const quoteRows = entitlements.filter(item => quoteEligible(item, now))
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const quoteCurrent = quoteRows.find(item => new Date(item.startsAt) <= now) || null;
  const quoteFuture = quoteRows.filter(item => new Date(item.startsAt) > now);
  const multipleCurrent = quoteRows.filter(item => new Date(item.startsAt) <= now).length > 1;
  const legacyPreferred = Boolean(recurringPaidThrough(user, now) &&
    !(user.paypalSubscriptionStatus !== 'ACTIVE' && entitlements.some(item => item.source === 'admin' && item.adminOperationId)));
  const rankKnown = rank(quoteCurrent?.planSlug) != null && rank(TARGET_SLUG) != null;
  const higherUpgrade = Boolean(quoteCurrent && quoteCurrent.planSlug !== 'free' && quoteCurrent.endsAt &&
    quoteCurrent.planSlug !== TARGET_SLUG && rankKnown && rank(TARGET_SLUG) > rank(quoteCurrent.planSlug));
  const futureConflict = quoteFuture.length > 0 && (!quoteCurrent || quoteCurrent.planSlug === 'free' || higherUpgrade);
  const quoteWouldReturnScheduledConflict = Boolean(targetPlan && !legacyPreferred && quoteRows.length <= 50 &&
    (futureConflict || multipleCurrent));

  // Read-only approximation of resolver precedence; never call resolveEffectivePlan.
  const due = quoteRows.filter(item => item.status === 'scheduled' && new Date(item.startsAt) <= now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];
  const active = quoteRows.filter(item => item.status === 'active' && new Date(item.startsAt) <= now)
    .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt))[0];
  const effectiveEntitlement = legacyPreferred ? null : due || active || null;
  const cachedPlanCurrent = Boolean(user.plan && (!user.planExpiresAt || new Date(user.planExpiresAt) > now));
  const effectivePlanDoc = effectiveEntitlement ? planById.get(id(effectiveEntitlement.planId)) :
    cachedPlanCurrent || legacyPreferred ? planById.get(id(user.plan)) : null;
  const effectivePlan = { basis: legacyPreferred ? 'legacy_recurring_priority' : effectiveEntitlement ? 'durable_entitlement' : 'cached_user_plan_or_free',
    entitlementId: id(effectiveEntitlement?._id), planId: id(effectivePlanDoc?._id),
    slug: effectivePlanDoc?.slug || (effectiveEntitlement ? effectiveEntitlement.planSlug : 'free'),
    name: effectivePlanDoc?.name || null, startsAt: iso(effectiveEntitlement?.startsAt || (legacyPreferred ? user.paypalCurrentPeriodStart : cachedPlanCurrent ? user.planStartedAt : null)),
    endsAt: iso(effectiveEntitlement?.endsAt || (legacyPreferred ? user.paypalCurrentPeriodEnd : cachedPlanCurrent ? user.planExpiresAt : null)),
    readOnlyApproximation: true };

  const entitlementRows = entitlements.map((item, index) => {
    const plan = planById.get(id(item.planId));
    const linked = attemptById.get(id(item.paymentAttemptId));
    return { id: id(item._id), planId: id(item.planId), planSlug: plan?.slug || item.planSlug,
      planName: plan?.name || null, status: item.status, source: item.source,
      sourceReference: item.source === 'paypal' ? mask(item.providerCaptureId || item.providerOrderId) : null,
      billingPeriod: item.billingPeriod, startsAt: iso(item.startsAt), endsAt: iso(item.endsAt),
      supersededAt: iso(item.supersededAt), supersededBy: id(item.supersededBy),
      createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt),
      purchaseAttemptId: id(item.paymentAttemptId), providerOrderPresent: Boolean(item.providerOrderId),
      providerCapturePresent: Boolean(item.providerCaptureId), admin: item.source === 'admin' ? {
        assignedBy: id(item.assignedBy), adminOperationPresent: Boolean(item.adminOperationId),
        adminQuotePresent: Boolean(item.adminQuoteId), reasonPresent: Boolean(item.adminReason),
        legacyMigrationMarker: item.adminReason === 'Legacy plan migration' } : null,
      currentlyEffective: id(effectiveEntitlement?._id) === id(item._id),
      currentQuoteEntitlement: id(quoteCurrent?._id) === id(item._id),
      future: futureCandidate(item, now),
      expired: Boolean(item.status === 'expired' || (item.endsAt && new Date(item.endsAt) <= now)),
      candidateForScheduledReview: futureCandidate(item, now),
      blocksUpgrade: Boolean(quoteWouldReturnScheduledConflict && futureCandidate(item, now) && futureConflict),
      verifiedPaymentHistoryAvailable: internallyVerifiedPayment(item, linked),
      classification: quoteWouldReturnScheduledConflict && futureCandidate(item, now) && futureConflict
        ? classifyBlocker(item, linked, quoteCurrent, entitlements[index - 1]) : null };
  });
  const blockingEntitlements = entitlementRows.filter(item => item.blocksUpgrade);
  const classes = [...new Set(blockingEntitlements.map(item => item.classification))];
  const classification = !blockingEntitlements.length ? 'CANNOT_CLASSIFY_SAFELY' :
    classes.length === 1 ? classes[0] :
      classes.every(item => ['GENUINE_PAID_SCHEDULED_TERM', 'SAME_PLAN_RENEWAL'].includes(item)) ?
        'GENUINE_PAID_SCHEDULED_TERM' : 'CANNOT_CLASSIFY_SAFELY';
  const reason = blockingEntitlements.length ?
    `Pro Monthly quote is blocked because ${blockingEntitlements.length} future active/scheduled entitlement(s) have startsAt after the diagnostic time and endsAt null or after it; immediate upgrade does not preserve or credit future coverage.` :
    multipleCurrent && quoteWouldReturnScheduledConflict ?
      'The quote would return the scheduled-review code because multiple eligible entitlements start at or before now; no single future blocker can be identified.' :
      'No entitlement currently satisfies the future scheduled-review predicate for a Pro Monthly upgrade. Historical timing, different database/account, or changed state requires review.';

  const purchaseAttempts = attempts.map(item => ({ id: id(item._id), purpose: item.purpose,
    planSlug: item.planSlug, billingPeriod: item.billingPeriod, status: item.status,
    expectedAmount: item.expectedAmount, currency: item.currency, fulfilled: item.status === 'fulfilled',
    createdAt: iso(item.createdAt), fulfilledAt: iso(item.fulfilledAt),
    fulfilledAtNote: item.fulfilledAt ? null : 'No fulfilledAt field is stored; updatedAt is not proof of fulfillment time.',
    capturedAt: iso(item.capturedAt), updatedAt: iso(item.updatedAt), entitlementId: id(item.entitlementId),
    linkedEntitlementIds: entitlements.filter(entitlement => id(entitlement.paymentAttemptId) === id(item._id)).map(entitlement => id(entitlement._id)),
    sourceEntitlementId: item.pricingSnapshot?.currentEntitlementId || null,
    historicalPaymentId: item.pricingSnapshot?.historicalPaymentId || null,
    historicalPaidAmount: item.pricingSnapshot?.historicalPaidAmount || null,
    transition: item.pricingSnapshot?.transition || null,
    prorationCredit: item.pricingSnapshot?.prorationCredit || null,
    paypalOrderPresent: Boolean(item.providerOrderId), paypalOrderMasked: mask(item.providerOrderId),
    paypalCapturePresent: Boolean(item.providerCaptureId), paypalCaptureMasked: mask(item.providerCaptureId),
    providerEnvironment: item.providerEnvironment || null }));

  const pendingAttempt = account?.pendingAttempt ? attempts.find(item => item.attemptId === account.pendingAttempt) : null;
  return { diagnosticAt: now.toISOString(), targetPlan: { slug: TARGET_SLUG, billingPeriod: 'monthly', available: Boolean(targetPlan) },
    user: { id: id(user._id), email: user.email, role: user.role,
      cachedPlanId: id(user.plan), cachedPlanSlug: planById.get(id(user.plan))?.slug || null,
      planStartedAt: iso(user.planStartedAt), planExpiresAt: iso(user.planExpiresAt),
      paypalSubscriptionStatus: user.paypalSubscriptionStatus || null,
      paypalCurrentPeriodStart: iso(user.paypalCurrentPeriodStart), paypalCurrentPeriodEnd: iso(user.paypalCurrentPeriodEnd) },
    effectivePlan, quoteContext: { currentEntitlementId: id(quoteCurrent?._id), currentPlanSlug: quoteCurrent?.planSlug || null,
      currentStartsAt: iso(quoteCurrent?.startsAt), currentEndsAt: iso(quoteCurrent?.endsAt),
      eligibleEntitlementCount: quoteRows.length, futureEntitlementCount: quoteFuture.length,
      higherTierUpgrade: higherUpgrade, recurringBlocksPrepaid: legacyPreferred,
      quoteWouldReturnScheduledConflict },
    entitlements: entitlementRows, purchaseAttempts,
    legacyRecurring: { exists: Boolean(user.paypalSubscriptionId || recurringAttempts.length),
      subscriptionReferenceMasked: mask(user.paypalSubscriptionId), status: user.paypalSubscriptionStatus || null,
      planReferenceMasked: mask(user.paypalPlanId), currentPeriodEnd: iso(user.paypalCurrentPeriodEnd),
      resolverPrefersLegacy: legacyPreferred,
      checkoutAttempts: recurringAttempts.map(item => ({ id: id(item._id), planKey: item.planKey,
        billingInterval: item.billingInterval, status: item.status, subscriptionReferencePresent: Boolean(item.providerSubscriptionId),
        createdAt: iso(item.createdAt), completedAt: iso(item.completedAt) })),
      managementAttempts: managementAttempts.map(item => ({ id: id(item._id), operation: item.operation,
        status: item.status, sourcePlanKey: item.sourcePlanKey || null, targetPlanKey: item.targetPlanKey || null,
        createdAt: iso(item.createdAt), completedAt: iso(item.completedAt) })) },
    billingAccount: account ? { exists: true, revision: account.revision, pendingAttemptPresent: Boolean(account.pendingAttempt),
      pendingAttemptMasked: mask(account.pendingAttempt), pendingAttemptStatus: pendingAttempt?.status || null,
      updatedAt: iso(account.updatedAt), entitlementLockPresent: Boolean(lock),
      entitlementLockExpiresAt: iso(lock?.leaseExpiresAt) } : { exists: false, entitlementLockPresent: Boolean(lock),
      entitlementLockExpiresAt: iso(lock?.leaseExpiresAt) },
    blockingEntitlements, classification, reason, dataChangesPerformed: 'NONE' };
}

async function main(argv = process.argv.slice(2)) {
  let email;
  try {
    if (argv.length !== 1) throw new Error('EXPECTED_ONE_TEACHER_EMAIL');
    email = normalizeEmail(argv[0]);
  } catch (error) { console.error(`Input error: ${error.message}`); return 1; }
  require('dotenv').config({ quiet: true });
  if (!process.env.MONGO_URI) { console.error('Database connection error: MONGO_URI_MISSING'); return 2; }
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false,
      serverSelectionTimeoutMS: MAX_TIME_MS, connectTimeoutMS: MAX_TIME_MS, maxPoolSize: 2 });
    const diagnostic = await inspect(email);
    const stamp = diagnostic.diagnosticAt.replace(/[-:.]/gu, '').replace('T', '-').replace('Z', 'Z');
    const file = path.resolve(__dirname, '..', `billing-diagnostic-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Diagnostic: ${file}`);
    console.log(`User: ${diagnostic.user.email} (${diagnostic.user.id})`);
    console.log(`Effective: ${diagnostic.effectivePlan.slug} ${diagnostic.effectivePlan.startsAt || 'unknown'} → ${diagnostic.effectivePlan.endsAt || 'open'}`);
    console.log(`Entitlements: ${diagnostic.entitlements.length}; future quote candidates: ${diagnostic.quoteContext.futureEntitlementCount}`);
    for (const item of diagnostic.blockingEntitlements) console.log(`Blocking: ${item.id} ${item.planSlug} ${item.status} ${item.source} ${item.startsAt} → ${item.endsAt || 'open'}; linked payment: ${item.verifiedPaymentHistoryAvailable ? 'internally verified' : 'unverified'}`);
    console.log(`Classification: ${diagnostic.classification}`);
    console.log(`Reason: ${diagnostic.reason}`);
    console.log('Data changes performed: NONE');
    return 0;
  } catch (error) {
    if (error.exitCode === 1) { console.error(`Input error: ${error.message}`); return 1; }
    console.error(`Database/read error: ${error.code || error.name || 'UNKNOWN'}`);
    return 2;
  } finally { try { await mongoose.disconnect(); } catch (_) { /* Preserve the diagnostic exit code. */ } }
}

if (require.main === module) main().then(code => { process.exit(code); }, error => {
  console.error(`Database/read error: ${error.code || error.name || 'UNKNOWN'}`);
  process.exit(2);
});
module.exports = { normalizeEmail, quoteEligible, futureCandidate, classifyBlocker, inspect, main };
