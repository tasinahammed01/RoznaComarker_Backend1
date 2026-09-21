const { migrateFlashcardIndexes, verifyFlashcardIndexes } = require('../src/services/flashcardIndexContract.service');
test('migration is idempotent and verification is read only', async () => {
  const collections = new Map();
  const db = { collection(name) {
    if (!collections.has(name)) {
      const shapes = [{ name: '_id_', key: { _id: 1 } }];
      collections.set(name, { indexes: async () => shapes, aggregate: () => ({ toArray: async () => [] }),
        dropIndex: jest.fn(), updateMany: jest.fn(), createIndex: jest.fn(async (key, options) => shapes.push({ key, ...options })) });
    }
    return collections.get(name);
  } };
  await expect(verifyFlashcardIndexes(db)).rejects.toThrow('migrate:flashcard-indexes');
  await migrateFlashcardIndexes(db); await migrateFlashcardIndexes(db); await verifyFlashcardIndexes(db);
  expect(db.collection('flashcardsubmissions').createIndex).toHaveBeenCalledTimes(2);
  expect(db.collection('flashcardsets').createIndex).toHaveBeenCalledTimes(1);
  expect(db.collection('flashcardsubmissions').dropIndex).not.toHaveBeenCalled();
});
test('duplicates abort before any index mutation', async () => {
  const dropIndex = jest.fn(), createIndex = jest.fn();
  await expect(migrateFlashcardIndexes({ collection: () => ({ aggregate: () => ({ toArray: async () => [{ count: 2 }] }), dropIndex, createIndex }) })).rejects.toThrow('Duplicate data');
  expect(dropIndex).not.toHaveBeenCalled(); expect(createIndex).not.toHaveBeenCalled();
});
