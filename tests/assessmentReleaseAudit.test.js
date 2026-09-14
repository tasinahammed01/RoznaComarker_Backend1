process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { audit, fullUnique } = require('../scripts/auditAssessmentRelease');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('read-only release database audit', () => {
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
  beforeEach(clearDatabase);
  test('requires a full single-field unique index', () => {
    const index = { key: { idempotencyKey: 1 }, unique: true };
    expect(fullUnique(index)).toBe(true);
    for (const change of [{ unique: false }, { sparse: true }, { partialFilterExpression: { status: 'committed' } },
      { key: { idempotencyKey: 1, userId: 1 } }]) expect(fullUnique({ ...index, ...change })).toBe(false);
  });
  test('classifies receipts and ambiguous legacy records without changing data', async () => {
    const db = mongoose.connection.db;
    const userId = new mongoose.Types.ObjectId();
    const transactions = db.collection('credittransactions');
    await transactions.insertMany([
      { userId, idempotencyKey: 'committed', status: 'committed' },
      { userId, idempotencyKey: 'legacy', status: 'pending' },
      { userId, idempotencyKey: 'receipt', status: 'pending', metadata: { durableProtocol: 1 } },
      { userId, idempotencyKey: 'failed', status: 'failed', metadata: { durableProtocol: 1,
        failure: { code: 'INSUFFICIENT_ASSESSMENT_CREDITS' } } },
      { userId, status: 'pending' }
    ]);
    await db.collection('creditwallets').insertOne({ userId, purchasedCredits: 4,
      pendingCreditOperation: { idempotencyKey: 'receipt', balanceAfter: 4, outcome: 'committed' } });
    const before = await transactions.find().toArray();
    const walletBefore = await db.collection('creditwallets').find().toArray();
    const report = await audit(db);
    expect(report).toMatchObject({ committedCount: 1, invalidKeys: 1, pendingCounts: {
      manual_review: 2, recoverable_by_durable_receipt: 1, clearly_not_applied: 1
    } });
    expect(await transactions.find().toArray()).toEqual(before);
    expect(await db.collection('creditwallets').find().toArray()).toEqual(walletBefore);
  });
});
