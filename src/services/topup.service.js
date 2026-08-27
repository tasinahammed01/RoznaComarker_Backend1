const CreditPack = require('../models/CreditPack');
const CreditTransaction = require('../models/CreditTransaction');
const CreditWallet = require('../models/CreditWallet');
const CreditService = require('./credit.service');

function publicPack(pack) {
  return { name: pack.name, code: pack.code, credits: pack.credits, price: pack.price,
    currency: pack.currency, allowedPlans: pack.allowedPlans, displayOrder: pack.displayOrder };
}

async function listPacks() {
  return (await CreditPack.find({ active: true }).sort({ displayOrder: 1, code: 1 }).lean()).map(publicPack);
}

async function eligiblePack(user, code) {
  const pack = await CreditPack.findOne({ code: String(code || '').trim().toUpperCase(), active: true });
  if (!pack) throw Object.assign(new Error('This credit pack is not available.'), { statusCode: 404, code: 'CREDIT_PACK_NOT_FOUND' });
  const state = await CreditService.getOrCreateWallet(user);
  const planSlug = String(state.plan.slug || state.plan.name).toLowerCase();
  if (!pack.allowedPlans.map((item) => String(item).toLowerCase()).includes(planSlug)) {
    throw Object.assign(new Error("This credit pack isn't available for your current plan."), { statusCode: 403, code: 'CREDIT_PACK_NOT_ELIGIBLE' });
  }
  if (!pack.stripePriceId) throw Object.assign(new Error("We couldn't start the payment. Please try again."), { statusCode: 503, code: 'CREDIT_PACK_PAYMENT_NOT_CONFIGURED' });
  return { pack, state };
}

async function grantPurchasedCredits({ userId, pack, session }) {
  const sessionId = String(session.id);
  const idempotencyKey = `topup:${sessionId}`;
  const existing = await CreditTransaction.findOne({ idempotencyKey });
  if (existing?.status === 'committed') return { granted: false, transaction: existing };
  try {
    await CreditTransaction.create({ userId, type: 'TOPUP_PURCHASE_PENDING', status: 'pending', amount: pack.credits,
      balanceAfter: 0, reason: `Assessment Credit purchase: ${pack.name}`, idempotencyKey,
      metadata: { packCode: pack.code, stripeCheckoutSessionId: sessionId, stripePaymentIntentId: String(session.payment_intent || ''),
        creditsPurchased: pack.credits, pricePaid: Number(session.amount_total || Math.round(pack.price * 100)) / 100,
        currency: String(session.currency || pack.currency).toUpperCase() } });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { granted: false, transaction: await CreditTransaction.findOne({ idempotencyKey }) };
  }
  const state = await CreditService.getOrCreateWallet(userId);
  const wallet = await CreditWallet.findOneAndUpdate({ _id: state.wallet._id }, { $inc: { purchasedCredits: pack.credits } }, { new: true });
  try {
    const transaction = await CreditTransaction.findOneAndUpdate({ idempotencyKey, status: 'pending' }, { $set: {
      type: 'TOPUP_PURCHASE_COMPLETED', status: 'committed', balanceAfter: CreditService.available(wallet) } }, { new: true });
    if (!transaction) throw new Error('Top-up purchase claim was lost');
    return { granted: true, transaction };
  } catch (error) {
    await CreditWallet.updateOne({ _id: wallet._id }, { $inc: { purchasedCredits: -pack.credits } });
    await CreditTransaction.deleteOne({ idempotencyKey, status: 'pending' });
    throw error;
  }
}

async function recordFailedPurchase({ userId, packCode, session }) {
  if (!userId || !session?.id) return null;
  return CreditTransaction.findOneAndUpdate({ idempotencyKey: `topup-failed:${session.id}` }, { $setOnInsert: { userId,
    type: 'TOPUP_PURCHASE_FAILED', status: 'failed', amount: 0, balanceAfter: 0, reason: 'Assessment Credit payment failed',
    idempotencyKey: `topup-failed:${session.id}`, metadata: { packCode, stripeCheckoutSessionId: session.id } } }, { upsert: true, new: true });
}

async function refundPurchase(charge) {
  const paymentIntentId = String(charge.payment_intent || '');
  const purchase = await CreditTransaction.findOne({ type: 'TOPUP_PURCHASE_COMPLETED',
    'metadata.stripePaymentIntentId': paymentIntentId, status: 'committed' });
  if (!purchase) return null;
  const credits = Number(purchase.metadata?.creditsPurchased || purchase.amount);
  const key = `topup-refund:${charge.id}:${charge.amount_refunded}`;
  const old = await CreditTransaction.findOne({ idempotencyKey: key }); if (old) return old;
  const wallet = await CreditWallet.findOne({ userId: purchase.userId });
  const removable = Number(wallet?.purchasedCredits || 0) >= credits;
  let updated = wallet;
  if (removable) updated = await CreditWallet.findOneAndUpdate({ _id: wallet._id, purchasedCredits: { $gte: credits } },
    { $inc: { purchasedCredits: -credits } }, { new: true });
  return CreditTransaction.create({ userId: purchase.userId, type: 'TOPUP_REFUND',
    status: removable && updated ? 'refunded' : 'review_required', amount: removable && updated ? -credits : 0,
    balanceAfter: updated ? CreditService.available(updated) : CreditService.available(wallet),
    reason: removable && updated ? 'Purchased credits refunded' : 'Refund requires admin review because purchased credits were already used',
    idempotencyKey: key, metadata: { originalTransactionId: String(purchase._id), stripeChargeId: charge.id,
      stripePaymentIntentId: paymentIntentId, credits, amountRefunded: Number(charge.amount_refunded || 0) / 100,
      currency: String(charge.currency || '').toUpperCase() } });
}

module.exports = { publicPack, listPacks, eligiblePack, grantPurchasedCredits, recordFailedPurchase, refundPurchase };
