const Plan = require('../models/Plan');
const User = require('../models/user.model');
const logger = require('../utils/logger');

const ENTITLED_STATUSES = new Set(['active', 'trialing']);
const CHECKOUT_BLOCKING_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

function isSubscriptionEntitled(status, currentPeriodEnd, now = Date.now()) {
  if (ENTITLED_STATUSES.has(status)) return true;
  const end = currentPeriodEnd instanceof Date ? currentPeriodEnd : new Date(currentPeriodEnd || 0);
  return status === 'past_due' && !Number.isNaN(end.getTime()) && end.getTime() > now;
}

function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function dateFromUnix(value) {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

function getPeriod(subscription) {
  const item = subscription?.items?.data?.[0];
  return {
    start: dateFromUnix(subscription?.current_period_start ?? item?.current_period_start),
    end: dateFromUnix(subscription?.current_period_end ?? item?.current_period_end)
  };
}

function getPriceId(subscription) {
  return idOf(subscription?.items?.data?.[0]?.price);
}

async function findUser(subscription) {
  const subscriptionId = idOf(subscription);
  const customerId = idOf(subscription?.customer);
  if (!customerId) return null;
  const user = await User.findOne({ stripeCustomerId: customerId, role: 'teacher' });
  if (!user) return null;
  if (subscriptionId && user.stripeSubscriptionId && user.stripeSubscriptionId !== subscriptionId) {
    logger.warn(`stripe identity mismatch userId=${user._id} customer=${customerId} receivedSubscription=${subscriptionId}`);
    return null;
  }
  return user;
}

async function syncSubscription(subscription, invoice) {
  const user = await findUser(subscription);
  if (!user || user.role !== 'teacher') return null;

  const priceId = getPriceId(subscription);
  const paidPlan = priceId
    ? await Plan.findOne({ isActive: true, 'stripe.priceId': priceId })
    : null;
  const freePlan = await Plan.findOne({ slug: 'free', isActive: true });
  const period = getPeriod(subscription);
  const entitled = !!paidPlan && isSubscriptionEntitled(subscription.status, period.end);

  user.stripeCustomerId = idOf(subscription.customer) || user.stripeCustomerId;
  user.stripeSubscriptionId = idOf(subscription);
  user.stripePriceId = priceId;
  user.stripeProductId = idOf(subscription?.items?.data?.[0]?.price?.product) || user.stripeProductId;
  user.stripeSubscriptionStatus = subscription.status;
  user.stripeCurrentPeriodStart = period.start;
  user.stripeCurrentPeriodEnd = period.end;
  user.stripeCancelAtPeriodEnd = !!subscription.cancel_at_period_end;
  user.stripeCanceledAt = dateFromUnix(subscription.canceled_at);
  if (invoice) {
    user.stripeLatestInvoiceId = idOf(invoice);
    user.stripeLatestInvoiceStatus = invoice.status || null;
    user.stripeLastPaymentFailedAt = invoice.status === 'paid' ? null : new Date();
  }

  if (entitled) {
    user.plan = paidPlan._id;
    user.planStartedAt = period.start || user.planStartedAt || new Date();
    user.planExpiresAt = period.end;
  } else if (freePlan) {
    user.plan = freePlan._id;
    user.planStartedAt = new Date();
    user.planExpiresAt = null;
  }
  await user.save();
  logger.info(`stripe subscription sync userId=${user._id} customer=${user.stripeCustomerId || '-'} subscription=${user.stripeSubscriptionId || '-'} plan=${entitled ? paidPlan.slug : 'free'} status=${subscription.status}`);
  return user;
}

async function associateCheckoutSession(session) {
  const userId = session?.client_reference_id;
  const customerId = idOf(session?.customer);
  if (!userId || !customerId) return null;
  return User.findOneAndUpdate(
    { _id: userId, role: 'teacher', stripeCustomerId: customerId },
    {
      $set: {
        stripeSubscriptionId: idOf(session.subscription)
      }
    },
    { returnDocument: 'after' }
  );
}

module.exports = {
  ENTITLED_STATUSES,
  CHECKOUT_BLOCKING_STATUSES,
  isSubscriptionEntitled,
  idOf,
  getPriceId,
  syncSubscription,
  associateCheckoutSession
};
