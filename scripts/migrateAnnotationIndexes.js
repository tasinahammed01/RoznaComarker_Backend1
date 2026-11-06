'use strict';
// Creates the Task 6A indexes: the annotation audit collection (unique request id per submission, history order, optional TTL from
// ANNOTATION_AUDIT_TTL_DAYS) and the one-year TTL on the teacher recovery-link audit. Production connects with autoIndex/autoCreate
// disabled (src/config/db.js), so the application never creates them. Idempotent: createIndexes() only adds missing indexes and never rewrites
// one (changing a TTL later needs collMod). One drop: annotation_audit_ttl_v1 expired every row, score decisions included; v2 leaves those out.
// Dropped first, so no row can expire under the old rule; with ANNOTATION_AUDIT_TTL_DAYS set, v2 replaces it in the same run.
//   npm run migrate:annotation-indexes
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const MODELS = ['AnnotationAudit', 'RecoveryLinkAudit'];

/** Creates the indexes on the connected mongoose instance; returns their names and TTL settings per collection. */
async function ensureAnnotationIndexes() {
  const summary = {};
  for (const name of MODELS) {
    const Model = require(`../src/models/${name}`);
    await Model.createCollection().catch(error => { if (error.codeName !== 'NamespaceExists') throw error; });
    if (name === 'AnnotationAudit' && (await Model.collection.indexes()).some(index => index.name === 'annotation_audit_ttl_v1')) await Model.collection.dropIndex('annotation_audit_ttl_v1');
    await Model.createIndexes();
    summary[Model.collection.collectionName] = (await Model.collection.indexes())
      .map(index => ({ name: index.name, key: index.key, ...(index.unique ? { unique: true } : {}),
        ...(index.expireAfterSeconds !== undefined ? { expireAfterSeconds: index.expireAfterSeconds } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
  }
  return summary;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureAnnotationIndexes(), null, 2));
    console.log('Annotation index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Annotation index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureAnnotationIndexes };
