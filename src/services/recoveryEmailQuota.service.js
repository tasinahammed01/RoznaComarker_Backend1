'use strict';
// Shared limits and public answer for every recovery email (single-submission link resend and the multi-assignment portal link).
//   cool-down   one email per address per RECOVERY_EMAIL_COOLDOWN_SECONDS (default 120 s), claimed atomically
//   hourly cap  at most RECOVERY_EMAILS_PER_HOUR (default 3) per address per clock hour, atomic counter
// Both are claimed before a link is created; a failed send releases them, so an SMTP failure never locks the student out.
// The public answer is identical for every request (known or unknown address, sent or throttled), so it reveals nothing.
const crypto = require('crypto');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bounded = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function config(env = process.env) {
  return {
    cooldownSeconds: bounded(env.RECOVERY_EMAIL_COOLDOWN_SECONDS, 30, 3600, 120),
    emailsPerHour: bounded(env.RECOVERY_EMAILS_PER_HOUR, 1, 20, 3),
    // Requests (not emails) per address per hour at the HTTP layer, for every recovery endpoint.
    requestsPerHour: bounded(env.RECOVERY_REQUESTS_PER_HOUR, 3, 100, 10),
    // Teacher-sent recovery links per teacher account per clock hour.
    teacherSendsPerHour: bounded(env.RECOVERY_TEACHER_SENDS_PER_HOUR, 1, 200, 20),
  };
}

/** The same answer for every accepted request. `retryAfterSeconds` is the configured cool-down, never a per-address value. */
function publicAnswer(env = process.env) {
  const { cooldownSeconds } = config(env);
  const wait = cooldownSeconds % 60 === 0 ? `${cooldownSeconds / 60} minute${cooldownSeconds === 60 ? '' : 's'}` : `${cooldownSeconds} seconds`;
  return {
    message: `If we found submissions for this email address, we have sent a link. It can take a few minutes to arrive, so please check your spam folder. You can ask again in ${wait}.`,
    retryAfterSeconds: cooldownSeconds,
  };
}

const noop = async () => {};

/**
 * Claims the right to send one recovery email to this address now. Returns { granted, reason, release }.
 * `release()` gives the slot back (used when the email could not be sent).
 */
const secondsToNextHour = now => Math.max(1, Math.ceil(((Math.floor(now.getTime() / 3600000) + 1) * 3600000 - now.getTime()) / 1000));

/** Atomic hourly counter (one document per key and clock hour). Returns { count, release }; a lost upsert race is retried once. */
async function incrementHour(keyPrefix, now) {
  const Window = require('../models/RecoveryEmailWindow');
  const hour = Math.floor(now.getTime() / 3600000), _id = `${keyPrefix}:${hour}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const window = await Window.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((hour + 2) * 3600000) } },
        { upsert: true, returnDocument: 'after' }).lean();
      return { count: window.count, release: () => Window.updateOne({ _id, count: { $gt: 0 } }, { $inc: { count: -1 } }) };
    } catch (error) {
      if (error?.code !== 11000 || attempt === 1) throw error;
    }
  }
  throw new Error('unreachable');
}

/**
 * Claims the right to send one recovery email to this address now. Returns { granted, reason, retryAfterSeconds, release }.
 * `release()` gives the slot back (used when the email could not be sent). `retryAfterSeconds` is only for authenticated callers
 * (a teacher); the public endpoints answer with the fixed publicAnswer() and never reveal it.
 */
async function claim(emailNormalized, { now = new Date(), env = process.env } = {}) {
  const Window = require('../models/RecoveryEmailWindow');
  const settings = config(env), key = sha(emailNormalized);
  const cooldownId = `${key}:cooldown`, until = new Date(now.getTime() + settings.cooldownSeconds * 1000);
  try {
    // Matches only when no cool-down is running; otherwise the upsert collides with the existing document (E11000).
    await Window.updateOne({ _id: cooldownId, $or: [{ until: { $lte: now } }, { until: null }] },
      { $set: { until, expiresAt: until } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const running = await Window.findById(cooldownId).lean().catch(() => null);
    const left = running?.until ? Math.ceil((new Date(running.until).getTime() - now.getTime()) / 1000) : settings.cooldownSeconds;
    return { granted: false, reason: 'cooldown', retryAfterSeconds: Math.max(1, Math.min(left, settings.cooldownSeconds)), release: noop };
  }
  const releaseCooldown = () => Window.updateOne({ _id: cooldownId, until }, { $set: { until: now, expiresAt: now } });
  let hourly;
  try { hourly = await incrementHour(key, now); } catch (error) { await releaseCooldown(); throw error; }
  if (hourly.count > settings.emailsPerHour) {
    await hourly.release();
    return { granted: false, reason: 'hourly', retryAfterSeconds: secondsToNextHour(now), release: noop };
  }
  return { granted: true, reason: null, retryAfterSeconds: 0, release: async () => { await Promise.all([releaseCooldown(), hourly.release()]); } };
}

/** Per-teacher cap on teacher-sent recovery links (RECOVERY_TEACHER_SENDS_PER_HOUR), atomic like the per-address cap. */
async function claimTeacherSlot(teacherId, { now = new Date(), env = process.env } = {}) {
  const { teacherSendsPerHour } = config(env);
  const hourly = await incrementHour(`teacher:${String(teacherId)}`, now);
  if (hourly.count > teacherSendsPerHour) {
    await hourly.release();
    return { granted: false, reason: 'teacher_hourly', retryAfterSeconds: secondsToNextHour(now), release: noop };
  }
  return { granted: true, reason: null, retryAfterSeconds: 0, release: async () => { await hourly.release(); } };
}

module.exports = { config, publicAnswer, claim, claimTeacherSlot };
