'use strict';
// scripts/migrateAudioIndexes.js: creates the AudioRecording indexes (production connects with autoIndex off). Idempotent and additive.
process.env.NODE_ENV = 'test';
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const AudioRecording = require('../src/models/AudioRecording');
const { ensureAudioIndexes, AUDIO_INDEX_NAMES, main } = require('../scripts/migrateAudioIndexes');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);

test('the names match the schema exactly', () => {
  expect(AUDIO_INDEX_NAMES).toEqual(['audio_recording_request_v1', 'audio_recording_processing_v1']);
  expect(AudioRecording.schema.indexes().map(([, options]) => options.name).sort()).toEqual([...AUDIO_INDEX_NAMES].sort());
});

test('creates both indexes on an empty database, twice without error, and leaves other indexes alone', async () => {
  await AudioRecording.collection.drop().catch(() => {});
  await AudioRecording.createCollection();
  await AudioRecording.collection.createIndex({ createdAt: 1 }, { name: 'someone_elses_index' });
  const first = await ensureAudioIndexes();
  const second = await ensureAudioIndexes();
  expect(second).toEqual(first);
  const byName = Object.fromEntries(first.map(index => [index.name, index]));
  expect(byName.audio_recording_request_v1).toEqual({ name: 'audio_recording_request_v1', key: { owner: 1, requestId: 1 }, unique: true });
  expect(byName.audio_recording_processing_v1).toEqual({ name: 'audio_recording_processing_v1', key: { processingQueue: 1, nextAttemptAt: 1, leaseUntil: 1 },
    partialFilterExpression: { processingQueue: true } });
  expect(byName.someone_elses_index).toBeTruthy();
});

test('main refuses to run without MONGO_URI (and never prints it)', async () => {
  const saved = process.env.MONGO_URI;
  delete process.env.MONGO_URI;
  try { await expect(main()).rejects.toThrow('MONGO_URI is required'); } finally { if (saved !== undefined) process.env.MONGO_URI = saved; }
});
