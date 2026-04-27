const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDB() {
  try {
    await mongoose.connect(env.MONGO_URI);
    logger.info('MongoDB connected');

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
