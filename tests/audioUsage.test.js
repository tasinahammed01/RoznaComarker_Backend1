'use strict';
// Audio + speech-to-text, stage 4: per-teacher minute caps and the usage ledger (services/audio/usage.js, models/AudioUsageLedger.js), and the
// worker using them. In-memory MongoDB; the provider is always an injected fake and the global fetch is a tripwire. Time is injected.
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/audio-usage-test-${process.pid}`;
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
const logger = require('../src/utils/logger');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const File = require('../src/models/File');
const usage = require('../src/services/audio/usage');
const processing = require('../src/services/audio/processing');
const storage = require('../src/services/audio/storage');
const { SttError } = require('../src/services/audio/stt/errors');
const deepgram = require('../src/services/audio/stt/deepgram');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');

const T0 = new Date('2026-11-15T10:00:00Z');
const clockAt = date => () => new Date(date);
const id = () => new mongoose.Types.ObjectId();
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ok = () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false });

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => { await clearDatabase(); await AudioRecording.createIndexes(); await AudioUsageLedger.createIndexes(); });
afterEach(() => jest.restoreAllMocks());

/** A recording as the worker sees it after a claim (plain object). */
const claimedLike = ({ teacher = id(), owner = id(), seconds = 60, institutionId = null, attemptKey = crypto.randomUUID(), leaseUntil = new Date(T0.getTime() + 600000) } = {}) =>
  ({ _id: id(), owner, minutesChargedTo: teacher, institutionId, durationSeconds: seconds, attemptKey, leaseUntil });

/** Consumed history rows for a teacher: total seconds on a given instant. */
async function history(teacher, seconds, at = T0, extra = {}) {
  const { dayKey, monthKey } = usage.utcKeys(at);
  await AudioUsageLedger.create({ key: crypto.randomUUID(), recordingId: id(), uploader: id(), minutesChargedTo: teacher, seconds, dayKey, monthKey,
    state: 'consumed', reservedAt: at, closedAt: at, expiresAt: at, ...extra });
}

describe('UTC day and month keys', () => {
  test.each([
    ['2026-11-15T00:00:00.000Z', '2026-11-15', '2026-11', '2026-11-16T00:00:00.000Z'],
    ['2026-11-15T23:59:59.999Z', '2026-11-15', '2026-11', '2026-11-16T00:00:00.000Z'],
    ['2026-11-30T23:59:59.000Z', '2026-11-30', '2026-11', '2026-12-01T00:00:00.000Z'],
    ['2026-12-31T23:30:00.000Z', '2026-12-31', '2026-12', '2027-01-01T00:00:00.000Z']
  ])('%s is day %s, month %s; the next UTC midnight is %s', (instant, dayKey, monthKey, midnight) => {
    expect(usage.utcKeys(new Date(instant))).toEqual({ dayKey, monthKey });
    expect(usage.nextUtcMidnight(new Date(instant)).toISOString()).toBe(midnight);
  });

  test('keys are UTC whatever the server time zone (a +06:00 evening is still the UTC afternoon)', () => {
    expect(usage.utcKeys(new Date('2026-11-15T23:30:00+06:00'))).toEqual({ dayKey: '2026-11-15', monthKey: '2026-11' });
  });
});

describe('reserveMinutes', () => {
  test('a reservation counts whole seconds (rounded up), is keyed to the attempt, and ends with the lease', async () => {
    const recording = claimedLike({ seconds: 61.2, institutionId: id() });
    const result = await usage.reserveMinutes({ recording, now: clockAt(T0) });
    expect(result).toMatchObject({ ok: true, seconds: 62 });
    const rows = await AudioUsageLedger.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `${recording._id}:${recording.attemptKey}`, state: 'reserved', seconds: 62, dayKey: '2026-11-15', monthKey: '2026-11',
      minutesChargedTo: recording.minutesChargedTo, uploader: recording.owner, institutionId: recording.institutionId, recordingId: recording._id });
    expect(rows[0].expiresAt.toISOString()).toBe(recording.leaseUntil.toISOString());
  });

  test('the same attempt reserving twice keeps ONE row (a retried call never double-counts)', async () => {
    const recording = claimedLike();
    const first = await usage.reserveMinutes({ recording, now: clockAt(T0) });
    const second = await usage.reserveMinutes({ recording, now: clockAt(T0) });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, key: first.key });
    expect(await AudioUsageLedger.countDocuments()).toBe(1);
  });

  test('the same attempt reserving twice AT THE SAME TIME keeps one row and both calls succeed', async () => {
    const recording = claimedLike();
    const results = await Promise.all([1, 2, 3].map(() => usage.reserveMinutes({ recording, now: clockAt(T0) })));
    expect(results.every(r => r.ok)).toBe(true);
    expect(await AudioUsageLedger.countDocuments()).toBe(1);
  });

  describe('daily cap (default 120 minutes per teacher, per UTC day)', () => {
    test('exactly reaching the cap is allowed', async () => {
      const teacher = id();
      await history(teacher, 7140);                                              // 119 minutes today
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 60 }), now: clockAt(T0) })).toMatchObject({ ok: true });
    });

    test('one second over is refused: retryable, retry at the next UTC midnight, and the refusal is not counted', async () => {
      const teacher = id();
      await history(teacher, 7140);
      const result = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 61 }), now: clockAt(T0) });
      expect(result).toEqual({ ok: false, code: 'AUDIO_DAILY_MINUTES_EXCEEDED', retryable: true, retryAt: new Date('2026-11-16T00:00:00Z') });
      expect(await AudioUsageLedger.countDocuments({ state: 'refused' })).toBe(1);
      expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 7140, monthSeconds: 7140 });
    });

    test('UTC rollover: yesterday\'s minutes do not count today (they still count for the month)', async () => {
      const teacher = id();
      await history(teacher, 7200, new Date('2026-11-14T23:59:00Z'));
      const justAfterMidnight = new Date('2026-11-15T00:00:30Z');
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 420 }), now: clockAt(justAfterMidnight) })).toMatchObject({ ok: true });
      expect(await usage.readUsage(teacher, { now: clockAt(justAfterMidnight) })).toMatchObject({ daySeconds: 420, monthSeconds: 7620 });
    });

    test('the cap is read from AUDIO_DAILY_MINUTES_PER_TEACHER', async () => {
      const teacher = id();
      const env = { AUDIO_DAILY_MINUTES_PER_TEACHER: '2' };
      await history(teacher, 60);
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 61 }), now: clockAt(T0), env })).toMatchObject({ ok: false, code: 'AUDIO_DAILY_MINUTES_EXCEEDED' });
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 60 }), now: clockAt(T0), env })).toMatchObject({ ok: true });
    });

    test('a recording longer than the whole daily cap can never fit: permanent', async () => {
      const result = await usage.reserveMinutes({ recording: claimedLike({ seconds: 400 }), now: clockAt(T0), env: { AUDIO_DAILY_MINUTES_PER_TEACHER: '5' } });
      expect(result).toEqual({ ok: false, code: 'AUDIO_RECORDING_EXCEEDS_DAILY_CAP', retryable: false, retryAt: null });
      expect(await AudioUsageLedger.countDocuments()).toBe(0);
    });
  });

  describe('monthly cap (default 1500 minutes per teacher, per UTC month)', () => {
    test('over the month is refused: permanent (no automatic wait of up to a month)', async () => {
      const teacher = id();
      for (let day = 1; day <= 13; day++) await history(teacher, 6900, new Date(Date.UTC(2026, 10, day, 12)));   // 13 x 115 min = 1495 min
      const result = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 301 }), now: clockAt(T0) });
      expect(result).toEqual({ ok: false, code: 'AUDIO_MONTHLY_MINUTES_EXCEEDED', retryable: false, retryAt: null });
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 300 }), now: clockAt(T0) })).toMatchObject({ ok: true });
    });

    test('a new UTC month starts at zero', async () => {
      const teacher = id();
      for (let day = 1; day <= 13; day++) await history(teacher, 6900, new Date(Date.UTC(2026, 10, day, 12)));
      await history(teacher, 300, T0);
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 420 }), now: clockAt(new Date('2026-12-01T00:00:00Z')) }))
        .toMatchObject({ ok: true });
    });

    test('the month is checked before the day (the permanent reason wins)', async () => {
      const teacher = id();
      const env = { AUDIO_DAILY_MINUTES_PER_TEACHER: '10', AUDIO_MONTHLY_MINUTES_PER_TEACHER: '10' };
      await history(teacher, 600);
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 30 }), now: clockAt(T0), env })).toMatchObject({ code: 'AUDIO_MONTHLY_MINUTES_EXCEEDED' });
    });
  });

  describe('in flight: at most one transcription per uploading user, and one per teacher (exact caps without transactions)', () => {
    test('a second reservation for the same teacher while one is in flight is busy: retryable in 15 s', async () => {
      const teacher = id();
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) })).toMatchObject({ ok: true });
      const busy = await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) });
      expect(busy).toEqual({ ok: false, code: 'AUDIO_TRANSCRIPTION_BUSY', retryable: true, retryAt: new Date(T0.getTime() + 15000) });
      expect(await AudioUsageLedger.countDocuments()).toBe(1);
    });

    test('the same uploader under two different teachers: the second is busy', async () => {
      const owner = id();
      expect(await usage.reserveMinutes({ recording: claimedLike({ owner }), now: clockAt(T0) })).toMatchObject({ ok: true });
      expect(await usage.reserveMinutes({ recording: claimedLike({ owner }), now: clockAt(T0) })).toMatchObject({ ok: false, code: 'AUDIO_TRANSCRIPTION_BUSY' });
    });

    test('ten reservations at the same moment for one teacher: exactly one wins, none is counted twice', async () => {
      const teacher = id();
      const results = await Promise.all(Array.from({ length: 10 }, () => usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 400 }), now: clockAt(T0) })));
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.filter(r => !r.ok).every(r => r.code === 'AUDIO_TRANSCRIPTION_BUSY')).toBe(true);
      expect(await AudioUsageLedger.countDocuments({ state: 'reserved' })).toBe(1);
    });

    test('an in-flight reservation counts toward the cap check (a consumed one then blocks the next over the cap)', async () => {
      const teacher = id();
      const env = { AUDIO_DAILY_MINUTES_PER_TEACHER: '10' };
      const first = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 400 }), now: clockAt(T0), env });
      expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 400, reservedSeconds: 400 });
      await usage.consumeReservation(first.key, { now: clockAt(T0) });
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 201 }), now: clockAt(T0), env })).toMatchObject({ code: 'AUDIO_DAILY_MINUTES_EXCEEDED' });
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 200 }), now: clockAt(T0), env })).toMatchObject({ ok: true });
    });

    test('a reservation left by a stopped process stops counting and stops blocking once its lease ends', async () => {
      const teacher = id();
      const owner = id();
      await usage.reserveMinutes({ recording: claimedLike({ teacher, owner, seconds: 420, leaseUntil: new Date(T0.getTime() + 60000) }), now: clockAt(T0) });
      const later = new Date(T0.getTime() + 60001);
      expect(await usage.readUsage(teacher, { now: clockAt(later) })).toMatchObject({ daySeconds: 0, reservedSeconds: 0 });
      expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, owner }), now: clockAt(later) })).toMatchObject({ ok: true });
      expect(await AudioUsageLedger.countDocuments({ state: 'expired' })).toBe(1);
    });
  });

  test('release: the minutes are no longer counted and the slot is free; releasing twice is harmless', async () => {
    const teacher = id();
    const first = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 420 }), now: clockAt(T0) });
    expect(await usage.releaseReservation(first.key, { now: clockAt(T0), reason: 'failed' })).toEqual({ released: true });
    expect(await usage.releaseReservation(first.key, { now: clockAt(T0), reason: 'failed' })).toEqual({ released: false });
    expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 0, monthSeconds: 0 });
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) })).toMatchObject({ ok: true });
  });

  test('consume: counted for good; consuming twice is harmless; a released reservation is never consumed', async () => {
    const teacher = id();
    const first = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 100 }), now: clockAt(T0) });
    expect(await usage.consumeReservation(first.key, { now: clockAt(T0) })).toEqual({ consumed: true });
    expect(await usage.consumeReservation(first.key, { now: clockAt(T0) })).toEqual({ consumed: false });
    const second = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 50 }), now: clockAt(T0) });
    await usage.releaseReservation(second.key, { now: clockAt(T0), reason: 'cancelled' });
    expect(await usage.consumeReservation(second.key, { now: clockAt(T0) })).toEqual({ consumed: false });
    expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 100, monthSeconds: 100 });
  });

  test('a success stored just after the lease ended is still consumed (the result was kept)', async () => {
    const recording = claimedLike({ seconds: 100, leaseUntil: new Date(T0.getTime() + 1000) });
    const reserved = await usage.reserveMinutes({ recording, now: clockAt(T0) });
    await usage.reserveMinutes({ recording: claimedLike({ owner: recording.owner }), now: clockAt(new Date(T0.getTime() + 2000)) });   // expires it
    expect(await usage.consumeReservation(reserved.key, { now: clockAt(new Date(T0.getTime() + 3000)) })).toEqual({ consumed: true });
  });

  test.each([[null], [0], [NaN]])('a recording without a measured duration (%p) is refused: permanent', async (seconds) => {
    expect(await usage.reserveMinutes({ recording: { ...claimedLike(), durationSeconds: seconds }, now: clockAt(T0) }))
      .toEqual({ ok: false, code: 'AUDIO_USAGE_DURATION_UNKNOWN', retryable: false, retryAt: null });
  });

  test('a recording without an owning teacher is refused: permanent', async () => {
    expect(await usage.reserveMinutes({ recording: { ...claimedLike(), minutesChargedTo: null }, now: clockAt(T0) }))
      .toEqual({ ok: false, code: 'AUDIO_USAGE_OWNER_UNKNOWN', retryable: false, retryAt: null });
    expect(await AudioUsageLedger.countDocuments()).toBe(0);
  });
});

describe('institution teachers and plain teachers', () => {
  test('caps are per owning teacher: a colleague in the same institution, and a plain teacher, are not affected', async () => {
    const institutionId = id();
    const [teacherA, teacherB, plain] = [id(), id(), id()];
    await history(teacherA, 7200, T0, { institutionId });
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher: teacherA, institutionId }), now: clockAt(T0) })).toMatchObject({ code: 'AUDIO_DAILY_MINUTES_EXCEEDED' });
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher: teacherB, institutionId }), now: clockAt(T0) })).toMatchObject({ ok: true });
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher: plain }), now: clockAt(T0) })).toMatchObject({ ok: true });
    expect((await AudioUsageLedger.findOne({ minutesChargedTo: teacherB }).lean()).institutionId).toEqual(institutionId);
    expect((await AudioUsageLedger.findOne({ minutesChargedTo: plain }).lean()).institutionId).toBeNull();
  });

  test('minutes from students, guests and the teacher\'s own uploads all count against the owning teacher', async () => {
    const teacher = id();
    for (const owner of [id(), id(), teacher]) {
      const r = await usage.reserveMinutes({ recording: claimedLike({ teacher, owner, seconds: 2400 }), now: clockAt(T0) });
      expect(r).toMatchObject({ ok: true });
      await usage.consumeReservation(r.key, { now: clockAt(T0) });
    }
    expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 7200 });
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 5 }), now: clockAt(T0) })).toMatchObject({ code: 'AUDIO_DAILY_MINUTES_EXCEEDED' });
  });
});

describe('the usage read: inclusion projection, a limit, no database sort', () => {
  test('the query shape', () => {
    const teacher = id();
    const query = usage.usageQuery(teacher, { now: T0 });
    expect(query.projection).toEqual({ _id: 0, seconds: 1, dayKey: 1, state: 1 });
    expect(query.limit).toBe(usage.USAGE_READ_CAP + 1);
    expect(query.sort).toBeUndefined();
    expect(query.filter).toMatchObject({ minutesChargedTo: teacher, monthKey: '2026-11' });
  });

  test('explain: uses audio_usage_teacher_month_v1 with no SORT stage', async () => {
    const teacher = id();
    await history(teacher, 60);
    const { filter, projection, limit } = usage.usageQuery(teacher, { now: T0 });
    const plan = await AudioUsageLedger.find(filter).select(projection).limit(limit).explain('queryPlanner');
    const text = JSON.stringify(plan);
    expect(text).toContain('audio_usage_teacher_month_v1');
    expect(text).not.toMatch(/"stage":"SORT"/);
  });

  test('the query the reservation really sends: no sort, the inclusion projection, the limit', async () => {
    const spy = jest.spyOn(AudioUsageLedger, 'find');
    await usage.reserveMinutes({ recording: claimedLike(), now: clockAt(T0) });
    const queries = spy.mock.results.map(r => r.value).filter(q => q?.getOptions);
    expect(queries).toHaveLength(1);
    expect(queries[0].getOptions().sort).toBeUndefined();
    expect(queries[0].getOptions().limit).toBe(usage.USAGE_READ_CAP + 1);
    expect(queries[0]._fields).toEqual({ _id: 0, seconds: 1, dayKey: 1, state: 1 });
  });

  test('more rows than the read cap: refused (fail safe) and logged with counts only', async () => {
    const teacher = id();
    const metric = jest.spyOn(logger, 'metric');
    for (let i = 0; i < 4; i++) await history(teacher, 1);
    const result = await usage.reserveMinutes({ recording: claimedLike({ teacher, seconds: 5 }), now: clockAt(T0), readCap: 3 });
    expect(result).toMatchObject({ ok: false, code: 'AUDIO_USAGE_UNAVAILABLE', retryable: true });
    expect(metric).toHaveBeenCalledWith(expect.objectContaining({ event: 'audio_usage_read_capped', cap: 3 }));
    expect(await AudioUsageLedger.countDocuments({ state: 'reserved' })).toBe(0);
  });

  test('usage logs carry ids, codes and numbers only', async () => {
    const metric = jest.spyOn(logger, 'metric');
    const teacher = id();
    await history(teacher, 7200);
    await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) });
    const lines = metric.mock.calls.map(([fields]) => fields).filter(f => String(f.event).startsWith('audio_usage'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (const value of Object.values(line)) expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/\.webm|uploads|transcript/i);
  });
});

describe('the worker uses the ledger', () => {
  const teacher = id();
  async function makeRecording({ owner = id(), seconds = 60, minutesChargedTo = teacher } = {}) {
    fs.mkdirSync(storage.audioRoot(), { recursive: true });
    const fileName = `${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(storage.audioRoot(), fileName), Buffer.alloc(2048, 1));
    const file = await File.create({ originalName: 'recording.webm', filename: fileName, path: storage.storedPathFor(fileName), url: `/files/audio/${fileName}`,
      uploadedBy: owner, role: 'student', type: 'audio', sizeBytes: 2048 });
    const created = await AudioRecording.create({ owner, minutesChargedTo, requestId: crypto.randomUUID(), audioFileId: file._id, contentType: 'audio/webm',
      sizeBytes: 2048, durationSeconds: seconds, status: 'uploaded' });
    await processing.enqueue(created._id, { now: clockAt(T0) });
    return created._id;
  }
  const reload = recordingId => AudioRecording.findById(recordingId).select('+leaseUntil +attemptKey').lean();

  test('success: the minutes are consumed once', async () => {
    const recordingId = await makeRecording({ seconds: 61.5 });
    expect(await processing.processAudioRecording(recordingId, { transcribe: jest.fn(async () => ok()), now: clockAt(T0) })).toEqual({ status: 'ready' });
    const rows = await AudioUsageLedger.find({ recordingId }).lean();
    expect(rows.map(r => [r.state, r.seconds])).toEqual([['consumed', 62]]);
  });

  test('over the daily cap: refused BEFORE any provider call; queued again for the next UTC midnight without using an attempt', async () => {
    await history(teacher, 7200);
    const recordingId = await makeRecording();
    const transcribe = jest.fn(async () => ok());
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) })).toEqual({ status: 'queued', code: 'AUDIO_DAILY_MINUTES_EXCEEDED' });
    expect(transcribe).not.toHaveBeenCalled();
    const doc = await reload(recordingId);
    expect(doc).toMatchObject({ status: 'queued', attempts: 0, lastErrorCode: 'AUDIO_DAILY_MINUTES_EXCEEDED', leaseUntil: null });
    expect(doc.nextAttemptAt.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    // Not due before midnight; due after.
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(new Date('2026-11-15T23:59:59Z')) })).toEqual({ status: 'skipped' });
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(new Date('2026-11-16T00:00:01Z')) })).toEqual({ status: 'ready' });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  test('over the monthly cap: refused before any provider call; failed with a permanent code', async () => {
    for (let day = 1; day <= 13; day++) await history(teacher, 6900, new Date(Date.UTC(2026, 10, day, 12)));
    const recordingId = await makeRecording({ seconds: 400 });
    const transcribe = jest.fn(async () => ok());
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) })).toEqual({ status: 'failed', code: 'AUDIO_MONTHLY_MINUTES_EXCEEDED' });
    expect(transcribe).not.toHaveBeenCalled();
    expect(await reload(recordingId)).toMatchObject({ status: 'failed', lastErrorCode: 'AUDIO_MONTHLY_MINUTES_EXCEEDED' });
  });

  test('busy (another transcription in flight for this teacher): queued again in 15 s without using an attempt', async () => {
    await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) });
    const recordingId = await makeRecording();
    const transcribe = jest.fn(async () => ok());
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) })).toEqual({ status: 'queued', code: 'AUDIO_TRANSCRIPTION_BUSY' });
    expect(transcribe).not.toHaveBeenCalled();
    const doc = await reload(recordingId);
    expect(doc.attempts).toBe(0);
    expect(doc.nextAttemptAt.getTime()).toBe(T0.getTime() + 15000);
  });

  test('a retryable provider failure releases the minutes; the retry that succeeds is counted once', async () => {
    const recordingId = await makeRecording({ seconds: 100 });
    const transcribe = jest.fn()
      .mockRejectedValueOnce(new SttError('AUDIO_STT_PROVIDER_ERROR', { provider: 'deepgram', httpStatus: 503 }))
      .mockResolvedValueOnce(ok());
    expect((await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) })).status).toBe('queued');
    expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 0 });
    expect((await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(new Date(T0.getTime() + 15000)) })).status).toBe('ready');
    const rows = await AudioUsageLedger.find({ recordingId }).lean();
    expect(rows.map(r => r.state).sort()).toEqual(['consumed', 'released']);
    expect(await usage.readUsage(teacher, { now: clockAt(T0) })).toMatchObject({ daySeconds: 100, monthSeconds: 100 });
  });

  test.each([
    ['a permanent provider error', () => new SttError('AUDIO_STT_REJECTED', { provider: 'deepgram', httpStatus: 400 })],
    ['an unexpected exception', () => new TypeError('boom')]
  ])('%s releases the minutes', async (_label, makeError) => {
    const recordingId = await makeRecording();
    await processing.processAudioRecording(recordingId, { transcribe: jest.fn(async () => { throw makeError(); }), now: clockAt(T0) });
    expect((await AudioUsageLedger.find({ recordingId }).lean()).map(r => r.state)).toEqual(['released']);
  });

  test('a cancel during the provider call releases the minutes at once (the slot is free for the next recording)', async () => {
    const recordingId = await makeRecording();
    let started;
    const inCall = new Promise(resolve => { started = resolve; });
    const transcribe = jest.fn(({ signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(new SttError('AUDIO_STT_CANCELLED', { provider: 'deepgram' })));
    }));
    const running = processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) });
    await inCall;
    await processing.cancelAudioRecording(recordingId, { now: clockAt(T0) });
    expect(await running).toEqual({ status: 'discarded' });
    expect((await AudioUsageLedger.find({ recordingId }).lean()).map(r => r.state)).toEqual(['released']);
    expect(await usage.reserveMinutes({ recording: claimedLike({ teacher }), now: clockAt(T0) })).toMatchObject({ ok: true });
  });

  test('a cancel handled by another process releases the reservation it holds', async () => {
    const recordingId = await makeRecording();
    const claimed = await processing.claim(recordingId, { now: clockAt(T0) });
    await usage.reserveMinutes({ recording: claimed, now: clockAt(T0) });              // "another process" mid-call
    await processing.cancelAudioRecording(recordingId, { now: clockAt(T0) });
    expect((await AudioUsageLedger.find({ recordingId }).lean()).map(r => r.state)).toEqual(['released']);
  });

  test('a process that stopped mid-call: after its lease ends the work resumes and the minutes are counted once', async () => {
    const recordingId = await makeRecording({ seconds: 100 });
    const claimed = await processing.claim(recordingId, { now: clockAt(T0) });
    await usage.reserveMinutes({ recording: claimed, now: clockAt(T0) });              // then the process "dies"
    const afterLease = new Date(claimed.leaseUntil.getTime() + 1000);
    expect(await processing.processAudioRecording(recordingId, { transcribe: jest.fn(async () => ok()), now: clockAt(afterLease) })).toEqual({ status: 'ready' });
    const rows = await AudioUsageLedger.find({ recordingId }).lean();
    expect(rows.map(r => r.state).sort()).toEqual(['consumed', 'expired']);
    expect(await usage.readUsage(teacher, { now: clockAt(afterLease) })).toMatchObject({ daySeconds: 100 });
  });

  test('a recording without an owning teacher fails before any provider call (permanent)', async () => {
    const recordingId = await makeRecording({ minutesChargedTo: null });
    const transcribe = jest.fn(async () => ok());
    expect(await processing.processAudioRecording(recordingId, { transcribe, now: clockAt(T0) })).toEqual({ status: 'failed', code: 'AUDIO_USAGE_OWNER_UNKNOWN' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('the sweep handles several recordings of one teacher one after another (no busy refusals)', async () => {
    const ids = [await makeRecording(), await makeRecording(), await makeRecording()];
    const transcribe = jest.fn(async () => ok());
    const result = await processing.resumeAudioRecordings({ transcribe, now: clockAt(T0) });
    expect(result).toMatchObject({ found: 3, processed: 3 });
    for (const recordingId of ids) expect((await reload(recordingId)).status).toBe('ready');
    expect(await AudioUsageLedger.countDocuments({ state: 'consumed' })).toBe(3);
  });
});
