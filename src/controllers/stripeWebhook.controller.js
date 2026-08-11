const StripeEvent = require('../models/StripeEvent');
const User = require('../models/user.model');
const logger = require('../utils/logger');
const { getStripe } = require('../services/stripe.service');
const { idOf, syncSubscription, associateCheckoutSession } = require('../services/stripeSubscription.service');

function invoiceSubscriptionId(invoice) {
  return idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription);
}

async function handleEvent(event) {
  const stripe = getStripe();
  const object = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const associatedUser = await associateCheckoutSession(object);
    if (!associatedUser) return;
    const subscriptionId = idOf(object.subscription);
    if (subscriptionId) await syncSubscription(await stripe.subscriptions.retrieve(subscriptionId));
  } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    await syncSubscription(object);
  } else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
    const subscriptionId = invoiceSubscriptionId(object);
    if (subscriptionId) {
      await syncSubscription(await stripe.subscriptions.retrieve(subscriptionId), object);
    } else if (event.type === 'invoice.payment_failed') {
      await User.updateOne(
        { stripeCustomerId: idOf(object.customer), role: 'teacher' },
        { $set: { stripeLatestInvoiceId: idOf(object), stripeLatestInvoiceStatus: object.status || 'open', stripeLastPaymentFailedAt: new Date() } }
      );
    }
  }
}

async function stripeWebhook(req, res) {
  const signature = req.headers['stripe-signature'];
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) return res.status(503).send('Webhook is not configured');
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, signature, secret);
  } catch {
    return res.status(400).send('Invalid webhook signature');
  }

  const supported = new Set([
    'checkout.session.completed', 'customer.subscription.created',
    'customer.subscription.updated', 'customer.subscription.deleted',
    'invoice.paid', 'invoice.payment_failed'
  ]);
  if (!supported.has(event.type)) return res.json({ received: true });

  try {
    await StripeEvent.create({ stripeEventId: event.id, eventType: event.type });
  } catch (err) {
    if (err?.code === 11000) return res.json({ received: true, duplicate: true });
    throw err;
  }

  try {
    await handleEvent(event);
    logger.info(`stripe webhook eventId=${event.id} type=${event.type}`);
    return res.json({ received: true });
  } catch (err) {
    await StripeEvent.deleteOne({ stripeEventId: event.id });
    logger.error(`stripe webhook processing failed eventId=${event.id} type=${event.type} message=${err?.message || 'unknown'}`);
    return res.status(500).send('Webhook processing failed');
  }
}

module.exports = { stripeWebhook };
