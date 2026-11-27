'use strict';
// Creates the Similarity Reporting indexes (similarityreports, similarityfingerprints, similarityusages). Production connects with
// autoIndex/autoCreate disabled (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the
// indexes named below, read from the schemas (no drift between the two), and never drops or rewrites any other index.
//   npm run migrate:similarity-indexes
if (require.main === module) require('dotenv').config();   // CLI only: requiring this module (tests) never loads .env
const mongoose = require('mongoose');

const SIMILARITY_INDEXES = Object.freeze({
  SimilarityReport: ['similarity_report_submission_v1', 'similarity_report_queue_v1', 'similarity_report_external_v1'],
  SimilarityFingerprint: ['similarity_fingerprint_submission_v1', 'similarity_fingerprint_hashes_v1', 'similarity_fingerprint_assignment_v1'],
  SimilarityUsage: ['similarity_usage_scope_day_v1']
});
const MODELS = { SimilarityReport: () => require('../src/models/SimilarityReport'),
  SimilarityFingerprint: () => require('../src/models/SimilarityFingerprint'),
  SimilarityUsage: () => require('../src/models/SimilarityUsage') };

/** Creates the indexes on the given (connected) mongoose instance and returns each collection's index list, by model name. */
async function ensureSimilarityIndexes() {
  const out = {};
  for (const [modelName, names] of Object.entries(SIMILARITY_INDEXES)) {
    const Model = MODELS[modelName]();
    const specs = Model.schema.indexes().filter(([, options]) => names.includes(options?.name));
    if (specs.length !== names.length) throw new Error(`Similarity index definitions are missing from the ${modelName} schema`);
    await Model.createCollection().catch(error => { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error; });
    for (const [fields, options] of specs) await Model.collection.createIndex(fields, options);
    out[modelName] = (await Model.collection.indexes()).map(index => ({ name: index.name, key: index.key,
      ...(index.unique ? { unique: true } : {}), ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
  }
  return out;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureSimilarityIndexes(), null, 2));
    console.log('Similarity index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Similarity index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureSimilarityIndexes, SIMILARITY_INDEXES };
