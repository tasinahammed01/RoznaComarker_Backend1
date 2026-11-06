#!/usr/bin/env node
'use strict';
/**
 * READ-ONLY geometry diagnostic for one submission.
 *
 *   node scripts/geometry-diagnostic.js <submissionId>
 *
 * For every page in ocrPages it prints ONLY: pageNumber, safeOutcomeCode, mappedTokenCount, unmappedTokenCount
 * (sourceVerificationSummary.performance.geometry). It never prints transcripts, words, names, e-mails or any other field:
 *  - the database is asked for those four values only (one aggregation: $match, then $project; no write stage exists), and
 *  - every value is checked again before printing: a code must look like CODE_NAME, a count must be a whole number; anything
 *    else is printed as null.
 * Errors print the error name only (never the message, which could contain the connection string).
 * The connection string is read from MONGO_URI (the environment, or backend/.env) and is never printed.
 */
const path = require('path');

const ID = /^[a-f0-9]{24}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const GEOMETRY = 'sourceVerificationSummary.performance.geometry';
const code = value => (typeof value === 'string' && CODE.test(value) ? value : null);
const count = value => (Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null);

// --details adds a few more NON-content fields. Each is checked like the first four.
const PERFORMANCE = 'sourceVerificationSummary.performance';
const MODEL = /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._:-]{0,50}$/i;
const model = value => (typeof value === 'string' && MODEL.test(value) ? value : null);
const flag = value => (typeof value === 'boolean' ? value : null);
const bounded = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);

function pipeline(id, { details = false } = {}) {
  const { ObjectId } = require('mongoose').Types;
  return [
    { $match: { _id: new ObjectId(id) } },
    { $project: { _id: 0, pages: { $map: { input: { $ifNull: ['$ocrPages', []] }, as: 'p', in: {
      pageNumber: '$$p.pageNumber',
      safeOutcomeCode: `$$p.${GEOMETRY}.safeOutcomeCode`,
      mappedTokenCount: `$$p.${GEOMETRY}.mappedTokenCount`,
      unmappedTokenCount: `$$p.${GEOMETRY}.unmappedTokenCount`,
      ...(details ? { layoutDegraded: `$$p.${GEOMETRY}.layoutDegraded`, model: '$$p.sourcePrimaryModel', geometryProviderCalls: `$$p.${PERFORMANCE}.geometryProviderCallCount`,
        geometryMs: `$$p.${PERFORMANCE}.geometryMs`, imageWidth: '$$p.ocrImageWidth', imageHeight: '$$p.ocrImageHeight' } : {}),
    } } } } },
  ];
}

/** { submissionId, found, pages: [{ pageNumber, safeOutcomeCode, mappedTokenCount, unmappedTokenCount }] }. Read-only. */
async function readGeometry(db, id, { details = false } = {}) {
  const rows = await db.collection('submissions').aggregate(pipeline(id, { details })).toArray();
  if (!rows.length) return { submissionId: id, found: false, pages: [] };
  return { submissionId: id, found: true, pages: (rows[0].pages || []).map(page => ({
    pageNumber: Number.isInteger(page?.pageNumber) ? page.pageNumber : null,
    safeOutcomeCode: code(page?.safeOutcomeCode), mappedTokenCount: count(page?.mappedTokenCount), unmappedTokenCount: count(page?.unmappedTokenCount),
    ...(details ? { layoutDegraded: flag(page?.layoutDegraded), model: model(page?.model), geometryProviderCalls: bounded(page?.geometryProviderCalls, 1),
      geometryMs: bounded(page?.geometryMs, 600000), imageWidth: bounded(page?.imageWidth, 100000) || null, imageHeight: bounded(page?.imageHeight, 100000) || null } : {}) })) };
}

async function defaultConnect() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });   // does not override variables already set
  const uri = process.env.MONGO_URI;
  if (!uri) throw Object.assign(new Error('MONGO_URI is not set'), { name: 'ConfigurationError' });
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  return { db: mongoose.connection.db, close: () => mongoose.disconnect() };
}

/** Exit code: 0 found, 1 not found or error, 2 usage. */
async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, connect = io.connect || defaultConnect;
  const details = argv.length === 2 && argv[1] === '--details';
  if (!(argv.length === 1 || details) || !ID.test(argv[0])) {
    stderr.write('Usage: node scripts/geometry-diagnostic.js <submissionId> [--details]   (the id is 24 hexadecimal characters)\n');
    return 2;
  }
  let connection;
  try {
    connection = await connect();
    const result = await readGeometry(connection.db, argv[0], { details });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.found ? 0 : 1;
  } catch (error) {
    stderr.write(`Could not read the submission (${String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'Error'}).\n`);
    return 1;
  } finally {
    try { await connection?.close?.(); } catch { /* nothing to report */ }
  }
}

if (require.main === module) main(process.argv.slice(2)).then(codeValue => { process.exitCode = codeValue; });

module.exports = { readGeometry, main, pipeline };
