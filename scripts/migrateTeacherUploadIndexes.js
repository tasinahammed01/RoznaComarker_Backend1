'use strict';
// Creates the teacher-upload indexes on the submissions collection. Production connects with autoIndex/autoCreate disabled
// (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the indexes named
// below, read from the Submission schema (no drift between the two), and never drops or rewrites any other index.
//   npm run migrate:teacher-upload-indexes
require('dotenv').config();
const mongoose = require('mongoose');

const TEACHER_UPLOAD_INDEX_NAMES = ['teacher_upload_request_v1', 'teacher_upload_email_queue_v1', 'teacher_upload_list_v1'];

/** Creates the teacher-upload indexes on the given (connected) mongoose instance and returns the collection's index list. */
async function ensureTeacherUploadIndexes() {
  const Submission = require('../src/models/Submission');
  const specs = Submission.schema.indexes().filter(([, options]) => TEACHER_UPLOAD_INDEX_NAMES.includes(options?.name));
  if (specs.length !== TEACHER_UPLOAD_INDEX_NAMES.length) throw new Error('Teacher-upload index definitions are missing from the Submission schema');
  for (const [fields, options] of specs) await Submission.collection.createIndex(fields, options);
  return (await Submission.collection.indexes()).map(index => ({ name: index.name, key: index.key,
    ...(index.unique ? { unique: true } : {}), ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureTeacherUploadIndexes(), null, 2));
    console.log('Teacher upload index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Teacher upload index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureTeacherUploadIndexes, TEACHER_UPLOAD_INDEX_NAMES };
