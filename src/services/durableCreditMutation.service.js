'use strict';

const CreditWallet = require('../models/CreditWallet');
const CreditTransaction = require('../models/CreditTransaction');

async function verifyIndex() {
  await CreditTransaction.init();
  const indexes = await CreditTransaction.collection.indexes();
  if (!indexes.some(index => index.unique === true && !index.partialFilterExpression && !index.sparse
    && index.key.idempotencyKey === 1 && Object.keys(index.key).length === 1)) {
    throw Object.assign(new Error('Unique credit idempotency index is required'), { code: 'CREDIT_INDEX_REQUIRED', statusCode: 503 });
  }
}

async function reconcile(wallet) {
  const receipt = wallet.pendingCreditOperation;
  if (!receipt) return;
  const committed = await CreditTransaction.findOneAndUpdate({
    userId: wallet.userId, idempotencyKey: receipt.idempotencyKey, status: { $in: ['pending', receipt.outcome || 'committed'] }
  }, { $set: { status: receipt.outcome || 'committed', balanceAfter: receipt.balanceAfter,
    'metadata.failure': receipt.failure,
    'metadata.creditBucket': receipt.creditBucket } }, { new: true });
  if (!committed) throw Object.assign(new Error('Credit receipt has no ledger claim'), { code: 'CREDIT_RECONCILIATION_REQUIRED', statusCode: 503 });
  await CreditWallet.updateOne({ _id: wallet._id, 'pendingCreditOperation.idempotencyKey': receipt.idempotencyKey },
    { $unset: { pendingCreditOperation: 1 } });
}

// The wallet balance and receipt change in ONE MongoDB write. A crash at any
// subsequent point leaves the receipt available for replay, never compensation.
// CAS includes a monotonic version so a worker paused before receipt cleanup cannot apply
// its stale decision after another worker commits and clears that receipt.
async function mutate({ walletId, entry, decide, available }) {
  await verifyIndex();
  // Reject ordinary insufficient requests before creating a claim or changing a wallet.
  const existing = await CreditTransaction.findOne({ idempotencyKey: entry.idempotencyKey });
  if (!existing) {
    const initial = await CreditWallet.findById(walletId);
    if (!initial) throw new Error('Credit wallet not found');
    if (initial.pendingCreditOperation) await reconcile(initial);
    try { decide(await CreditWallet.findById(walletId)); } catch (error) {
      // A concurrent replay may already have consumed the final credit.
      if (!await CreditTransaction.exists({ idempotencyKey: entry.idempotencyKey })) throw error;
    }
  }
  try {
    await CreditTransaction.create({ ...entry, metadata: { ...entry.metadata, durableProtocol: 1 }, status: 'pending', balanceAfter: 0 });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const wallet = await CreditWallet.findById(walletId);
    if (!wallet) throw new Error('Credit wallet not found');
    if (wallet.pendingCreditOperation) {
      await reconcile(wallet);
      continue;
    }
    const transaction = await CreditTransaction.findOne({ idempotencyKey: entry.idempotencyKey });
    if (!transaction || String(transaction.userId) !== String(entry.userId) || transaction.amount !== entry.amount || transaction.type !== entry.type) {
      throw Object.assign(new Error('Credit idempotency key conflicts with another operation'), { statusCode: 409 });
    }
    if (transaction.status === 'committed') return { charged: false, transaction, availableCredits: transaction.balanceAfter };
    if (transaction.status === 'failed' && transaction.metadata?.failure) {
      throw Object.assign(new Error(transaction.metadata.failure.message), transaction.metadata.failure);
    }
    if (transaction.status !== 'pending') throw Object.assign(new Error('Credit transaction requires review'), { statusCode: 409 });
    if (transaction.metadata?.durableProtocol !== 1) throw Object.assign(new Error('Legacy pending credit requires reconciliation before replay'), { code: 'CREDIT_RECONCILIATION_REQUIRED', statusCode: 503 });
    let increments = {}, bucket, failure;
    try { ({ increments, bucket } = decide(wallet)); } catch (error) {
      if (error.code !== 'INSUFFICIENT_ASSESSMENT_CREDITS') throw error;
      failure = { message: error.message, code: error.code, statusCode: error.statusCode };
    }
    const after = wallet.toObject();
    for (const [field, amount] of Object.entries(increments)) after[field] = Number(after[field] || 0) + amount;
    const updated = await CreditWallet.findOneAndUpdate({ _id: wallet._id, updatedAt: wallet.updatedAt,
      $expr: { $eq: [{ $ifNull: ['$creditMutationVersion', 0] }, wallet.creditMutationVersion || 0] },
      pendingCreditOperation: { $exists: false },
      monthlyCreditsUsed: wallet.monthlyCreditsUsed, bonusCredits: wallet.bonusCredits,
      purchasedCredits: wallet.purchasedCredits, monthlyCredits: wallet.monthlyCredits
    }, { $inc: { ...increments, creditMutationVersion: 1 }, $set: { pendingCreditOperation: {
      idempotencyKey: entry.idempotencyKey, balanceAfter: available(after), creditBucket: bucket,
      outcome: failure ? 'failed' : 'committed', failure
    } } }, { new: true });
    if (!updated) continue;
    await reconcile(updated);
    if (failure) throw Object.assign(new Error(failure.message), failure);
    return { charged: true, transaction: await CreditTransaction.findOne({ idempotencyKey: entry.idempotencyKey }),
      availableCredits: available(after), beforeWallet: wallet.toObject(), afterWallet: updated };
  }
  throw Object.assign(new Error('Credit mutation is busy; retry with the same idempotency key'), { code: 'CREDIT_DEBIT_PROCESSING', statusCode: 409 });
}

module.exports = { mutate, reconcile, verifyIndex };
