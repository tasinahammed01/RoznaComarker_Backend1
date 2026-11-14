'use strict';
// Creates the unique per-submission index of the Improved Writing Model (submissionwritingmodels). Production connects with autoIndex/
// autoCreate disabled (src/config/db.js), so it is not created by the application. Idempotent and additive: it creates only the index named
// below, read from the schema, and never drops or rewrites any other index. Also prints how many old assignment-wide models exist
// (Assignment.writingModel: kept, no longer shown to students), as a count only.
//   npm run migrate:submission-writing-model-indexes
require('dotenv').config();
const mongoose = require('mongoose');

const INDEX_NAMES = ['submission_writing_model_unique_v1'];

async function ensureSubmissionWritingModelIndexes() {
  const SubmissionWritingModel = require('../src/models/SubmissionWritingModel');
  const specs = SubmissionWritingModel.schema.indexes().filter(([, options]) => INDEX_NAMES.includes(options?.name));
  if (specs.length !== INDEX_NAMES.length) throw new Error('Submission writing model index definitions are missing from the schema');
  for (const [fields, options] of specs) await SubmissionWritingModel.collection.createIndex(fields, options);
  return (await SubmissionWritingModel.collection.indexes()).map(index => ({ name: index.name, key: index.key, ...(index.unique ? { unique: true } : {}) }));
}

/** Old assignment-wide models: { total, withText, approved } (counts only, no text). */
async function legacyAssignmentModelCounts() {
  const Assignment = require('../src/models/assignment.model');
  const [total, withText, approved] = await Promise.all([
    Assignment.countDocuments({ writingModel: { $exists: true } }),
    Assignment.countDocuments({ 'writingModel.text': { $exists: true, $ne: '' } }),
    Assignment.countDocuments({ 'writingModel.status': 'approved' })]);
  return { total, withText, approved };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureSubmissionWritingModelIndexes(), null, 2));
    console.log('Old assignment-wide models (no longer shown to students):', JSON.stringify(await legacyAssignmentModelCounts()));
    console.log('Submission writing model index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Submission writing model index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureSubmissionWritingModelIndexes, legacyAssignmentModelCounts, INDEX_NAMES };
