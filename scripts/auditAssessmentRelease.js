'use strict';

// Read-only by default. Does not import app/models or run startup migrations.
const path = require('path');
const { MongoClient } = require('mongoose').mongo;
const { validateAssignmentRubricInput, normalizeAssignmentRubric } = require('../src/services/assignmentRubric.service');

function fullUnique(index) {
  return index.unique === true && !index.partialFilterExpression && !index.sparse
    && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1;
}

function classifyRubric(assignment) {
  let raw = assignment.rubrics ?? assignment.rubric;
  if (raw == null || raw === '') return 'absent';
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return 'manual_review'; } }
  if (!validateAssignmentRubricInput(raw, Array.isArray(raw?.levels)).length) return 'valid';
  const normalized = normalizeAssignmentRubric(assignment);
  if (normalized.status !== 'valid') return 'manual_review';
  const candidate = { totalPoints: normalized.rubric.totalPoints, criteria: normalized.rubric.criteria.map(row => ({
    name: row.title, weight: row.weight, levels: row.levels.map(level => ({
      title: level.title, score: level.percentage, description: level.description
    }))
  })) };
  return validateAssignmentRubricInput(candidate).length ? 'manual_review' : 'normalizable_requires_review';
}

async function audit(db) {
  const transactions = db.collection('credittransactions');
  const indexes = await transactions.indexes().catch(error => {
    if (error.code === 26) return []; // A genuinely new database has no collection/index yet.
    throw error;
  });
  const duplicates = await transactions.aggregate([
    { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
  const invalidKeys = await transactions.countDocuments({ $or: [
    { idempotencyKey: { $exists: false } }, { idempotencyKey: null }, { idempotencyKey: '' }
  ] });
  const pending = [];
  for await (const transaction of transactions.find({ status: { $nin: ['committed', 'refunded'] } },
    { projection: { userId: 1, idempotencyKey: 1, status: 1, 'metadata.durableProtocol': 1, 'metadata.failure': 1 } })) {
    const receipt = transaction.userId && typeof transaction.idempotencyKey === 'string' && transaction.idempotencyKey.trim()
      ? await db.collection('creditwallets').findOne({ userId: transaction.userId,
      'pendingCreditOperation.idempotencyKey': transaction.idempotencyKey }, { projection: { _id: 1 } }) : null;
    const classification = receipt ? 'recoverable_by_durable_receipt'
      : transaction.status === 'failed' && transaction.metadata?.durableProtocol === 1
        && transaction.metadata?.failure?.code === 'INSUFFICIENT_ASSESSMENT_CREDITS' ? 'clearly_not_applied'
        : 'manual_review';
    pending.push({ id: transaction._id, idempotencyKey: transaction.idempotencyKey, status: transaction.status, classification });
  }
  const rubrics = { absent: [], valid: [], normalizable_requires_review: [], manual_review: [] };
  for await (const assignment of db.collection('assignments').find({}, { projection: { rubrics: 1, rubric: 1 } })) {
    rubrics[classifyRubric(assignment)].push(assignment._id);
  }
  return { database: db.databaseName, uniqueIndexVerified: indexes.some(fullUnique),
    indexes: indexes.filter(index => index.key?.idempotencyKey).map(({ name, key, unique, sparse, partialFilterExpression }) =>
      ({ name, key, unique: !!unique, sparse: !!sparse, partialFilterExpression })),
    duplicates, invalidKeys, committedCount: await transactions.countDocuments({ status: 'committed' }),
    pending, pendingCounts: pending.reduce((counts, item) => ({ ...counts,
      [item.classification]: (counts[item.classification] || 0) + 1 }), {}),
    rubricCounts: Object.fromEntries(Object.entries(rubrics).map(([key, ids]) => [key, ids.length])), rubricIds: rubrics };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  try {
    await client.connect();
    const db = client.db();
    const report = await audit(db);
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--create-missing-index')) {
      if (process.env.ASSESSMENT_INDEX_TARGET_DB !== db.databaseName) throw new Error('Explicit matching ASSESSMENT_INDEX_TARGET_DB confirmation required');
      if (report.duplicates.length || report.invalidKeys) throw new Error('Duplicate/invalid idempotency keys require manual reconciliation; no index was created');
      if (!report.uniqueIndexVerified) {
        if (report.indexes.length) throw new Error('Conflicting existing index requires administrator review; no index was dropped');
        await db.collection('credittransactions').createIndex({ idempotencyKey: 1 }, { unique: true, name: 'idempotencyKey_1' });
        console.log(JSON.stringify({ uniqueIndexVerified: (await db.collection('credittransactions').indexes()).some(fullUnique) }));
      }
    }
  } finally { await client.close(); }
}

if (require.main === module) main().catch(error => {
  // Driver errors may contain connection details. Never print their message/URI.
  console.error(JSON.stringify({ auditFailed: true, errorType: error.name, code: error.code || 'AUDIT_FAILED' }));
  process.exitCode = 1;
});
module.exports = { audit, fullUnique, classifyRubric };
