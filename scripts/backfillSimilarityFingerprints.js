'use strict';
// Indexes existing marked essays for the internal similarity comparison (new essays are indexed when their marking completes). Idempotent:
// an essay indexed again is replaced. Reads the transcript and writes hashes only; prints counts only (never text, names or ids).
//   node scripts/backfillSimilarityFingerprints.js [--limit=N] [--dry-run]
if (require.main === module) require('dotenv').config();   // CLI only: requiring this module (tests) never loads .env
const mongoose = require('mongoose');

/** { scanned, indexed, skipped, failed }. dryRun: counts the essays that would be read, writes nothing. */
async function backfill({ limit = Infinity, dryRun = false } = {}) {
  const Submission = require('../src/models/Submission');
  const { indexSubmission } = require('../src/services/similarity/internal.service');
  const out = { scanned: 0, indexed: 0, skipped: 0, failed: 0 };
  const cursor = Submission.find({ assessmentStatus: 'complete', sourceKind: { $ne: 'audio' } }).select('_id').sort({ _id: 1 }).lean().cursor();
  for await (const doc of cursor) {
    if (out.scanned >= limit) break;
    out.scanned++;
    if (dryRun) continue;
    try { if (await indexSubmission(doc._id)) out.indexed++; else out.skipped++; } catch { out.failed++; }
  }
  return out;
}

const argValue = (name, argv) => argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
async function main(argv = process.argv.slice(2)) {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  const limitText = argValue('limit', argv);
  const limit = limitText === undefined ? Infinity : Number(limitText);
  if (!(limit > 0)) throw new Error('--limit must be a positive number');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await backfill({ limit, dryRun: argv.includes('--dry-run') })));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Similarity backfill failed: ${error.message}`); process.exitCode = 1; });
module.exports = { backfill, main };
