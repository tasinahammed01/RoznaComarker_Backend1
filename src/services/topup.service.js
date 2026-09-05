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

async function eligiblePack(user, code, { provider = 'stripe' } = {}) {
  const pack = await CreditPack.findOne({ code: String(code || '').trim().toUpperCase(), active: true });
  if (!pack) throw Object.assign(new Error('This credit pack is not available.'), { statusCode: 404, code: 'CREDIT_PACK_NOT_FOUND' });
  const state = await CreditService.getOrCreateWallet(user);
  const planSlug = String(state.plan.slug || state.plan.name).toLowerCase();
  if (!pack.allowedPlans.map((item) => String(item).toLowerCase()).includes(planSlug)) {
    throw Object.assign(new Error("This credit pack isn't available for your current plan."), { statusCode: 403, code: 'CREDIT_PACK_NOT_ELIGIBLE' });
  }
  if (provider === 'stripe' && !pack.stripePriceId) throw Object.assign(new Error("We couldn't start the payment. Please try again."), { statusCode: 503, code: 'CREDIT_PACK_PAYMENT_NOT_CONFIGURED' });
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

async function grantProviderPurchasedCredits({ userId, pack, idempotencyKey, reason, metadata }) {
  let transaction = await CreditTransaction.findOne({ idempotencyKey });
  if (transaction?.status === 'committed') {
    await CreditWallet.updateOne({ userId, 'pendingPurchaseOperation.idempotencyKey': idempotencyKey },
      { $unset: { pendingPurchaseOperation: 1 } });
    return { granted: false, transaction };
  }
  if (!transaction) {
    try {
      transaction = await CreditTransaction.create({ userId, type: 'TOPUP_PURCHASE_PENDING', status: 'pending',
        amount: pack.credits, balanceAfter: 0, reason, idempotencyKey, metadata });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      transaction = await CreditTransaction.findOne({ idempotencyKey });
      if (transaction?.status === 'committed') return { granted: false, transaction };
    }
  }
  const state = await CreditService.getOrCreateWallet(userId);
  const result = await runProviderPurchaseOperation({ walletId: state.wallet._id, transaction, idempotencyKey,
    kind: 'grant', credits: pack.credits });
  return { granted: result.applied, transaction: result.transaction };
}

async function reverseProviderPurchase({ purchase, idempotencyKey, reason, metadata, reviewOnly = false }) {
  let transaction = await CreditTransaction.findOne({ idempotencyKey });
  if (transaction && transaction.status !== 'pending') {
    await CreditWallet.updateOne({ userId: purchase.userId, 'pendingPurchaseOperation.idempotencyKey': idempotencyKey },
      { $unset: { pendingPurchaseOperation: 1 } });
    return transaction;
  }
  const credits = Number(purchase.metadata?.creditsPurchased || purchase.amount);
  const wallet = await CreditWallet.findOne({ userId: purchase.userId });
  if (!wallet) throw new Error('Credit wallet was not found for provider purchase reversal');
  if (!transaction) {
    const removable = !reviewOnly && Number(wallet.purchasedCredits || 0) >= credits;
    try {
      transaction = await CreditTransaction.create({ userId: purchase.userId, type: 'TOPUP_REFUND',
        status: removable ? 'pending' : 'review_required', amount: removable ? -credits : 0,
        balanceAfter: CreditService.available(wallet),
        reason: removable ? reason : 'Refund or reversal requires admin review because credits were used or the refund was partial',
        idempotencyKey, metadata: { ...metadata, originalTransactionId: String(purchase._id), credits } });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      transaction = await CreditTransaction.findOne({ idempotencyKey });
    }
  }
  if (transaction.status !== 'pending') return transaction;
  return (await runProviderPurchaseOperation({ walletId: wallet._id, transaction, idempotencyKey,
    kind: 'reversal', credits })).transaction;
}

async function recoverProviderPurchaseOperation(walletId) {
  let wallet = await CreditWallet.findById(walletId).select('+pendingPurchaseOperation');
  const operation = wallet?.pendingPurchaseOperation;
  if (!operation) return null;
  let transaction = await CreditTransaction.findById(operation.transactionId);
  if (!transaction) throw new Error('Provider purchase operation has no durable transaction');

  let applied = false;
  if (operation.state === 'claimed' && transaction.status === 'pending') {
    const balanceExpression = operation.kind === 'grant'
      ? { $add: ['$purchasedCredits', operation.credits] }
      : { $subtract: ['$purchasedCredits', operation.credits] };
    const query = { _id: walletId, 'pendingPurchaseOperation.idempotencyKey': operation.idempotencyKey,
      'pendingPurchaseOperation.state': 'claimed' };
    if (operation.kind === 'reversal') query.purchasedCredits = { $gte: operation.credits };
    wallet = await CreditWallet.findOneAndUpdate(query, [{ $set: {
      purchasedCredits: balanceExpression, 'pendingPurchaseOperation.state': 'applied'
    } }], { returnDocument: 'after', updatePipeline: true }).select('+pendingPurchaseOperation');
    applied = !!wallet;
    if (!wallet && operation.kind === 'reversal') {
      const current = await CreditWallet.findById(walletId).select('+pendingPurchaseOperation');
      if (current?.pendingPurchaseOperation?.idempotencyKey === operation.idempotencyKey &&
        current.pendingPurchaseOperation.state === 'claimed') {
        transaction = await CreditTransaction.findOneAndUpdate({ _id: transaction._id, status: 'pending' }, { $set: {
          status: 'review_required', amount: 0, balanceAfter: CreditService.available(current),
          reason: 'Refund or reversal requires admin review because credits were used or the refund was partial'
        } }, { returnDocument: 'after' }) || await CreditTransaction.findById(transaction._id);
        await CreditWallet.updateOne({ _id: walletId,
          'pendingPurchaseOperation.idempotencyKey': operation.idempotencyKey }, { $unset: { pendingPurchaseOperation: 1 } });
        return { applied: false, transaction };
      }
    }
  }

  wallet = wallet || await CreditWallet.findById(walletId).select('+pendingPurchaseOperation');
  const currentOperation = wallet?.pendingPurchaseOperation;
  if (transaction.status === 'pending' && currentOperation?.idempotencyKey === operation.idempotencyKey &&
    currentOperation.state === 'applied') {
    transaction = await CreditTransaction.findOneAndUpdate({ _id: transaction._id, status: 'pending' }, { $set: {
      type: operation.kind === 'grant' ? 'TOPUP_PURCHASE_COMPLETED' : 'TOPUP_REFUND',
      status: operation.kind === 'grant' ? 'committed' : 'refunded',
      balanceAfter: CreditService.available(wallet)
    } }, { returnDocument: 'after' }) || await CreditTransaction.findById(transaction._id);
  }
  if (!['committed', 'refunded', 'review_required'].includes(transaction.status)) {
    throw new Error('Provider purchase operation could not be finalized');
  }
  await CreditWallet.updateOne({ _id: walletId,
    'pendingPurchaseOperation.idempotencyKey': operation.idempotencyKey }, { $unset: { pendingPurchaseOperation: 1 } });
  return { applied, transaction };
}

async function runProviderPurchaseOperation({ walletId, transaction, idempotencyKey, kind, credits }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await CreditWallet.findById(walletId).select('+pendingPurchaseOperation');
    const operation = current?.pendingPurchaseOperation;
    if (operation) {
      const recovered = await recoverProviderPurchaseOperation(walletId);
      if (operation.idempotencyKey === idempotencyKey && recovered) return recovered;
      if (operation.idempotencyKey === idempotencyKey) {
        const finalized = await CreditTransaction.findOne({ idempotencyKey });
        if (finalized && finalized.status !== 'pending') return { applied: false, transaction: finalized };
      }
      continue;
    }
    const claimed = await CreditWallet.findOneAndUpdate({ _id: walletId,
      $or: [{ pendingPurchaseOperation: { $exists: false } }, { pendingPurchaseOperation: null }] }, { $set: {
      pendingPurchaseOperation: { idempotencyKey, transactionId: transaction._id, kind, credits,
        state: 'claimed', startedAt: new Date() }
    } }, { returnDocument: 'after' });
    if (claimed) return recoverProviderPurchaseOperation(walletId);
  }
  throw new Error('Credit wallet has another provider purchase operation in progress');
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

module.exports = { publicPack, listPacks, eligiblePack, grantPurchasedCredits, grantProviderPurchasedCredits,
  reverseProviderPurchase, recordFailedPurchase, refundPurchase };
