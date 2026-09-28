'use strict';
// Explicit, rerunnable migration. It never changes pricing or deletes billing data.
const mongoose = require('mongoose');
const ALLOWED = new Set(['--apply', '--backup-confirmed']);
function parseCliArgs(argv = []) {
  if (argv.some(a => !ALLOWED.has(a)) || new Set(argv).size !== argv.length) throw new Error('UNKNOWN_CLI_ARGUMENT');
  const apply = argv.includes('--apply'); const backupConfirmed = argv.includes('--backup-confirmed');
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  return { apply, backupConfirmed };
}
async function migrate(db, { apply = false, backupConfirmed = false } = {}) {
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  const plans = await db.collection('plans').find({}).toArray();
  const byId = new Map(plans.map(p => [String(p._id), p]));
  const users = await db.collection('users').find({ role: 'teacher', plan: { $exists: true },
    $or: [{ paypalSubscriptionId: { $exists: false } }, { paypalSubscriptionId: null }] }).toArray();
  const existing = await db.collection('planentitlements').find({ userId: { $in: users.map(u => u._id) } }, { projection: { userId: 1 } }).toArray();
  const migrated = new Set(existing.map(e => String(e.userId)));
  const candidates = users.filter(u => { const p = byId.get(String(u.plan)); return p && p.slug !== 'free' && !migrated.has(String(u._id)); });
  const activeConflicts = await db.collection('planentitlements').aggregate([
    { $match: { status: 'active' } }, { $group: { _id: '$userId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $limit: 1 }
  ]).toArray();
  if (activeConflicts.length) throw new Error('ACTIVE_ENTITLEMENT_CONFLICT_RESOLVE_MANUALLY');
  const indexes = [
    [{ providerCaptureId: 1 }, { name: 'billing_unique_providerCaptureId', unique: true,
      partialFilterExpression: { providerCaptureId: { $type: 'string' } } }],
    [{ userId: 1, status: 1 }, { name: 'entitlement_one_active_user', unique: true,
      partialFilterExpression: { status: 'active' } }],
    [{ userId: 1, status: 1, startsAt: 1, endsAt: 1 }, { name: 'entitlement_user_status_period' }],
    [{ status: 1, endsAt: 1 }, { name: 'entitlement_expiry_scan' }],
    [{ userId: 1 }, { name: 'entitlement_lock_user', unique: true }]
  ];
  if (!apply) return { dryRun: true, candidates: candidates.length, indexes: indexes.length, pricesChanged: false, deletions: 0 };
  for (const user of candidates) {
    const plan = byId.get(String(user.plan)); const startsAt = user.planStartedAt || user.createdAt || new Date();
    await db.collection('planentitlements').updateOne({ userId: user._id, source: 'admin',
      adminReason: 'Legacy plan migration' }, { $setOnInsert: { userId: user._id, planId: plan._id, planSlug: plan.slug,
      billingPeriod: 'custom', status: user.planExpiresAt && new Date(user.planExpiresAt) <= new Date() ? 'expired' : 'active',
      source: 'admin', startsAt, endsAt: user.planExpiresAt || null, autoRenew: false,
      activatedAt: startsAt, adminReason: 'Legacy plan migration', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
  }
  for (let i = 0; i < indexes.length; i += 1) {
    const collection = i === indexes.length - 1 ? 'planentitlementlocks' : 'planentitlements';
    const [key, options] = indexes[i]; await db.collection(collection).createIndex(key, options);
  }
  return { applied: true, migrated: candidates.length, pricesChanged: false, deletions: 0 };
}
async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    console.log(options.apply ? 'MODE=APPLY\nBACKUP_CONFIRMED=true' : 'MODE=DRY_RUN');
    require('dotenv').config({ quiet: true });
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(await migrate(mongoose.connection.db, options));
  } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main();
module.exports = { migrate, parseCliArgs };
