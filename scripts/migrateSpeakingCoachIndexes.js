'use strict';
// Creates the Speaking Coach indexes (speakingpracticesessions, speakingpracticeattempts). Production connects with autoIndex/autoCreate
// disabled (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the indexes named below,
// read from the schemas (no drift between the two), and never drops or rewrites any other index. The purpose fields added to AudioRecording and
// AudioUsageLedger need no index (the practice minute reads use audio_usage_teacher_month_v1).
//   npm run migrate:speaking-coach-indexes
if (require.main === module) require('dotenv').config();   // CLI only: requiring this module (tests) never loads .env
const mongoose = require('mongoose');

const SPEAKING_COACH_INDEXES = Object.freeze({
  SpeakingPracticeSession: ['speaking_practice_session_student_v1', 'speaking_practice_session_guest_v1', 'speaking_practice_session_assignment_v1'],
  SpeakingPracticeAttempt: ['speaking_practice_attempt_number_v1', 'speaking_practice_attempt_request_v1', 'speaking_practice_attempt_queue_v1',
    'speaking_practice_attempt_recording_v1', 'speaking_practice_attempt_transcribing_v1']
});
const MODELS = { SpeakingPracticeSession: () => require('../src/models/SpeakingPracticeSession'),
  SpeakingPracticeAttempt: () => require('../src/models/SpeakingPracticeAttempt') };

/** Creates the indexes on the given (connected) mongoose instance and returns each collection's index list, by model name. */
async function ensureSpeakingCoachIndexes() {
  const out = {};
  for (const [modelName, names] of Object.entries(SPEAKING_COACH_INDEXES)) {
    const Model = MODELS[modelName]();
    const specs = Model.schema.indexes().filter(([, options]) => names.includes(options?.name));
    if (specs.length !== names.length) throw new Error(`Speaking Coach index definitions are missing from the ${modelName} schema`);
    await Model.createCollection().catch(error => { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error; });
    for (const [fields, options] of specs) await Model.collection.createIndex(fields, options);
    out[modelName] = (await Model.collection.indexes()).map(index => ({ name: index.name, key: index.key,
      ...(index.unique ? { unique: true } : {}), ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
  }
  return out;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureSpeakingCoachIndexes(), null, 2));
    console.log('Speaking Coach index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Speaking Coach index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureSpeakingCoachIndexes, SPEAKING_COACH_INDEXES };
