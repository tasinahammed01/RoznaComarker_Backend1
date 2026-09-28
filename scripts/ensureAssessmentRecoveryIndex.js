'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Submission = require('../src/models/Submission');

async function main() {
  await connectDB();
  const key = {
    ocrStatus: 1,
    analysisNextRetryAt: 1,
    analysisLeaseExpiresAt: 1,
    updatedAt: 1
  };
  const indexes = await Submission.collection.indexes();
  const existing = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
  if (existing) {
    console.log(JSON.stringify({ ok: true, index: existing.name, created: false }));
    return;
  }
  const name = await Submission.collection.createIndex(key, {
    name: 'assessment_recovery_scan_v1',
    background: true
  });
  console.log(JSON.stringify({ ok: true, index: name, created: true }));
}

main()
  .catch(error => {
    console.error(JSON.stringify({ ok: false, code: error?.code || 'INDEX_MIGRATION_FAILED' }));
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
