'use strict';
// Per-teacher speech-to-text minutes (AUDIO_DAILY_MINUTES_PER_TEACHER, AUDIO_MONTHLY_MINUTES_PER_TEACHER), per UTC day and UTC month.
// The worker reserves BEFORE the provider call and settles after it (models/AudioUsageLedger.js):
// - Counted on reserve, for the cap check: a reservation in flight counts until its lease ends, so a check never misses minutes being used.
// - Kept only on success (consumed). A failed, cancelled or refused attempt is released; one left by a stopped process stops counting when
//   its lease ends (expired). So no attempt leaves minutes used for ever, and a retry (a new attempt) never counts twice.
// Refusals: daily cap -> retryable at the next UTC midnight; monthly cap, a recording longer than the whole daily cap, or no owning teacher ->
// permanent; busy (one in flight already) or the usage could not be read -> retryable soon.
// Reads are an inclusion projection with a limit and no sort; logs carry ids, codes and numbers only.
const AudioUsageLedger = require('../../models/AudioUsageLedger');
const logger = require('../../utils/logger');
const { readLimits } = require('./policy');

const USAGE_READ_CAP = 20000;                // > 1500 min / 5 s minimum duration = 18000 attempts in a month
const BUSY_RETRY_MS = 15000;
const UNAVAILABLE_RETRY_MS = 60000;
const PROJECTION = Object.freeze({ _id: 0, seconds: 1, dayKey: 1, state: 1 });

const pad = n => String(n).padStart(2, '0');
function utcKeys(date) {
  const d = new Date(date);
  const monthKey = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return { dayKey: `${monthKey}-${pad(d.getUTCDate())}`, monthKey };
}
const nextUtcMidnight = date => { const d = new Date(date); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)); };

const refusal = (code, retryable, retryAt = null) => ({ ok: false, code, retryable, retryAt: retryable ? retryAt : null });
const log = fields => logger.metric(fields);

// Speaking Coach: practice minutes ('practice' rows) have their own caps and never count toward the graded caps, and graded minutes (rows with no
// purpose, or 'graded') never count toward the practice caps. So practice can never use up the minutes graded work needs.
const PRACTICE = 'practice';
const purposeFilter = purpose => (purpose === PRACTICE ? { purpose: PRACTICE } : { purpose: { $ne: PRACTICE } });
/** The daily and monthly caps in seconds for one purpose. */
function capsFor(purpose, env) {
  if (purpose === PRACTICE) {
    const { settings } = require('../speakingCoach/policy').readSettings(env);
    return { dailyCap: settings.dailyMinutesPerTeacher * 60, monthlyCap: settings.monthlyMinutesPerTeacher * 60 };
  }
  const { limits } = readLimits(env);
  return { dailyCap: limits.dailyMinutesPerTeacher * 60, monthlyCap: limits.monthlyMinutesPerTeacher * 60 };
}

/** The cap read for one teacher's UTC month and one purpose (graded by default): consumed rows and reservations still in flight. */
function usageQuery(teacher, { now = new Date(), purpose } = {}) {
  const at = new Date(now);
  return {
    filter: { minutesChargedTo: teacher, monthKey: utcKeys(at).monthKey, ...purposeFilter(purpose),
      $or: [{ state: 'consumed' }, { state: 'reserved', expiresAt: { $gt: at } }] },
    projection: { ...PROJECTION },
    limit: USAGE_READ_CAP + 1
  };
}

/** { daySeconds, monthSeconds, reservedSeconds, capped } for the UTC day and month of now(). Both totals include in-flight reservations. */
async function readUsage(teacher, { now = () => new Date(), readCap = USAGE_READ_CAP, purpose } = {}) {
  const at = now();
  const { filter, projection } = usageQuery(teacher, { now: at, purpose });
  const rows = await AudioUsageLedger.find(filter).select(projection).limit(readCap + 1).lean();
  const { dayKey } = utcKeys(at);
  const totals = { daySeconds: 0, monthSeconds: 0, reservedSeconds: 0, capped: rows.length > readCap };
  for (const row of rows) {
    totals.monthSeconds += row.seconds;
    if (row.dayKey === dayKey) totals.daySeconds += row.seconds;
    if (row.state === 'reserved') totals.reservedSeconds += row.seconds;
  }
  return totals;
}

const close = (filter, state, at, reason = null) => AudioUsageLedger.updateOne(filter, { $set: { state, closedAt: at, reason } });

/**
 * Reserves the minutes of one attempt (recording: the claimed AudioRecording with attemptKey and leaseUntil). Returns
 * { ok: true, key, seconds } or { ok: false, code, retryable, retryAt }. Idempotent per attempt.
 */
