'use strict';
// Audio + speech-to-text, stage 12: OpenRouter Scribe through the real job worker (services/audio/processing.js), the upload size cap, and
// payloads. In-memory MongoDB; the provider is a fake fetch behind the real adapter (a tripwire blocks the real network).
process.env.JWT_SECRET = 'audio-scribe-worker-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/audio-scribe-worker-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const File = require('../src/models/File');
const processing = require('../src/services/audio/processing');
const storage = require('../src/services/audio/storage');
const policy = require('../src/services/audio/policy');
const stt = require('../src/services/audio/stt');
const scribe = require('../src/services/audio/stt/openrouterScribe');
const assessment = require('../src/services/audio/speakingAssessment.service');
const access = require('../src/services/guestAccess.service');
const { audioUpload } = require('../src/middlewares/audioUpload.middleware');
const A = require('./fixtures/audio/openrouter-scribe/speaking-a-real-45s.cjs');
const ERRORS = require('./fixtures/audio/openrouter-scribe/errors.cjs');

jest.setTimeout(60000);
const ENV = { AUDIO_STT_ENABLED: 'true', AUDIO_STT_PROVIDER: 'openrouter-scribe', OPENROUTER_API_KEY: 'sk-or-test-key-not-real-789' };
const T0 = new Date('2026-11-17T10:00:00Z');
const clock = (ms = 0) => () => new Date(T0.getTime() + ms);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ownerId = new mongoose.Types.ObjectId();
const SUSPICIOUS_A = { ...A, words: A.words.map((w, i) => (i >= 40 && i < 52 ? { ...w, end: w.start } : w)) };
const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function sequence(...answers) {
  const fn = jest.fn(async () => { const next = answers[Math.min(fn.mock.calls.length, answers.length) - 1]; return typeof next === 'function' ? next() : jsonResponse(200, next, { 'x-generation-id': `gen-${fn.mock.calls.length}` }); });
  return fn;
}
// The worker's real provider path (services/audio/stt) with an injected fake fetch.
const realStt = fetchImpl => options => stt.transcribe({ ...options, fetchImpl });

