'use strict';
// Creates the reference-file indexes on the referencefiles collection. Production connects with autoIndex/autoCreate disabled
// (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the indexes named below, read
// from the ReferenceFile schema (no drift between the two), and never drops or rewrites any other index.
//   npm run migrate:reference-file-indexes
require('dotenv').config();
const mongoose = require('mongoose');

const REFERENCE_FILE_INDEX_NAMES = ['reference_file_request_v1', 'reference_file_class_v1', 'reference_file_assignment_v1', 'reference_file_processing_v1',
  'reference_file_active_slot_v1', 'reference_file_active_content_v1'];

/** Creates the reference-file indexes on the given (connected) mongoose instance and returns the collection's index list. */
async function ensureReferenceFileIndexes() {
  const ReferenceFile = require('../src/models/ReferenceFile');
  const specs = ReferenceFile.schema.indexes().filter(([, options]) => REFERENCE_FILE_INDEX_NAMES.includes(options?.name));
  if (specs.length !== REFERENCE_FILE_INDEX_NAMES.length) throw new Error('Reference-file index definitions are missing from the ReferenceFile schema');
  for (const [fields, options] of specs) await ReferenceFile.collection.createIndex(fields, options);
  return (await ReferenceFile.collection.indexes()).map(index => ({ name: index.name, key: index.key,
    ...(index.unique ? { unique: true } : {}), ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureReferenceFileIndexes(), null, 2));
    console.log('Reference file index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Reference file index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureReferenceFileIndexes, REFERENCE_FILE_INDEX_NAMES };
