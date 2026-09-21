'use strict';

const contracts = [
  { collection: 'flashcardsubmissions', key: { flashcardSetId: 1, userId: 1 }, name: 'flashcardSetId_1_userId_1', partialFilterExpression: { assignmentId: null } },
  { collection: 'flashcardsubmissions', key: { assignmentId: 1, userId: 1 }, name: 'assignmentId_1_userId_1', partialFilterExpression: { assignmentId: { $type: 'objectId' } } },
  { collection: 'flashcardsets', key: { shareToken: 1 }, name: 'shareToken_1', partialFilterExpression: { shareToken: { $type: 'string' } } }
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matches = (index, contract) => same(index.key, contract.key) && index.unique === true
  && same(index.partialFilterExpression, contract.partialFilterExpression);
async function indexes(collection) {
  try { return await collection.indexes(); } catch (err) { if (err.code === 26) return []; throw err; }
}
async function verifyFlashcardIndexes(db) {
  for (const contract of contracts) {
    const existing = await indexes(db.collection(contract.collection));
    if (!existing.some(index => matches(index, contract)) || existing.some(index =>
      same(index.key, contract.key) && !matches(index, contract))) {
      throw new Error(`Required flashcard index ${contract.name} is missing or incompatible. Run npm run migrate:flashcard-indexes before startup.`);
    }
  }
}
async function migrateFlashcardIndexes(db) {
  // Preflight every unique constraint before dropping any historical index.
  for (const contract of contracts) {
    const group = Object.fromEntries(Object.keys(contract.key).map(key => [key, `$${key}`]));
    const duplicates = await db.collection(contract.collection).aggregate([
      { $match: contract.partialFilterExpression }, { $group: { _id: group, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 }
    ]).toArray();
    if (duplicates.length) throw new Error(`Duplicate data prevents index ${contract.name}; resolve duplicates before migration.`);
  }
  for (const contract of contracts) {
    const collection = db.collection(contract.collection);
    const existing = await indexes(collection);
    if (existing.some(index => index.name === contract.name && !same(index.key, contract.key))) {
      throw new Error(`Unexpected key shape for index ${contract.name}; manual review required.`);
    }
    for (const index of existing) {
      if (index.name !== '_id_' && same(index.key, contract.key) && !matches(index, contract)) await collection.dropIndex(index.name);
    }
    if (!existing.some(index => matches(index, contract))) {
      await collection.createIndex(contract.key, { name: contract.name, unique: true, partialFilterExpression: contract.partialFilterExpression });
    }
  }
  await db.collection('flashcardsets').updateMany({ shareToken: { $type: 'null' } }, { $unset: { shareToken: '' } });
  await verifyFlashcardIndexes(db);
}
module.exports = { verifyFlashcardIndexes, migrateFlashcardIndexes };
