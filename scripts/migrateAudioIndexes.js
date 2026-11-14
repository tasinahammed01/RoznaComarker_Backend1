'use strict';
// Creates the audio-recording indexes on the audiorecordings collection. Production connects with autoIndex/autoCreate disabled
// (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the indexes named below, read
// from the AudioRecording schema (no drift between the two), and never drops or rewrites any other index.
//   npm run migrate:audio-indexes
if (require.main === module) require('dotenv').config();   // CLI only: requiring this module (tests) never loads .env
const mongoose = require('mongoose');

const AUDIO_INDEX_NAMES = ['audio_recording_request_v1', 'audio_recording_processing_v1'];

/** Creates the audio-recording indexes on the given (connected) mongoose instance and returns the collection's index list. */
async function ensureAudioIndexes() {
  const AudioRecording = require('../src/models/AudioRecording');
  const specs = AudioRecording.schema.indexes().filter(([, options]) => AUDIO_INDEX_NAMES.includes(options?.name));
  if (specs.length !== AUDIO_INDEX_NAMES.length) throw new Error('Audio-recording index definitions are missing from the AudioRecording schema');
  for (const [fields, options] of specs) await AudioRecording.collection.createIndex(fields, options);
  return (await AudioRecording.collection.indexes()).map(index => ({ name: index.name, key: index.key,
    ...(index.unique ? { unique: true } : {}), ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) }));
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await ensureAudioIndexes(), null, 2));
    console.log('Audio index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Audio index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureAudioIndexes, AUDIO_INDEX_NAMES };
