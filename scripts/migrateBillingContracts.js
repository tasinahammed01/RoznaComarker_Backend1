'use strict';
// Explicit maintenance-window migration. Never imported by app startup.
const mongoose = require('mongoose');
const { contracts, normalize } = require('./verifyCreditPacks');

const ALLOWED_ARGUMENTS = new Set(['--apply', '--backup-confirmed']);

function parseCliArgs(argv = []) {
  if (!Array.isArray(argv)) throw Object.assign(new Error('UNKNOWN_CLI_ARGUMENT'), { code: 'UNKNOWN_CLI_ARGUMENT' });
  const seen = new Set();
  for (const argument of argv) {
    if (!ALLOWED_ARGUMENTS.has(argument) || seen.has(argument)) {
      throw Object.assign(new Error('UNKNOWN_CLI_ARGUMENT'), { code: 'UNKNOWN_CLI_ARGUMENT' });
    }
    seen.add(argument);
  }
  const apply = seen.has('--apply');
  const backupConfirmed = seen.has('--backup-confirmed');
  if (apply && !backupConfirmed) {
    throw Object.assign(new Error('BACKUP_CONFIRMATION_REQUIRED'), { code: 'BACKUP_CONFIRMATION_REQUIRED' });
  }
  return { apply, backupConfirmed };
}

async function migrate(db, { apply = false, backupConfirmed = false } = {}) {
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  const plans = await db.collection('plans').find({}).toArray();
  const slugs = plans.map(p => normalize(p.slug));
  if (slugs.some(s => !s || !/^[a-z0-9][a-z0-9_-]*$/.test(s)) || new Set(slugs).size !== slugs.length) {
    throw new Error('PLAN_SLUG_CONFLICT_RESOLVE_MANUALLY');
  }
  // Old pending attempts must be reconciled before enabling the new lock.
  const active = await db.collection('paymentcheckoutattempts').find({ provider: 'paypal',
    status: { $in: ['creating', 'approval_pending', 'active'] } }).toArray();
  const owners = active.map(a => String(a.userId));
  if (new Set(owners).size !== owners.length) throw new Error('CHECKOUT_CONFLICT_RECONCILE_MANUALLY');
  const packs = await db.collection('creditpacks').find({}).toArray();
  const updates = packs.map(p => {
    const allowedPlans = [...new Set((p.allowedPlans || []).map(normalize))];
    if (allowedPlans.some(s => !slugs.includes(s))) throw new Error('PACK_PLAN_UNKNOWN_RESOLVE_MANUALLY');
    // Only existing personal packs become Free-eligible; institution-only packs stay separate.
    if (slugs.includes('free') && allowedPlans.some(s => !['institution', 'custom', 'free'].includes(s))) allowedPlans.push('free');
    return { p, allowedPlans: [...new Set(allowedPlans)] };
  });
  // Preflight every unique key before performing any writes.
  for (const [collection, key, partial] of contracts) {
    const indexes = await db.collection(collection).indexes().catch(error => { if (error.code === 26) return []; throw error; });
    const existing = indexes.find(i => JSON.stringify(i.key) === JSON.stringify(key) && i.unique);
    const expectedPartial = partial ? { [partial]: { $type: 'string' } } : undefined;
    const compatibleLegacyUserIndex = partial === 'paypalSubscriptionId' && existing?.sparse && !existing.partialFilterExpression;
    if (existing && !compatibleLegacyUserIndex && (JSON.stringify(existing.partialFilterExpression) !== JSON.stringify(expectedPartial) || existing.sparse)) {
      throw new Error(`INCOMPATIBLE_INDEX_${collection}`);
    }
    const match = partial ? { [partial]: { $type: 'string' } } : {};
    const duplicates = await db.collection(collection).aggregate([{ $match: match },
      { $group: { _id: Object.fromEntries(Object.keys(key).map(k => [k, `$${k}`])), count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 }]).toArray();
    if (duplicates.length) throw new Error(`DUPLICATE_INDEX_KEY_${collection}`);
  }
  if (!apply) return { dryRun: true, plans: plans.length, packs: packs.length, checkoutClaims: active.length };
  for (const plan of plans) await db.collection('plans').updateOne({ _id: plan._id }, { $set: { slug: normalize(plan.slug) } });
  for (const { p, allowedPlans } of updates) await db.collection('creditpacks').updateOne({ _id: p._id }, { $set: { allowedPlans } });
  for (const attempt of active) await db.collection('paymentcheckoutattempts').updateOne({ _id: attempt._id },
    { $set: { activeOperationKey: `paypal:${attempt.userId}` } });
  for (const [collection, key, partial] of contracts) {
    const indexes = await db.collection(collection).indexes().catch(error => { if (error.code === 26) return []; throw error; });
    const existing = indexes.find(i => JSON.stringify(i.key) === JSON.stringify(key));
    if (existing?.unique) continue;
    // Never drop an existing index automatically. MongoDB can retain the ordinary
    // index while adding an explicitly named unique index on supported deployments.
    await db.collection(collection).createIndex(key, { name: `billing_unique_${Object.keys(key).join('_')}`, unique: true,
      ...(partial ? { partialFilterExpression: { [partial]: { $type: 'string' } } } : {}) });
  }
  await db.collection('creditpacks').createIndex({ active: 1, allowedPlans: 1, displayOrder: 1 });
  return { applied: true, pricesChanged: false };
}
async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
    if (options.apply) {
      console.log('MODE=APPLY');
      console.log('BACKUP_CONFIRMED=true');
    } else {
      console.log('MODE=DRY_RUN');
    }
    require('dotenv').config({ quiet: true });
    if (!process.env.MONGO_URI) throw Object.assign(new Error('MONGO_URI_MISSING'), { code: 'MONGO_URI_MISSING' });
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    console.log(await migrate(mongoose.connection.db, options));
  } catch (error) {
    const failure = /^[A-Z_]+$/.test(error.code || '') ? error.code
      : (/^[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED');
    console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main();
module.exports = { migrate, parseCliArgs };
