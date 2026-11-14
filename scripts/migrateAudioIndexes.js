'use strict';
// Creates the audio indexes on the audiorecordings and audiousageledgers collections. Production connects with autoIndex/autoCreate disabled
// (src/config/db.js), so they are not created by the application. Idempotent and additive: it creates only the indexes named below, read
// from the schemas (no drift between the two), and never drops or rewrites any other index.
//   npm run migrate:audio-indexes
if (require.main === module) require('dotenv').config();   // CLI only: requiring this module (tests) never loads .env
const mongoose = require('mongoose');

const AUDIO_INDEXES = Object.freeze({
  AudioRecording: ['audio_recording_request_v1', 'audio_recording_processing_v1'],
  AudioUsageLedger: ['audio_usage_key_v1', 'audio_usage_teacher_month_v1', 'audio_usage_inflight_teacher_v1', 'audio_usage_inflight_uploader_v1',
    'audio_usage_recording_v1']
});
const AUDIO_INDEX_NAMES = Object.values(AUDIO_INDEXES).flat();
const MODELS = { AudioRecording: () => require('../src/models/AudioRecording'), AudioUsageLedger: () => require('../src/models/AudioUsageLedger') };

/** Creates the audio indexes on the given (connected) mongoose instance and returns each collection's index list, by model name. */
async function ensureAudioIndexes() {
  const out = {};
  for (const [modelName, names] of Object.entries(AUDIO_INDEXES)) {
    const Model = MODELS[modelName]();
    const specs = Model.schema.indexes().filter(([, options]) => names.includes(options?.name));
    if (specs.length !== names.length) throw new Error(`Audio index definitions are missing from the ${modelName} schema`);
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
    console.log(JSON.stringify(await ensureAudioIndexes(), null, 2));
    console.log('Audio index migration completed');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Audio index migration failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, ensureAudioIndexes, AUDIO_INDEXES, AUDIO_INDEX_NAMES };
