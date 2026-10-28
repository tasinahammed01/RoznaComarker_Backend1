'use strict';
// Run during a maintenance window, with application writers stopped. Dry-run by default.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Submission = require('../src/models/Submission');
async function main() {
  await connectDB();
  const indexes = await Submission.collection.indexes();
  const registered = indexes.find(i => i.key.student === 1 && i.key.assignment === 1 && i.unique);
  const ready = registered?.partialFilterExpression?.student?.$type === 'objectId';
  console.log(JSON.stringify({ dryRun: !process.argv.includes('--apply'), replaceRegisteredIndex: !ready,
    requiresMaintenanceWindow: !ready }));
  if (!process.argv.includes('--apply')) return;
  if (!process.argv.includes('--writers-stopped')) throw new Error('Stop writers and pass --writers-stopped.');
  // No document rewrites and no TTL on academic records.
  if (!ready) {
    if (registered) await Submission.collection.dropIndex(registered.name);
    await Submission.collection.createIndex({ student: 1, assignment: 1 }, { unique: true,
      partialFilterExpression: { student: { $type: 'objectId' } } });
  }
  await Submission.collection.createIndex({ assignment: 1, guestRequestKey: 1 }, { unique: true,
    partialFilterExpression: { guestRequestKey: { $type: 'string' } } });
  await Submission.collection.createIndex({ assignment: 1, 'guest.normalizedEmail': 1, submittedAt: -1 },
    { name: 'guest_recovery_lookup_v1', partialFilterExpression: { submissionMode: 'guest' } });
  await Submission.collection.createIndex({ submissionMode: 1, assessmentStatus: 1, 'guest.resultEmailSentAt': 1, 'guest.resultEmailNextAttemptAt': 1 },
    { name: 'guest_result_email_queue_v1' });
  console.log(JSON.stringify({ ok: true }));
}
if (require.main === module) main().catch(() => {
  console.error('Guest index setup failed. Keep writers stopped and restore/verify the registered unique index before resuming.');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
module.exports = { main };
