const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDB() {
  try {
    await mongoose.connect(env.MONGO_URI);
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection failed');
    logger.error(err);
    throw err;
  }
}

module.exports = connectDB;
