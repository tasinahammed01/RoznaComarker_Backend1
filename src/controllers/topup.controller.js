const crypto = require('crypto');
const { getStripe, getFrontendUrl } = require('../services/stripe.service');
const TopupService = require('../services/topup.service');

const fail = (res, error) => res.status(error?.statusCode || 500).json({ success: false,
  ...(error?.code ? { code: error.code } : {}), message: error?.statusCode ? error.message : "We couldn't start the payment. Please try again." });

async function packs(req, res) {
  try { return res.json({ success: true, paymentProvider: String(process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase(),
    packs: await TopupService.listPacks() }); }
  catch (error) { return fail(res, error); }
}

async function checkout(req, res) {
  try {
    const { pack, state } = await TopupService.eligiblePack(req.user, req.body?.packCode);
    const stripe = getStripe();
    const trustedPrice = await stripe.prices.retrieve(pack.stripePriceId);
    const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
    const expectedAmount = Math.round(Number(pack.price) * 100);
    if (!!trustedPrice.livemode !== expectedLiveMode || !trustedPrice.active || trustedPrice.type !== 'one_time' || trustedPrice.unit_amount !== expectedAmount ||
      String(trustedPrice.currency).toUpperCase() !== String(pack.currency).toUpperCase()) {
      throw Object.assign(new Error("We couldn't start the payment. Please try again."),
        { statusCode: 503, code: 'CREDIT_PACK_PAYMENT_MISMATCH' });
    }
    const frontend = getFrontendUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', customer: state.user.stripeCustomerId || undefined,
      customer_email: state.user.stripeCustomerId ? undefined : state.user.email,
      line_items: [{ price: pack.stripePriceId, quantity: 1 }],
      success_url: `${frontend}/teacher/dashboard?topup=confirming&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/teacher/dashboard?topup=cancelled`,
      client_reference_id: String(state.user._id),
      metadata: { kind: 'assessment_credit_topup', userId: String(state.user._id), packCode: pack.code },
      payment_intent_data: { metadata: { kind: 'assessment_credit_topup', userId: String(state.user._id), packCode: pack.code } }
    }, { idempotencyKey: `rozna-topup:${state.user._id}:${pack.code}:${crypto.randomUUID()}` });
    return res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) { return fail(res, error); }
}

module.exports = { packs, checkout };
