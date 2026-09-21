const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');
const { verifyFlashcardIndexes } = require('../services/flashcardIndexContract.service');
async function connectDB() {
  await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false });
  await verifyFlashcardIndexes(mongoose.connection);
  logger.info('MongoDB connected; required flashcard indexes verified');
}
module.exports = connectDB;
