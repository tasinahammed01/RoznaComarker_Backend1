const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDB() {
  try {
    await mongoose.connect(env.MONGO_URI);
    logger.info('MongoDB connected');

    try {
      const submissions = mongoose.connection.collection('flashcardsubmissions');
      const indexes = await submissions.indexes();
      const legacy = indexes.find((index) => index.name !== '_id_'
        && index.unique === true
        && JSON.stringify(index.key) === JSON.stringify({ flashcardSetId: 1, userId: 1 })
        && !index.partialFilterExpression);

      if (legacy) {
        await submissions.dropIndex(legacy.name);
        logger.info({ event: 'flashcard_submission_legacy_index_removed', indexName: legacy.name });
      }

      const assignmentIndex = indexes.find((index) => index.name !== '_id_'
        && JSON.stringify(index.key) === JSON.stringify({ assignmentId: 1, userId: 1 }));
      const assignmentIndexIsCurrent = assignmentIndex?.unique === true
        && assignmentIndex.partialFilterExpression?.assignmentId?.$type === 'objectId';
      if (assignmentIndex && !assignmentIndexIsCurrent) {
        await submissions.dropIndex(assignmentIndex.name);
        logger.info({ event: 'flashcard_submission_assignment_index_replaced', indexName: assignmentIndex.name });
      }

      await submissions.createIndex(
        { flashcardSetId: 1, userId: 1 },
        { name: 'flashcardSetId_1_userId_1', unique: true, partialFilterExpression: { assignmentId: null } }
      );
      await submissions.createIndex(
        { assignmentId: 1, userId: 1 },
        { name: 'assignmentId_1_userId_1', unique: true,
          partialFilterExpression: { assignmentId: { $type: 'objectId' } } }
      );
    } catch (indexError) {
      logger.error({ event: 'flashcard_submission_index_migration_failed', name: indexError?.name,
        code: indexError?.code, message: indexError?.message });
      throw indexError;
    }

    try {
      const flashcardSets = mongoose.connection.collection('flashcardsets');
      const indexes = await flashcardSets.indexes();
      const shareTokenIndex = indexes.find((index) => index.name === 'shareToken_1');
      const hasCorrectPartialIndex = !!shareTokenIndex
        && shareTokenIndex.unique === true
        && shareTokenIndex.partialFilterExpression?.shareToken?.$type === 'string';

      if (shareTokenIndex && !hasCorrectPartialIndex) {
        await flashcardSets.dropIndex('shareToken_1');
        logger.info('[STARTUP] Dropped old shareToken_1 index');
      }

      const unsetResult = await flashcardSets.updateMany(
        { shareToken: null },
        { $unset: { shareToken: '' } }
      );
      if (unsetResult.modifiedCount > 0) {
        logger.info(`[STARTUP] Removed null shareToken from ${unsetResult.modifiedCount} flashcard sets`);
      }

      await flashcardSets.createIndex(
        { shareToken: 1 },
        {
          name: 'shareToken_1',
          unique: true,
          partialFilterExpression: { shareToken: { $type: 'string' } }
        }
      );
      logger.info('[STARTUP] Ensured partial unique shareToken_1 index');
    } catch (indexError) {
      logger.warn('[STARTUP] Could not repair flashcardsets shareToken_1 index');
      logger.warn(indexError);
    }
  } catch (err) {
    logger.error('MongoDB connection failed');
    logger.error(err);
    throw err;
  }
}

module.exports = connectDB;
