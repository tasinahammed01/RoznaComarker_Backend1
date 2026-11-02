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
async function claim(emailNormalized, { now = new Date(), env = process.env } = {}) {
  const Window = require('../models/RecoveryEmailWindow');
  const settings = config(env), key = sha(emailNormalized);
  const cooldownId = `${key}:cooldown`, until = new Date(now.getTime() + settings.cooldownSeconds * 1000);
  try {
    // Matches only when no cool-down is running; otherwise the upsert collides with the existing document (E11000).
    await Window.updateOne({ _id: cooldownId, $or: [{ until: { $lte: now } }, { until: null }] },
      { $set: { until, expiresAt: until } }, { upsert: true });
  } catch (error) {
    if (error?.code === 11000) return { granted: false, reason: 'cooldown', release: noop };
    throw error;
  }
  const releaseCooldown = () => Window.updateOne({ _id: cooldownId, until }, { $set: { until: now, expiresAt: now } });
  const hour = Math.floor(now.getTime() / 3600000), hourId = `${key}:${hour}`;
  let window;
  for (let attempt = 0; attempt < 2 && !window; attempt++) {
    try {
      window = await Window.findOneAndUpdate({ _id: hourId }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((hour + 2) * 3600000) } },
        { upsert: true, returnDocument: 'after' }).lean();
    } catch (error) {
      if (error?.code !== 11000 || attempt === 1) { await releaseCooldown(); throw error; }
    }
  }
  const releaseHour = () => Window.updateOne({ _id: hourId, count: { $gt: 0 } }, { $inc: { count: -1 } });
  if (window.count > settings.emailsPerHour) {
    await releaseHour();
    return { granted: false, reason: 'hourly', release: noop };
  }
  return { granted: true, reason: null, release: async () => { await Promise.all([releaseCooldown(), releaseHour()]); } };
}

module.exports = { config, publicAnswer, claim };
