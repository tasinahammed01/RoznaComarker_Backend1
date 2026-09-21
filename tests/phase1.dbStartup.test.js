jest.mock('../src/config/env', () => ({ MONGO_URI: 'mongodb://isolated/test' }));
jest.mock('mongoose', () => ({ connect: jest.fn(), connection: {} }));
jest.mock('../src/services/flashcardIndexContract.service', () => ({ verifyFlashcardIndexes: jest.fn() }));
const mongoose = require('mongoose');
const { verifyFlashcardIndexes } = require('../src/services/flashcardIndexContract.service');
test('connectDB connects without automatic schema or index creation and performs read-only verification', async () => {
  await require('../src/config/db')();
  expect(mongoose.connect).toHaveBeenCalledWith('mongodb://isolated/test', { autoIndex: false, autoCreate: false });
  expect(verifyFlashcardIndexes).toHaveBeenCalledWith(mongoose.connection);
});