async function makeRecording({ durationSeconds = A.duration } = {}) {
  const dir = storage.audioRoot();
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${crypto.randomUUID()}.m4a`;
  fs.writeFileSync(path.join(dir, fileName), Buffer.alloc(4096, 1));
  const file = await File.create({ originalName: 'recording.m4a', filename: fileName, path: storage.storedPathFor(fileName), url: `/files/audio/${fileName}`,
    uploadedBy: ownerId, role: 'teacher', type: 'audio', sizeBytes: 4096 });
  const created = await AudioRecording.create({ owner: ownerId, minutesChargedTo: ownerId, requestId: crypto.randomUUID(), audioFileId: file._id, contentType: 'audio/mp4',
    sizeBytes: 4096, durationSeconds, storageChargedTo: ownerId, storageChargedMB: 0.01, status: 'uploaded' });
  await processing.enqueue(created._id, { now: clock() });
  return created._id;
}
const reload = id => AudioRecording.findById(id).select('+leaseUntil +attemptKey +processingQueue +transcript +derived +assessmentQueue').lean();

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => { await clearDatabase(); await AudioRecording.createIndexes(); });

describe('the job worker with OpenRouter Scribe', () => {
  test('a clean answer: ready, one request, the minutes consumed once, provider and model kept in the raw transcript', async () => {
    const id = await makeRecording();
    const fetchImpl = sequence(A);
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(), transcribe: realStt(fetchImpl) })).toEqual({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const saved = await reload(id);
    expect(saved).toMatchObject({ status: 'ready', attempts: 1, wordTimingsAvailable: true });
    expect(saved.transcript).toMatchObject({ provider: 'openrouter-scribe', model: 'elevenlabs/scribe-v2', utterances: expect.any(Array) });
    expect(saved.derived.fluency).toMatchObject({ metricsVersion: 'audio-fluency-v2', fillerCount: 12 });
    const ledger = await AudioUsageLedger.find({ recordingId: id }).lean();
    expect(ledger.map(r => [r.state, r.seconds])).toEqual([['consumed', 45]]);
  });

  test('suspicious then clean: two requests inside ONE attempt; the minutes are counted once', async () => {
    const id = await makeRecording();
    const fetchImpl = sequence(SUSPICIOUS_A, A);
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(), transcribe: realStt(fetchImpl) })).toEqual({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await reload(id)).attempts).toBe(1);
    const ledger = await AudioUsageLedger.find({ recordingId: id }).lean();
    expect(ledger.map(r => [r.state, r.seconds])).toEqual([['consumed', 45]]);
  });

  test('suspicious twice: failed with AUDIO_STT_UNRELIABLE_RESULT, no further attempts, no minutes charged, no assessment; a retry is possible', async () => {
    const id = await makeRecording();
    const fetchImpl = sequence(SUSPICIOUS_A, SUSPICIOUS_A);
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(), transcribe: realStt(fetchImpl) }))
      .toEqual({ status: 'failed', code: 'AUDIO_STT_UNRELIABLE_RESULT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const saved = await reload(id);
    expect(saved).toMatchObject({ status: 'failed', attempts: 1, lastErrorCode: 'AUDIO_STT_UNRELIABLE_RESULT' });
    expect(saved.transcript).toBeUndefined();
    expect(saved.assessmentQueue).toBeUndefined();
    expect(saved.processingQueue).toBeUndefined();
    const ledger = await AudioUsageLedger.find({ recordingId: id }).lean();
    expect(ledger.every(r => r.state === 'released')).toBe(true);
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(60000), transcribe: realStt(sequence(A)) })).toEqual({ status: 'skipped' });
    expect(await processing.retryAudioRecording(id, { now: clock(60000) })).toEqual({ retried: true });
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(61000), transcribe: realStt(sequence(A)) })).toEqual({ status: 'ready' });
  });

  test('the guard measures against OUR duration scan: a provider that heard a much shorter file is suspicious', async () => {
    const id = await makeRecording({ durationSeconds: 60 });            // our scan: 60 s; the provider says 44.6 s
    const fetchImpl = sequence(A, A);
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(), transcribe: realStt(fetchImpl) }))
      .toEqual({ status: 'failed', code: 'AUDIO_STT_UNRELIABLE_RESULT' });
  });

  test('402 (OpenRouter credits): back in the queue after Retry-After (120 s), not a student failure', async () => {
    const id = await makeRecording();
    const fetchImpl = sequence(() => jsonResponse(402, ERRORS.inFlightBudget402, { 'retry-after': '120' }));
    expect(await processing.processAudioRecording(id, { env: ENV, now: clock(), transcribe: realStt(fetchImpl) }))
      .toEqual({ status: 'queued', code: 'AUDIO_STT_PROVIDER_CREDITS' });
    const saved = await reload(id);
    expect(saved).toMatchObject({ status: 'queued', attempts: 1, lastErrorCode: 'AUDIO_STT_PROVIDER_CREDITS' });
    expect(saved.nextAttemptAt.getTime() - T0.getTime()).toBe(120000);
  });

  test('the lease covers two provider calls with Scribe (retry once); Deepgram keeps its lease', () => {
    const scribeLimits = policy.readLimits(ENV).limits;
    expect(processing.leaseMsFor(scribeLimits)).toBe(2 * scribeLimits.sttTimeoutMs + 2 * 60 * 1000);
    const deepgramLimits = policy.readLimits({}).limits;
    expect(processing.leaseMsFor(deepgramLimits)).toBe(deepgramLimits.sttTimeoutMs + 2 * 60 * 1000);
  });

  test('the recording file over the provider cap at request time: failed with the size code (permanent), no request', async () => {
    const id = await makeRecording();
    const fetchImpl = sequence(A);
    const env = { ...ENV, AUDIO_STT_OPENROUTER_MAX_FILE_BYTES: String(1024 * 1024) };
    const big = await AudioRecording.findById(id).lean();
    const file = await File.findById(big.audioFileId).lean();
    fs.writeFileSync(storage.resolveStoredAudioPath(file.path), Buffer.alloc(1024 * 1024 + 1, 1));
    expect(await processing.processAudioRecording(id, { env, now: clock(), transcribe: realStt(fetchImpl) }))
      .toEqual({ status: 'failed', code: 'AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('upload size cap with Scribe: min(AUDIO_MAX_FILE_BYTES, AUDIO_STT_OPENROUTER_MAX_FILE_BYTES)', () => {
  const MP3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1');
  const pad = size => Buffer.concat([MP3, Buffer.alloc(size - MP3.length, 0)]);
  const uploadApp = express();
  uploadApp.post('/upload', audioUpload({ measureDuration: async () => ({ durationSeconds: 30, hasVideo: false }) }), (req, res) => res.json({ success: true }));
  const send = buffer => request(uploadApp).post('/upload').attach('audio', buffer, { filename: 'a.mp3', contentType: 'audio/mpeg' });
  afterEach(() => { for (const name of ['AUDIO_STT_PROVIDER', 'AUDIO_STT_OPENROUTER_MAX_FILE_BYTES']) delete process.env[name]; fs.rmSync(storage.audioRoot(), { recursive: true, force: true }); });

  test('over the provider cap: the existing 413 AUDIO_TOO_LARGE with the capped size in the message; at the cap: accepted', async () => {
    process.env.AUDIO_STT_PROVIDER = 'openrouter-scribe';
    process.env.AUDIO_STT_OPENROUTER_MAX_FILE_BYTES = String(1024 * 1024);
    const over = await send(pad(1024 * 1024 + 1));
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ success: false, code: 'AUDIO_TOO_LARGE',
      message: 'This recording is too large (1 MB max) or longer than 7 minutes. Save it as MP3 or M4A, or record in mono, and upload it again.' });
    expect((await send(pad(1024 * 1024))).status).toBe(200);
  });

  test('with Deepgram the OpenRouter cap is ignored', async () => {
    process.env.AUDIO_STT_OPENROUTER_MAX_FILE_BYTES = String(1024 * 1024);
    expect((await send(pad(1024 * 1024 + 4096))).status).toBe(200);
  });
});

describe('payloads never name the speech-to-text provider or model', () => {
  // Word boundaries: "described" in the assessment's own text is not the provider name.
  const FORBIDDEN = /openrouter|\bscribe\b|scribe-v2|elevenlabs|deepgram|providerRequestId|gen-stt|"words"|utterances/i;
  let f;
  beforeEach(async () => { await seedTestPlans(); f = await seedSpeaking(); await h.personalCredits(f.teacher.user, 5); process.env.AUDIO_STT_ENABLED = 'true'; });
  afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

  async function scribeTranscribed(mode = 'registered') {
    const made = await makeAudioSubmission(f, { status: 'ready', seconds: 45, mode });
    const raw = scribe.normalize(A, { model: 'elevenlabs/scribe-v2', headerRequestId: 'gen-stt-leak-check' });
    const texts = require('../src/services/audio/stt/transcript').deriveTexts(raw);
    await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { transcript: JSON.parse(JSON.stringify(raw)), transcriptSchemaVersion: raw.transcriptSchemaVersion,
      wordTimingsAvailable: true, derived: { derivedTextVersion: texts.derivedTextVersion, displayText: texts.displayText, assessorText: texts.assessorText,
        fluency: require('../src/services/audio/stt/transcript').fluencyMetrics(raw) } } });
    await assessment.enqueueAssessment(made.recording._id);
    await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output()) });
    return made;
  }

  test('student result, teacher result and teacher view', async () => {
    const { submission } = await scribeTranscribed();
    const auth = token => ({ Authorization: `Bearer ${token}` });
    const answers = [await request(app).get(`/api/speaking/submissions/${submission._id}/result`).set(auth(f.student.token)),
      await request(app).get(`/api/speaking/submissions/${submission._id}/result`).set(auth(f.teacher.token)),
      await request(app).get(`/api/speaking/submissions/${submission._id}`).set(auth(f.teacher.token))];
    for (const res of answers) { expect(res.status).toBe(200); expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN); }
  });

  test('the guest\'s own link', async () => {
    await mongoose.connection.collection('assignments').updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true } });
    const { submission } = await scribeTranscribed('guest');
    const issued = access.issueToken();
    await mongoose.connection.collection('submissions').updateOne({ _id: submission._id }, { $set: { 'guest.accessHash': issued.accessHash, 'guest.expiresAt': issued.expiresAt } });
    const res = await request(app).get(`/api/guest/speaking/submissions/${submission._id}`).set('X-Guest-Token', issued.token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });
});
