'use strict';
// Similarity models and scripts/migrateSimilarityIndexes.js (production connects with autoIndex off). Idempotent and additive.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const SimilarityReport = require('../src/models/SimilarityReport');
const SimilarityFingerprint = require('../src/models/SimilarityFingerprint');
const SimilarityUsage = require('../src/models/SimilarityUsage');
const { ensureSimilarityIndexes, SIMILARITY_INDEXES, main } = require('../scripts/migrateSimilarityIndexes');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(clearDatabase);

const id = () => new mongoose.Types.ObjectId();
const NAMES = {
  SimilarityReport: ['similarity_report_submission_v1', 'similarity_report_queue_v1', 'similarity_report_external_v1'],
  SimilarityFingerprint: ['similarity_fingerprint_submission_v1', 'similarity_fingerprint_hashes_v1', 'similarity_fingerprint_assignment_v1'],
  SimilarityUsage: ['similarity_usage_scope_day_v1']
};

test('the index names match the schemas exactly', () => {
  expect(SIMILARITY_INDEXES).toEqual(NAMES);
  for (const [name, Model] of [['SimilarityReport', SimilarityReport], ['SimilarityFingerprint', SimilarityFingerprint], ['SimilarityUsage', SimilarityUsage]]) {
    expect(Model.schema.indexes().map(([, o]) => o.name).sort()).toEqual([...NAMES[name]].sort());
  }
});

test('creates every index, twice without error, and leaves other indexes alone', async () => {
  for (const model of [SimilarityReport, SimilarityFingerprint, SimilarityUsage]) { await model.collection.drop().catch(() => {}); await model.createCollection(); }
  await SimilarityReport.collection.createIndex({ createdAt: 1 }, { name: 'someone_elses_index' });
  const first = await ensureSimilarityIndexes();
  expect(await ensureSimilarityIndexes()).toEqual(first);
  const r = Object.fromEntries(first.SimilarityReport.map(index => [index.name, index]));
  expect(r.similarity_report_submission_v1).toEqual({ name: 'similarity_report_submission_v1', key: { submissionId: 1 }, unique: true });
  expect(r.similarity_report_queue_v1).toEqual({ name: 'similarity_report_queue_v1', key: { inQueue: 1, nextAttemptAt: 1 },
    partialFilterExpression: { inQueue: true } });
  expect(r.similarity_report_external_v1).toEqual({ name: 'similarity_report_external_v1', key: { 'job.externalRef': 1 }, unique: true,
    partialFilterExpression: { 'job.externalRef': { $type: 'string' } } });
  expect(r.someone_elses_index).toBeTruthy();
  const f = Object.fromEntries(first.SimilarityFingerprint.map(index => [index.name, index]));
  expect(f.similarity_fingerprint_submission_v1).toEqual({ name: 'similarity_fingerprint_submission_v1', key: { submissionId: 1 }, unique: true });
  expect(f.similarity_fingerprint_hashes_v1).toEqual({ name: 'similarity_fingerprint_hashes_v1', key: { hashes: 1 } });
  expect(f.similarity_fingerprint_assignment_v1).toEqual({ name: 'similarity_fingerprint_assignment_v1', key: { assignmentId: 1 } });
  const u = Object.fromEntries(first.SimilarityUsage.map(index => [index.name, index]));
  expect(u.similarity_usage_scope_day_v1).toEqual({ name: 'similarity_usage_scope_day_v1', key: { scope: 1, day: 1 }, unique: true });
});

test('main refuses to run without MONGO_URI', async () => {
  const saved = process.env.MONGO_URI; delete process.env.MONGO_URI;
  try { await expect(main()).rejects.toThrow('MONGO_URI is required'); } finally { if (saved !== undefined) process.env.MONGO_URI = saved; }
});

test('a report keeps job secrets, the provider audit and pending provider data out of default reads', async () => {
  const submissionId = id();
  await SimilarityReport.create({ submissionId, assignmentId: id(), classId: id(), teacherId: id(), status: 'submitted',
    job: { attemptKey: 'k', externalRef: 'rbabc', leaseUntil: new Date() }, providerAudit: { provider: 'copyleaks', externalRef: 'rbabc' },
    providerPending: { crawledText: 'x' } });
  const plain = (await SimilarityReport.findOne({ submissionId }).lean());
  expect(plain.providerAudit).toBeUndefined();
  expect(plain.providerPending).toBeUndefined();
  expect(plain.job.attemptKey).toBeUndefined();
  expect(plain.job.externalRef).toBeUndefined();
  const full = await SimilarityReport.findOne({ submissionId }).select('+providerAudit +providerPending +job.attemptKey +job.externalRef').lean();
  expect(full.providerAudit.provider).toBe('copyleaks');
  expect(full.job.externalRef).toBe('rbabc');
});

test('a source kind is web, repository or internal; a status is one of the job states', async () => {
  const base = { submissionId: id(), assignmentId: id(), classId: id(), teacherId: id() };
  await expect(SimilarityReport.create({ ...base, status: 'pending' })).rejects.toThrow();
  await expect(SimilarityReport.create({ ...base, status: 'completed', sources: [{ sourceId: 's1', kind: 'internet', label: 'x' }] })).rejects.toThrow();
  for (const status of ['queued', 'running', 'submitted', 'completed', 'failed', 'expired']) {
    await SimilarityReport.create({ ...base, submissionId: id(), status });
  }
});

test('a fingerprint stores hashes and counts only (no text field exists)', () => {
  const paths = Object.keys(SimilarityFingerprint.schema.paths);
  expect(paths.filter(p => /text|passage|snippet/i.test(p) && p !== 'textSha256')).toEqual([]);
});
