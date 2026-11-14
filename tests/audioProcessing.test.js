'use strict';
// Audio + speech-to-text, stage 2: the AudioRecording model and the transcription job worker (services/audio/processing.js). In-memory MongoDB;
// the provider is always an injected fake (the real adapter is never reached: the global fetch is a tripwire). Time is injected.
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/audio-processing-test-${process.pid}`;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const AudioRecording = require('../src/models/AudioRecording');
const File = require('../src/models/File');
const processing = require('../src/services/audio/processing');
const storage = require('../src/services/audio/storage');
const policy = require('../src/services/audio/policy');
const { SttError } = require('../src/services/audio/stt/errors');
const deepgram = require('../src/services/audio/stt/deepgram');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');

const T0 = new Date('2026-11-15T10:00:00Z');
const at = ms => new Date(T0.getTime() + ms);
const clock = (ms = 0) => () => at(ms);
const LIMITS = policy.readLimits({}).limits;
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ownerId = new mongoose.Types.ObjectId();

const ok = () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [{ provider: 'deepgram', outcome: 'ok', code: null }], fallbackUsed: false });
const fakeTranscribe = (impl = async () => ok()) => jest.fn(impl);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function makeRecording({ status = 'queued', fileName = `${crypto.randomUUID()}.webm`, write = true, extra = {} } = {}) {
  const dir = storage.audioRoot();
  fs.mkdirSync(dir, { recursive: true });
  const absolute = path.join(dir, fileName);
  if (write) fs.writeFileSync(absolute, Buffer.alloc(4096, 1));
  const file = await File.create({ originalName: 'recording.webm', filename: fileName, path: storage.storedPathFor(fileName), url: `/files/audio/${fileName}`,
    uploadedBy: ownerId, role: 'teacher', type: 'audio', sizeBytes: 4096 });
  const created = await AudioRecording.create({ owner: ownerId, requestId: crypto.randomUUID(), audioFileId: file._id, contentType: 'audio/webm',
    sizeBytes: 4096, durationSeconds: 8.2, storageChargedTo: ownerId, storageChargedMB: 0.01, status: 'uploaded', ...extra });
  if (status === 'queued') await processing.enqueue(created._id, { now: clock() });
  return AudioRecording.findById(created._id).select('+leaseUntil +attemptKey +processingQueue +transcript +derived');
}
const reload = id => AudioRecording.findById(id).select('+leaseUntil +attemptKey +processingQueue +transcript +derived +editedRevisions').lean();

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => { await clearDatabase(); await AudioRecording.createIndexes(); });

describe('the AudioRecording model', () => {
  test('retention hook fields exist with their v1 defaults (no retention job in v1)', async () => {
    const doc = await makeRecording({ status: 'uploaded' });
    expect(doc.toObject()).toMatchObject({ audioDeletedAt: null, audioDeletionReason: null, purgeAfter: null, retentionHold: false,
      storageChargedMB: 0.01, durationSeconds: 8.2, sizeBytes: 4096, submissionId: null, status: 'uploaded', attempts: 0 });
    expect(String(doc.storageChargedTo)).toBe(String(ownerId));
  });

  test('requestId is unique per owner', async () => {
    const doc = await makeRecording({ status: 'uploaded' });
    await expect(AudioRecording.create({ owner: ownerId, requestId: doc.requestId, audioFileId: doc.audioFileId, contentType: 'audio/webm', sizeBytes: 1 }))
      .rejects.toMatchObject({ code: 11000 });
    await expect(AudioRecording.create({ owner: new mongoose.Types.ObjectId(), requestId: doc.requestId, audioFileId: doc.audioFileId,
      contentType: 'audio/webm', sizeBytes: 1 })).resolves.toBeTruthy();
  });

  test('server-only fields never serialise', async () => {
    const doc = await reload((await makeRecording())._id);
    const json = AudioRecording.hydrate(doc).toJSON();
    for (const key of ['leaseUntil', 'attemptKey', 'processingQueue', 'audioSha256', 'transcript', 'editedRevisions', 'derived']) expect(json).not.toHaveProperty(key);
  });

  describe('the raw transcript is written once and never changed; edits are append-only', () => {
    let id;
    beforeEach(async () => {
      id = (await makeRecording())._id;
      await processing.processAudioRecording(id, { transcribe: fakeTranscribe(), now: clock() });
    });
    test.each([
      ['$set the transcript', () => AudioRecording.updateOne({ _id: id }, { $set: { transcript: { words: [] } } })],
      ['$set a transcript path', () => AudioRecording.updateOne({ _id: id }, { $set: { 'transcript.words.0.text': 'x' } })],
      ['$unset the transcript', () => AudioRecording.updateOne({ _id: id }, { $unset: { transcript: 1 } })],
      ['a bare transcript update', () => AudioRecording.updateOne({ _id: id }, { transcript: {} })],
      ['$set the edit list', () => AudioRecording.updateOne({ _id: id }, { $set: { editedRevisions: [] } })],
      ['$pull from the edit list', () => AudioRecording.updateOne({ _id: id }, { $pull: { editedRevisions: { revision: 1 } } })],
      ['$pop the edit list', () => AudioRecording.updateMany({}, { $pop: { editedRevisions: 1 } })],
      ['a pipeline update', () => AudioRecording.updateOne({ _id: id }, [{ $set: { status: 'ready' } }], { updatePipeline: true })],
      ['a replace', () => AudioRecording.replaceOne({ _id: id }, { owner: ownerId })],
      ['findOneAndUpdate on the transcript', () => AudioRecording.findOneAndUpdate({ _id: id }, { $set: { transcript: null } })]
    ])('%s is refused', async (_name, write) => {
      await expect(write()).rejects.toMatchObject({ code: 'AUDIO_TRANSCRIPT_IMMUTABLE' });
      expect((await reload(id)).transcript.words).toHaveLength(21);
    });

    test('changing the transcript through save() is refused', async () => {
      const doc = await AudioRecording.findById(id).select('+transcript');
      doc.transcript = { words: [] }; doc.markModified('transcript');
      await expect(doc.save()).rejects.toMatchObject({ code: 'AUDIO_TRANSCRIPT_IMMUTABLE' });
    });

    test('an edit is appended with $push', async () => {
      await AudioRecording.updateOne({ _id: id }, { $push: { editedRevisions: { revision: 1, text: 'So I went home.', editedBy: ownerId, editedAt: T0, baseRevision: 0 } } });
      expect((await reload(id)).editedRevisions).toHaveLength(1);
    });

    test('other fields can still change', async () => {
      await AudioRecording.updateOne({ _id: id }, { $set: { submissionId: new mongoose.Types.ObjectId() } });
      expect((await reload(id)).submissionId).toBeTruthy();
    });
  });
});

describe('claim and lease', () => {
  test('the lease is longer than the provider timeout (and covers the fallback too)', () => {
    expect(processing.leaseMsFor(LIMITS)).toBeGreaterThan(LIMITS.sttTimeoutMs);
    expect(processing.leaseMsFor(policy.readLimits({ AUDIO_STT_FALLBACK_ENABLED: 'true' }).limits)).toBeGreaterThan(2 * LIMITS.sttTimeoutMs);
  });

  test('a claim takes the lease, counts the attempt and sets a new attempt key', async () => {
    const doc = await makeRecording();
    const claimed = await processing.claim(doc._id, { now: clock() });
    expect(claimed).toMatchObject({ status: 'transcribing', attempts: 1 });
    expect(claimed.leaseUntil.getTime()).toBe(T0.getTime() + processing.leaseMsFor(LIMITS));
    expect(claimed.attemptKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('two concurrent claims: exactly one wins', async () => {
    const doc = await makeRecording();
    const results = await Promise.all([processing.claim(doc._id, { now: clock() }), processing.claim(doc._id, { now: clock() })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await reload(doc._id)).attempts).toBe(1);
  });

  test.each(['uploaded', 'ready', 'failed', 'cancelled'])('a %s recording cannot be claimed', async (status) => {
    const doc = await makeRecording({ status: 'uploaded' });
    await AudioRecording.updateOne({ _id: doc._id }, { $set: { status } });
    expect(await processing.claim(doc._id, { now: clock() })).toBeNull();
  });

  test('a queued recording is not claimed before its next attempt time', async () => {
    const doc = await makeRecording();
    await AudioRecording.updateOne({ _id: doc._id }, { $set: { nextAttemptAt: at(60000) } });
    expect(await processing.claim(doc._id, { now: clock(59999) })).toBeNull();
    expect(await processing.claim(doc._id, { now: clock(60000) })).toBeTruthy();
  });
});

describe('processing', () => {
  test('success: ready, raw transcript and derived texts stored, provider called once with the stored audio', async () => {
    const doc = await makeRecording();
    const transcribe = fakeTranscribe();
    const result = await processing.processAudioRecording(doc._id, { transcribe, now: clock(1000) });
    expect(result).toEqual({ status: 'ready' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const args = transcribe.mock.calls[0][0];
    expect(args.contentType).toBe('audio/webm');
    expect(path.resolve(args.filePath).startsWith(storage.audioRoot() + path.sep)).toBe(true);
    expect(args.signal).toBeInstanceOf(AbortSignal);
    const saved = await reload(doc._id);
    expect(saved).toMatchObject({ status: 'ready', readyAt: at(1000), leaseUntil: null, nextAttemptAt: null, lastErrorCode: null,
      transcriptSchemaVersion: 'audio-transcript-v1', wordTimingsAvailable: true, speakingCoachDataAvailable: true });
    expect(saved.processingQueue).toBeUndefined();
    expect(saved.transcript.words).toHaveLength(21);
    expect(saved.transcript.providerRequestId).toBe('0b3f2c1e-1111-4222-8333-944455556666');
    expect(saved.derived).toMatchObject({ derivedTextVersion: 'audio-derived-text-v1',
      assessorText: 'So I I went to the the market. It was, very busy. Then I went I went home.',
      displayText: { text: 'So I I went to the the market. It was, very busy. Then I went I went home.' },
      fluency: { metricsVersion: 'audio-fluency-v1', available: true, wordsPerMinute: 145.9 } });
  });

  test('an OpenAI-fallback transcript is stored with Speaking Coach data marked unavailable', async () => {
    const doc = await makeRecording();
    const openai = require('../src/services/audio/stt/openai');
    const transcribe = fakeTranscribe(async () => ({ transcript: openai.normalize({ text: 'So I went home.' }, { model: 'gpt-4o-transcribe' }), attempts: [], fallbackUsed: true }));
    await processing.processAudioRecording(doc._id, { transcribe, now: clock() });
    expect(await reload(doc._id)).toMatchObject({ status: 'ready', wordTimingsAvailable: false, speakingCoachDataAvailable: false,
      derived: { assessorText: 'So I went home.', fluency: { available: false, reason: 'WORD_TIMINGS_UNAVAILABLE' } } });
  });

  test('double processing never calls the provider twice for one attempt key', async () => {
    const doc = await makeRecording();
    const gate = deferred();
    const transcribe = fakeTranscribe(async () => { await gate.promise; return ok(); });
    const first = processing.processAudioRecording(doc._id, { transcribe, now: clock() });
    const second = processing.processAudioRecording(doc._id, { transcribe, now: clock() });
    const sweep = processing.resumeAudioRecordings({ transcribe, now: clock() });
    await new Promise(resolve => setTimeout(resolve, 50));
    gate.resolve();
    const results = await Promise.all([first, second, sweep]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(results[1]).toEqual({ status: 'skipped' });
    expect((await reload(doc._id)).attempts).toBe(1);
  });

  test.each([
    ['no File record', async doc => File.deleteOne({ _id: doc.audioFileId })],
    ['the file is missing on disk', async doc => fs.rmSync(path.join(storage.audioRoot(), (await File.findById(doc.audioFileId)).filename))],
    ['a stored path outside the audio folder', async doc => File.updateOne({ _id: doc.audioFileId }, { $set: { path: 'uploads/submissions/x.webm' } })],
    ['a stored path that climbs out', async doc => File.updateOne({ _id: doc.audioFileId }, { $set: { path: `${storage.storedPathFor('..')}/../../etc/passwd` } })]
  ])('%s: failed AUDIO_FILE_UNAVAILABLE, no provider call', async (_name, breakIt) => {
    const doc = await makeRecording();
    await breakIt(doc);
    const transcribe = fakeTranscribe();
    expect(await processing.processAudioRecording(doc._id, { transcribe, now: clock() })).toEqual({ status: 'failed', code: 'AUDIO_FILE_UNAVAILABLE' });
    expect(transcribe).not.toHaveBeenCalled();
    expect(await reload(doc._id)).toMatchObject({ status: 'failed', lastErrorCode: 'AUDIO_FILE_UNAVAILABLE' });
  });
});

describe('retries: cap 3, backoff 15 s, 60 s, 5 min; Retry-After only as a capped hint', () => {
  const retryable = (retryAfterMs = null) => fakeTranscribe(async () => { throw Object.assign(new SttError('AUDIO_STT_PROVIDER_ERROR', { provider: 'deepgram' }),
    retryAfterMs === null ? {} : { retryAfterMs }); });

  test('three retryable failures: queued +15 s, queued +60 s, then failed', async () => {
    const doc = await makeRecording();
    expect(await processing.processAudioRecording(doc._id, { transcribe: retryable(), now: clock(0) })).toEqual({ status: 'queued', code: 'AUDIO_STT_PROVIDER_ERROR' });
    expect(await reload(doc._id)).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: at(15000), leaseUntil: null, lastErrorCode: 'AUDIO_STT_PROVIDER_ERROR' });
    expect(await processing.processAudioRecording(doc._id, { transcribe: retryable(), now: clock(15000) })).toMatchObject({ status: 'queued' });
    expect(await reload(doc._id)).toMatchObject({ attempts: 2, nextAttemptAt: at(75000) });
    expect(await processing.processAudioRecording(doc._id, { transcribe: retryable(), now: clock(75000) })).toEqual({ status: 'failed', code: 'AUDIO_STT_PROVIDER_ERROR' });
    const saved = await reload(doc._id);
    expect(saved).toMatchObject({ status: 'failed', attempts: 3, failedAt: at(75000), nextAttemptAt: null, leaseUntil: null });
    expect(saved.processingQueue).toBeUndefined();
    expect(await processing.claim(doc._id, { now: clock(10 * 60000) })).toBeNull();
  });

  test('the schedule is 15 s, 60 s, 5 min', () => {
    expect([1, 2, 3].map(n => processing.backoffMs(n, null))).toEqual([15000, 60000, 300000]);
  });

  test.each([[1, 30000, 30000], [2, 1000, 60000], [1, 999999, 300000], [3, 120000, 300000], [1, null, 15000]])(
    'attempt %i with a Retry-After hint of %p ms waits %p ms', (attempt, hint, expected) => {
      expect(processing.backoffMs(attempt, hint)).toBe(expected);
    });

  test('a Retry-After hint is used on the stored next attempt time', async () => {
    const doc = await makeRecording();
    await processing.processAudioRecording(doc._id, { transcribe: retryable(45000), now: clock(0) });
    expect((await reload(doc._id)).nextAttemptAt).toEqual(at(45000));
  });

  test('a permanent failure fails at once', async () => {
    const doc = await makeRecording();
    const transcribe = fakeTranscribe(async () => { throw new SttError('AUDIO_STT_REJECTED', { provider: 'deepgram', httpStatus: 400 }); });
    expect(await processing.processAudioRecording(doc._id, { transcribe, now: clock() })).toEqual({ status: 'failed', code: 'AUDIO_STT_REJECTED' });
    expect(await reload(doc._id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  test('an unexpected exception is treated as retryable, with a safe code', async () => {
    const doc = await makeRecording();
    const transcribe = fakeTranscribe(async () => { throw new Error('boom with student text: market busy'); });
    expect(await processing.processAudioRecording(doc._id, { transcribe, now: clock() })).toEqual({ status: 'queued', code: 'AUDIO_TRANSCRIPTION_FAILED' });
  });

  test('AUDIO_STT_MAX_ATTEMPTS=1 fails on the first retryable failure', async () => {
    const doc = await makeRecording();
    const env = { AUDIO_STT_MAX_ATTEMPTS: '1' };
    expect(await processing.processAudioRecording(doc._id, { transcribe: retryable(), now: clock(), env })).toMatchObject({ status: 'failed' });
  });
});

describe('restart resume', () => {
  test('a recording left transcribing by a stopped process is picked up after its lease ends', async () => {
    const doc = await makeRecording();
    await processing.claim(doc._id, { now: clock(0) });                     // the process "crashes" here
    const transcribe = fakeTranscribe();
    const leaseMs = processing.leaseMsFor(LIMITS);
    await processing.resumeAudioRecordings({ transcribe, now: clock(leaseMs - 1) });
    expect(transcribe).not.toHaveBeenCalled();                               // lease still held
    await processing.resumeAudioRecordings({ transcribe, now: clock(leaseMs) });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(await reload(doc._id)).toMatchObject({ status: 'ready', attempts: 2 });
  });

  test('a recording that used all its attempts while transcribing is marked failed, without a provider call', async () => {
    const doc = await makeRecording();
    await AudioRecording.updateOne({ _id: doc._id }, { $set: { status: 'transcribing', attempts: 3, leaseUntil: at(-1) } });
    const transcribe = fakeTranscribe();
    await processing.resumeAudioRecordings({ transcribe, now: clock() });
    expect(transcribe).not.toHaveBeenCalled();
    expect(await reload(doc._id)).toMatchObject({ status: 'failed', lastErrorCode: 'AUDIO_STT_ATTEMPTS_EXHAUSTED' });
  });

  test('queued work that is due is picked up; work that is not due waits', async () => {
    const due = await makeRecording();
    const later = await makeRecording();
    await AudioRecording.updateOne({ _id: later._id }, { $set: { nextAttemptAt: at(60000) } });
    const transcribe = fakeTranscribe();
    await processing.resumeAudioRecordings({ transcribe, now: clock(1000) });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect((await reload(due._id)).status).toBe('ready');
    expect((await reload(later._id)).status).toBe('queued');
  });
});

describe('cancel', () => {
  test('cancel while transcribing: the result is discarded, the signal is aborted, the transcript is never stored', async () => {
    const doc = await makeRecording();
    const gate = deferred();
    let seenSignal;
    const transcribe = fakeTranscribe(async ({ signal }) => { seenSignal = signal; await gate.promise; return ok(); });
    const running = processing.processAudioRecording(doc._id, { transcribe, now: clock() });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await processing.cancelAudioRecording(doc._id, { now: clock(500) })).toEqual({ cancelled: true });
    expect(seenSignal.aborted).toBe(true);
    gate.resolve();
    expect(await running).toEqual({ status: 'discarded' });
    const saved = await reload(doc._id);
    expect(saved).toMatchObject({ status: 'cancelled', cancelledAt: at(500), leaseUntil: null });
    expect(saved.transcript).toBeUndefined();
    expect(saved.processingQueue).toBeUndefined();
  });

  test('cancel while transcribing in ANOTHER process: the late result is discarded by the guard', async () => {
    const doc = await makeRecording();
    const gate = deferred();
    const transcribe = fakeTranscribe(async () => { await gate.promise; return ok(); });
    const running = processing.processAudioRecording(doc._id, { transcribe, now: clock() });
    await new Promise(resolve => setTimeout(resolve, 30));
    // Another process cancels: only the database changes; this process's in-flight call is not aborted.
    await AudioRecording.updateOne({ _id: doc._id, status: 'transcribing' }, { $set: { status: 'cancelled', cancelledAt: at(500), leaseUntil: null }, $unset: { processingQueue: 1 } });
    gate.resolve();
    expect(await running).toEqual({ status: 'discarded' });
    expect((await reload(doc._id)).status).toBe('cancelled');
  });

  test('a lost lease (another worker took over): the late result is discarded', async () => {
    const doc = await makeRecording();
    const gate = deferred();
    const slow = fakeTranscribe(async () => { await gate.promise; return ok(); });
    const leaseMs = processing.leaseMsFor(LIMITS);
    const running = processing.processAudioRecording(doc._id, { transcribe: slow, now: clock(0) });
    await new Promise(resolve => setTimeout(resolve, 30));
    const takeover = await processing.claim(doc._id, { now: clock(leaseMs + 1) });
    expect(takeover).toBeTruthy();
    gate.resolve();
    expect(await running).toEqual({ status: 'discarded' });
    expect(await reload(doc._id)).toMatchObject({ status: 'transcribing', attempts: 2 });
  });

  test('cancel a queued recording: it is never picked up', async () => {
    const doc = await makeRecording();
    expect(await processing.cancelAudioRecording(doc._id, { now: clock() })).toEqual({ cancelled: true });
    const transcribe = fakeTranscribe();
    await processing.resumeAudioRecordings({ transcribe, now: clock(60000) });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test.each(['ready', 'failed', 'cancelled'])('cancel after %s changes nothing', async (status) => {
    const doc = await makeRecording();
    await AudioRecording.updateOne({ _id: doc._id }, { $set: { status }, $unset: { processingQueue: 1 } });
    expect(await processing.cancelAudioRecording(doc._id, { now: clock() })).toEqual({ cancelled: false });
    expect((await reload(doc._id)).status).toBe(status);
  });
});

describe('the sweep query', () => {
  test('inclusion projection, a limit, no sort; the plan uses the processing index and has no SORT stage', async () => {
    await makeRecording();
    const { filter, projection, limit } = processing.sweepQuery(T0, LIMITS);
    expect(projection).toEqual({ _id: 1, nextAttemptAt: 1, createdAt: 1 });
    expect(limit).toBe(processing.SWEEP_CAP + 1);
    const explained = await AudioRecording.collection.find(filter, { projection }).limit(limit).explain('queryPlanner');
    const plan = JSON.stringify(explained.queryPlanner.winningPlan);
    expect(plan).not.toContain('SORT');
    expect(plan).toContain('audio_recording_processing_v1');

    const spy = jest.spyOn(AudioRecording, 'find');
    try {
      await processing.resumeAudioRecordings({ transcribe: fakeTranscribe(), now: clock() });
      const query = spy.mock.results.map(r => r.value).find(q => q?.getOptions?.().limit === processing.SWEEP_CAP + 1);
      expect(query).toBeTruthy();
      expect(query.getOptions().sort).toBeUndefined();
      expect(query._fields).toEqual({ _id: 1, nextAttemptAt: 1, createdAt: 1 });
    } finally { spy.mockRestore(); }
  });

  test('the sweep is capped, oldest due first (sorted in Node), and logs counts only', async () => {
    const docs = [];
    for (let i = 0; i < processing.SWEEP_CAP + 3; i++) docs.push(await makeRecording());
    // The newest record is made the most overdue: it must be first.
    await AudioRecording.updateOne({ _id: docs[docs.length - 1]._id }, { $set: { nextAttemptAt: at(-60000) } });
    const order = [];
    const transcribe = fakeTranscribe(async ({ filePath }) => { order.push(filePath); return ok(); });
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error'].map(level => jest.spyOn(console, level).mockImplementation((...a) => lines.push(a.join(' '))));
    let summary;
    try { summary = await processing.resumeAudioRecordings({ transcribe, now: clock(1000) }); } finally { spies.forEach(s => s.mockRestore()); }
    expect(summary).toMatchObject({ found: processing.SWEEP_CAP, capped: true, processed: processing.SWEEP_CAP });
    expect(transcribe).toHaveBeenCalledTimes(processing.SWEEP_CAP);
    const firstFile = (await File.findById(docs[docs.length - 1].audioFileId)).filename;
    expect(path.basename(order[0])).toBe(firstFile);
    const text = lines.join('\n');
    expect(text).toContain('audio_transcription_sweep');
    for (const doc of docs) expect(text).not.toContain(path.basename((await File.findById(doc.audioFileId)).filename));
    for (const forbidden of ['market', 'busy', 'recording.webm', uploadRoot]) expect(text).not.toContain(forbidden);
  });
});

describe('the worker', () => {
  afterEach(() => jest.useRealTimers());

  test('flag off: the worker never starts', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      expect(processing.startAudioWorkerIfEnabled({})).toBeNull();
      expect(processing.startAudioWorkerIfEnabled({ AUDIO_STT_ENABLED: 'false' })).toBeNull();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally { setIntervalSpy.mockRestore(); }
  });

  test('flag on: it starts, sweeps on a timer that does not keep the process alive, and stops', async () => {
    const transcribe = fakeTranscribe();
    const worker = processing.startAudioWorkerIfEnabled({ AUDIO_STT_ENABLED: 'true' }, { intervalMs: 60000, transcribe });
    try {
      expect(worker).toMatchObject({ intervalMs: 60000 });
      expect(typeof worker.stop).toBe('function');
      expect(worker.timer.hasRef()).toBe(false);
    } finally { worker.stop(); }
    await worker.idle();
  });

  test('server.js starts the worker only through the flag check and stops it on shutdown', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    expect(text).toMatch(/audioWorker = require\('\.\/services\/audio\/processing'\)\.startAudioWorkerIfEnabled\(\)/);
    expect(text).toMatch(/audioWorker\?\.stop\(\)/);
    expect(text.match(/services\/audio\//g)).toHaveLength(1);
  });
});
