'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { migrateFlashcardIndexes } = require('../src/services/flashcardIndexContract.service');
async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    await migrateFlashcardIndexes(mongoose.connection);
    console.log('Flashcard index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Flashcard index migration failed; inspect index contracts and duplicate data.'); process.exitCode = 1; });
module.exports = { main };
