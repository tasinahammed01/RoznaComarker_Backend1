'use strict';
// scripts/migrateAudioIndexes.js: creates the AudioRecording and AudioUsageLedger indexes (production connects with autoIndex off).
// Idempotent and additive.
process.env.NODE_ENV = 'test';
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const { ensureAudioIndexes, AUDIO_INDEX_NAMES, AUDIO_INDEXES, main } = require('../scripts/migrateAudioIndexes');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);

const RECORDING_INDEXES = ['audio_recording_request_v1', 'audio_recording_processing_v1', 'audio_recording_assessment_v1'];
const LEDGER_INDEXES = ['audio_usage_key_v1', 'audio_usage_teacher_month_v1', 'audio_usage_inflight_teacher_v1', 'audio_usage_inflight_uploader_v1',
  'audio_usage_recording_v1'];

test('the names match the schemas exactly', () => {
  expect(AUDIO_INDEXES).toEqual({ AudioRecording: RECORDING_INDEXES, AudioUsageLedger: LEDGER_INDEXES });
  expect(AUDIO_INDEX_NAMES).toEqual([...RECORDING_INDEXES, ...LEDGER_INDEXES]);
  expect(AudioRecording.schema.indexes().map(([, options]) => options.name).sort()).toEqual([...RECORDING_INDEXES].sort());
  expect(AudioUsageLedger.schema.indexes().map(([, options]) => options.name).sort()).toEqual([...LEDGER_INDEXES].sort());
});

test('creates every index on an empty database, twice without error, and leaves other indexes alone', async () => {
  for (const model of [AudioRecording, AudioUsageLedger]) {
    await model.collection.drop().catch(() => {});
    await model.createCollection();
  }
  await AudioRecording.collection.createIndex({ createdAt: 1 }, { name: 'someone_elses_index' });
  const first = await ensureAudioIndexes();
  const second = await ensureAudioIndexes();
  expect(second).toEqual(first);
  const recording = Object.fromEntries(first.AudioRecording.map(index => [index.name, index]));
  expect(recording.audio_recording_request_v1).toEqual({ name: 'audio_recording_request_v1', key: { owner: 1, requestId: 1 }, unique: true });
  expect(recording.audio_recording_processing_v1).toEqual({ name: 'audio_recording_processing_v1', key: { processingQueue: 1, nextAttemptAt: 1, leaseUntil: 1 },
    partialFilterExpression: { processingQueue: true } });
  expect(recording.audio_recording_assessment_v1).toEqual({ name: 'audio_recording_assessment_v1',
    key: { assessmentQueue: 1, assessmentNextAttemptAt: 1, assessmentLeaseUntil: 1 }, partialFilterExpression: { assessmentQueue: true } });
  expect(recording.someone_elses_index).toBeTruthy();
  const ledger = Object.fromEntries(first.AudioUsageLedger.map(index => [index.name, index]));
  expect(ledger.audio_usage_key_v1).toEqual({ name: 'audio_usage_key_v1', key: { key: 1 }, unique: true });
  expect(ledger.audio_usage_teacher_month_v1).toEqual({ name: 'audio_usage_teacher_month_v1', key: { minutesChargedTo: 1, monthKey: 1, state: 1 } });
  expect(ledger.audio_usage_inflight_teacher_v1).toEqual({ name: 'audio_usage_inflight_teacher_v1', key: { minutesChargedTo: 1 }, unique: true,
    partialFilterExpression: { state: 'reserved' } });
  expect(ledger.audio_usage_inflight_uploader_v1).toEqual({ name: 'audio_usage_inflight_uploader_v1', key: { uploader: 1 }, unique: true,
    partialFilterExpression: { state: 'reserved' } });
  expect(ledger.audio_usage_recording_v1).toEqual({ name: 'audio_usage_recording_v1', key: { recordingId: 1 } });
});

test('main refuses to run without MONGO_URI (and never prints it)', async () => {
  const saved = process.env.MONGO_URI;
  delete process.env.MONGO_URI;
  try { await expect(main()).rejects.toThrow('MONGO_URI is required'); } finally { if (saved !== undefined) process.env.MONGO_URI = saved; }
});
