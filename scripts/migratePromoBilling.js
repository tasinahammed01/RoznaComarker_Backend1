'use strict';
// Additive indexes only. Never syncIndexes(), rewrite history, or delete data.
const mongoose = require('mongoose');
const models = ['BillingAccount', 'BillingQuote', 'PromoCode', 'PromoUsage',
  'PaymentPurchaseAttempt', 'PlanEntitlement', 'AdminAuditLog'].map(name => require(`../src/models/${name}`));
function parseCliArgs(argv = []) {
  if (argv.some(arg => !['--apply', '--backup-confirmed'].includes(arg)) || new Set(argv).size !== argv.length) throw new Error('UNKNOWN_CLI_ARGUMENT');
  const apply = argv.includes('--apply'), backupConfirmed = argv.includes('--backup-confirmed');
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  return { apply, backupConfirmed };
}
function sameOptions(existing, requested) {
  return ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression'].every(key =>
    JSON.stringify(existing[key] ?? (['unique', 'sparse'].includes(key) ? false : null)) ===
    JSON.stringify(requested[key] ?? (['unique', 'sparse'].includes(key) ? false : null)));
}
async function migrate(db, { apply = false, backupConfirmed = false } = {}) {
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('REPLICA_SET_REQUIRED');
  const missing = [];
  for (const model of models) {
    const collection = db.collection(model.collection.name);
    let existing;
    try { existing = await collection.listIndexes().toArray(); } catch (e) { if (e.code !== 26) throw e; existing = []; }
    for (const [key, rawOptions] of model.schema.indexes()) {
      const options = { ...rawOptions }; delete options.background;
      const sameKey = existing.find(index => JSON.stringify(index.key) === JSON.stringify(key));
      if (sameKey) { if (!sameOptions(sameKey, options)) throw new Error(`INDEX_OPTIONS_CONFLICT:${model.collection.name}`); continue; }
      if (options.unique) {
        const duplicate = await collection.aggregate([
          { $match: options.partialFilterExpression || {} },
          { $group: { _id: Object.fromEntries(Object.keys(key).map((field, i) => [`k${i}`, `$${field}`])), count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } }, { $limit: 1 }
        ]).toArray();
        if (duplicate.length) throw new Error(`DUPLICATE_REVIEW_REQUIRED:${model.collection.name}`);
      }
      missing.push({ collection: model.collection.name, key, options });
    }
  }
  const legacyPending = await db.collection('paymentpurchaseattempts').countDocuments({ purpose: 'plan_purchase', pricingSnapshot: { $exists: false },
    $or: [{ status: { $in: ['creating', 'approval_pending', 'capturing', 'captured', 'review_required'] } },
      { status: 'failed', retryCount: { $gt: 0 } }] });
  // Drain old writers/orders before enabling new quote and override semantics.
  if (apply && legacyPending) throw new Error('LEGACY_PENDING_ORDERS_REQUIRE_REVIEW');
  if (apply) for (const index of missing) await db.collection(index.collection).createIndex(index.key, index.options);
  return { dryRun: !apply, replicaSet: true, legacyPending, missingIndexes: missing, indexesCreated: apply ? missing.length : 0,
    historicalRecordsChanged: 0, deletions: 0, pricesChanged: false };
}
async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    require('dotenv').config({ quiet: true });
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await migrate(mongoose.connection.db, options), null, 2));
  } catch (error) { console.error(`Promo billing migration failed: ${error.code || String(error.message).split('\n')[0]}`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main();
module.exports = { parseCliArgs, migrate, sameOptions };