async function reserveMinutes({ recording, now = () => new Date(), env = process.env, readCap = USAGE_READ_CAP }) {
  const teacher = recording.minutesChargedTo;
  const recordingId = String(recording._id);
  if (!teacher) return refusal('AUDIO_USAGE_OWNER_UNKNOWN', false);
  const duration = Number(recording.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return refusal('AUDIO_USAGE_DURATION_UNKNOWN', false);
  const purpose = recording.purpose === PRACTICE ? PRACTICE : undefined;
  const { dailyCap, monthlyCap } = capsFor(purpose, env);
  const seconds = Math.ceil(duration);
  if (seconds > dailyCap) { log({ event: 'audio_usage_refused', recordingId, code: 'AUDIO_RECORDING_EXCEEDS_DAILY_CAP', seconds }); return refusal('AUDIO_RECORDING_EXCEEDS_DAILY_CAP', false); }

  const key = `${recordingId}:${recording.attemptKey}`;
  const mine = async () => {
    const row = await AudioUsageLedger.findOne({ key }).select({ _id: 0, state: 1, seconds: 1 }).lean();
    if (!row) return null;
    return ['reserved', 'consumed'].includes(row.state) ? { ok: true, key, seconds: row.seconds } : refusal('AUDIO_TRANSCRIPTION_BUSY', true, new Date(now().getTime() + BUSY_RETRY_MS));
  };
  const existing = await mine();
  if (existing) return existing;

  const at = now();
  const { dayKey, monthKey } = utcKeys(at);
  // Reservations left by a stopped process stop blocking once their lease has ended.
  await AudioUsageLedger.updateMany({ state: 'reserved', expiresAt: { $lte: at }, $or: [{ minutesChargedTo: teacher }, { uploader: recording.owner }] },
    { $set: { state: 'expired', closedAt: at, reason: 'lease_ended' } });
  try {
    await AudioUsageLedger.create({ key, recordingId: recording._id, uploader: recording.owner, minutesChargedTo: teacher, institutionId: recording.institutionId || null,
      seconds, dayKey, monthKey, state: 'reserved', reservedAt: at, expiresAt: recording.leaseUntil, ...(purpose ? { purpose } : {}) });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const same = await mine();                                                  // the same attempt, concurrently: one row
    if (same) return same;
    log({ event: 'audio_usage_busy', recordingId });
    return refusal('AUDIO_TRANSCRIPTION_BUSY', true, new Date(at.getTime() + BUSY_RETRY_MS));
  }

  const usage = await readUsage(teacher, { now: () => at, readCap, purpose });
  if (usage.capped) {
    await close({ key, state: 'reserved' }, 'released', at, 'usage_unavailable');
    log({ event: 'audio_usage_read_capped', recordingId, cap: readCap });
    return refusal('AUDIO_USAGE_UNAVAILABLE', true, new Date(at.getTime() + UNAVAILABLE_RETRY_MS));
  }
  const over = usage.monthSeconds > monthlyCap ? refusal('AUDIO_MONTHLY_MINUTES_EXCEEDED', false)
    : usage.daySeconds > dailyCap ? refusal('AUDIO_DAILY_MINUTES_EXCEEDED', true, nextUtcMidnight(at)) : null;
  if (over) {
    await close({ key, state: 'reserved' }, 'refused', at, over.code);
    log({ event: 'audio_usage_refused', recordingId, ...(purpose ? { purpose } : {}), code: over.code, seconds, daySeconds: usage.daySeconds - seconds, monthSeconds: usage.monthSeconds - seconds });
    return over;
  }
  log({ event: 'audio_usage_reserved', recordingId, ...(purpose ? { purpose } : {}), seconds, daySeconds: usage.daySeconds, monthSeconds: usage.monthSeconds });
  return { ok: true, key, seconds };
}

/** The transcript was stored: the minutes count for good (also when the lease had just ended). */
async function consumeReservation(key, { now = () => new Date() } = {}) {
  const result = await AudioUsageLedger.updateOne({ key, state: { $in: ['reserved', 'expired'] } }, { $set: { state: 'consumed', closedAt: now(), reason: null } });
  return { consumed: result.modifiedCount === 1 };
}

/** The attempt ended without a stored transcript: the minutes never count. */
async function releaseReservation(key, { now = () => new Date(), reason = 'not_stored' } = {}) {
  const result = await close({ key, state: 'reserved' }, 'released', now(), reason);
  return { released: result.modifiedCount === 1 };
}

/** A cancel: releases whatever attempt of this recording is in flight (here or in another process). */
async function releaseRecordingReservations(recordingId, { now = () => new Date(), reason = 'cancelled' } = {}) {
  const result = await AudioUsageLedger.updateMany({ recordingId, state: 'reserved' }, { $set: { state: 'released', closedAt: now(), reason } });
  return { released: result.modifiedCount || 0 };
}

/** Seconds left today and this month (the smaller) for one teacher and purpose. 0 when the usage cannot be read in full. Read-only. */
async function minutesLeft(teacher, { now = () => new Date(), env = process.env, purpose } = {}) {
  const { dailyCap, monthlyCap } = capsFor(purpose, env);
  const used = await readUsage(teacher, { now, purpose });
  if (used.capped) return 0;
  return Math.max(0, Math.min(dailyCap - used.daySeconds, monthlyCap - used.monthSeconds));
}

module.exports = { USAGE_READ_CAP, BUSY_RETRY_MS, PRACTICE, utcKeys, nextUtcMidnight, usageQuery, readUsage, reserveMinutes, consumeReservation,
  releaseReservation, releaseRecordingReservations, minutesLeft };
