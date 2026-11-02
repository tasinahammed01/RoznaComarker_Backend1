'use strict';
// Creates the recovery-portal indexes. Production connects with autoIndex/autoCreate disabled (src/config/db.js), so they are not
// created by the application. Idempotent and additive: createIndexes() only adds missing indexes; it never drops or rewrites any.
//   npm run migrate:recovery-portal-indexes
require('dotenv').config();
const mongoose = require('mongoose');

const MODELS = ['RecoveryToken', 'RecoverySession', 'RecoveryEmailWindow'];

/** Creates the indexes on the given (connected) mongoose instance and returns their names and TTL settings per collection. */
async function ensureRecoveryPortalIndexes() {
  const summary = {};
  for (const name of MODELS) {
    const Model = require(`../src/models/${name}`);
    await Model.createIndexes();
    summary[Model.collection.collectionName] = (await Model.collection.indexes())
      .map(index => ({ name: index.name, key: index.key, ...(index.unique ? { unique: true } : {}),
        ...(index.expireAfterSeconds !== undefined ? { expireAfterSeconds: index.expireAfterSeconds } : {}) }));
  }
  return summary;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureRecoveryPortalIndexes(), null, 2));
    console.log('Recovery portal index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Recovery portal index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureRecoveryPortalIndexes };
