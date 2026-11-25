'use strict';
// Speaking Coach minutes (services/audio/usage.js): practice recordings use their own per-teacher caps (SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER,
// SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER) and never use, or count toward, the graded caps (AUDIO_*_MINUTES_PER_TEACHER). Existing rows have
// no purpose and stay graded. In-memory MongoDB; time is injected; no provider call.
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const usage = require('../src/services/audio/usage');

const T0 = new Date('2026-11-25T10:00:00Z');
const now = () => new Date(T0);
const id = () => new mongoose.Types.ObjectId();

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => { await clearDatabase(); await AudioUsageLedger.createIndexes(); });

const recording = ({ teacher, seconds = 60, purpose } = {}) => ({ _id: id(), owner: id(), minutesChargedTo: teacher, durationSeconds: seconds,
  attemptKey: crypto.randomUUID(), leaseUntil: new Date(T0.getTime() + 600000), ...(purpose ? { purpose } : {}) });

async function history(teacher, seconds, { purpose, at = T0 } = {}) {
  const { dayKey, monthKey } = usage.utcKeys(at);
  await AudioUsageLedger.create({ key: crypto.randomUUID(), recordingId: id(), uploader: id(), minutesChargedTo: teacher, seconds, dayKey, monthKey,
    state: 'consumed', reservedAt: at, closedAt: at, expiresAt: at, ...(purpose ? { purpose } : {}) });
}

const GRADED_ENV = { AUDIO_DAILY_MINUTES_PER_TEACHER: '10', AUDIO_MONTHLY_MINUTES_PER_TEACHER: '100' };
const PRACTICE_ENV = { SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER: '5', SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER: '20' };
const ENV = { ...GRADED_ENV, ...PRACTICE_ENV };

test('readUsage: graded totals ignore practice rows, practice totals ignore graded rows', async () => {
  const teacher = id();
  await history(teacher, 120);
  await history(teacher, 30, { purpose: 'practice' });
  await history(teacher, 45, { purpose: 'graded' });
  expect(await usage.readUsage(teacher, { now })).toMatchObject({ daySeconds: 165, monthSeconds: 165 });
  expect(await usage.readUsage(teacher, { now, purpose: 'practice' })).toMatchObject({ daySeconds: 30, monthSeconds: 30 });
});

test('a practice reservation is stored as practice and counts only toward the practice caps', async () => {
  const teacher = id();
  const out = await usage.reserveMinutes({ recording: recording({ teacher, seconds: 50, purpose: 'practice' }), now, env: ENV });
  expect(out).toMatchObject({ ok: true, seconds: 50 });
  const row = await AudioUsageLedger.findOne({ key: out.key }).lean();
  expect(row).toMatchObject({ purpose: 'practice', state: 'reserved', seconds: 50 });
  await usage.consumeReservation(out.key, { now });
  expect((await usage.readUsage(teacher, { now })).daySeconds).toBe(0);
  expect((await usage.readUsage(teacher, { now, purpose: 'practice' })).daySeconds).toBe(50);
});

test('a graded reservation is unchanged: no purpose stored, graded caps only', async () => {
  const teacher = id();
  const out = await usage.reserveMinutes({ recording: recording({ teacher, seconds: 50 }), now, env: ENV });
  expect(out.ok).toBe(true);
  expect((await AudioUsageLedger.findOne({ key: out.key }).lean()).purpose).toBeUndefined();
});

test('practice over the practice daily cap: refused until the next UTC midnight; graded minutes are untouched', async () => {
  const teacher = id();
  await history(teacher, 5 * 60 - 30, { purpose: 'practice' });
  const refused = await usage.reserveMinutes({ recording: recording({ teacher, seconds: 60, purpose: 'practice' }), now, env: ENV });
  expect(refused).toEqual({ ok: false, code: 'AUDIO_DAILY_MINUTES_EXCEEDED', retryable: true, retryAt: new Date('2026-11-26T00:00:00Z') });
  const graded = await usage.reserveMinutes({ recording: recording({ teacher, seconds: 60 }), now, env: ENV });
  expect(graded.ok).toBe(true);
});

test('practice over the practice monthly cap: refused for good', async () => {
  const teacher = id();
  await history(teacher, 20 * 60 - 30, { purpose: 'practice', at: new Date('2026-11-02T10:00:00Z') });
  const refused = await usage.reserveMinutes({ recording: recording({ teacher, seconds: 60, purpose: 'practice' }), now, env: ENV });
  expect(refused).toMatchObject({ ok: false, code: 'AUDIO_MONTHLY_MINUTES_EXCEEDED', retryable: false });
});

test('graded minutes used up do not block practice, and practice minutes used up do not block graded work', async () => {
  const teacher = id();
  await history(teacher, 10 * 60);                          // the graded daily cap, fully used
  expect((await usage.reserveMinutes({ recording: recording({ teacher, seconds: 60 }), now, env: ENV })).code).toBe('AUDIO_DAILY_MINUTES_EXCEEDED');
  expect((await usage.reserveMinutes({ recording: recording({ teacher, seconds: 60, purpose: 'practice' }), now, env: ENV })).ok).toBe(true);

  const other = id();
  await history(other, 5 * 60, { purpose: 'practice' });    // the practice daily cap, fully used
  expect((await usage.reserveMinutes({ recording: recording({ teacher: other, seconds: 60, purpose: 'practice' }), now, env: ENV })).ok).toBe(false);
  expect((await usage.reserveMinutes({ recording: recording({ teacher: other, seconds: 60 }), now, env: ENV })).ok).toBe(true);
});

test('a practice recording longer than the whole practice daily cap is refused for good', async () => {
  const out = await usage.reserveMinutes({ recording: recording({ teacher: id(), seconds: 5 * 60 + 1, purpose: 'practice' }), now, env: ENV });
  expect(out).toMatchObject({ ok: false, code: 'AUDIO_RECORDING_EXCEEDS_DAILY_CAP', retryable: false });
});

test('minutesLeft: what is left today and this month, per purpose', async () => {
  const teacher = id();
  await history(teacher, 90, { purpose: 'practice' });
  await history(teacher, 120);
  expect(await usage.minutesLeft(teacher, { now, env: ENV, purpose: 'practice' })).toBe(5 * 60 - 90);
  expect(await usage.minutesLeft(teacher, { now, env: ENV })).toBe(10 * 60 - 120);
});
