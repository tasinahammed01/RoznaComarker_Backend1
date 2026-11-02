'use strict';
// Multi-assignment recovery portal. One emailed link lists every guest submission made with that email address.
//   link token    32 random bytes (base64url, 43 chars), sent only in the email (URL fragment), stored as SHA-256, expires (default 24 h),
//                 usable a limited number of times (default 10), revocable.
//   portal session 32 random bytes, returned once by the exchange, sent as X-Recovery-Session, stored as SHA-256, short-lived
//                 (default 30 min, never past the link's expiry), READ-ONLY, and scoped to the link's email.
// Every lookup is constrained by the email behind the verified token: there is no other identity in this flow.
const crypto = require('crypto');
const RecoveryToken = require('../models/RecoveryToken');
const RecoverySession = require('../models/RecoverySession');
const Submission = require('../models/Submission');
const access = require('./guestAccess.service');
const logger = require('../utils/logger');

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const MAX_LIST = 200;
const PURGE_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const GENERIC_INVALID = 'This recovery link is invalid or has expired. Request a new link.';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bounded = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function config(env = process.env) {
  return {
    linkHours: bounded(env.RECOVERY_LINK_TTL_HOURS, 1, 168, 24),
    maxUses: bounded(env.RECOVERY_LINK_MAX_USES, 1, 100, 10),
    sessionMinutes: bounded(env.RECOVERY_SESSION_MINUTES, 5, 240, 30),
  };
}

const invalidLink = () => access.fail(410, GENERIC_INVALID, 'RECOVERY_LINK_INVALID');

/** Validates and normalises an email address (same rules as guest submissions). Throws a 400 for a malformed address only. */
function normalizeEmail(email) {
  return access.identity({ name: 'Recovery', email }).normalizedEmail;
}

const portalLink = token => access.frontendLink(`/recover/portal#${token}`);

/**
 * Creates a link and emails it, but only when the address has at least one guest submission and has not asked too often.
 * Returns what happened (for tests and the future teacher flow); callers facing the public never reveal it.
 * `source`/`issuedBy` let a teacher issue a link later (Task 5) through this same function.
 */
async function issueLink(emailNormalized, { source = 'student', issuedBy = null, now = new Date(), env = process.env } = {}) {
  const settings = config(env);
  const hasSubmissions = await Submission.exists({ submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null });
  if (!hasSubmissions) return { sent: false, reason: 'no_submissions' };
  // Shared with the single-submission link resend: per-address cool-down and hourly cap, both atomic.
  const slot = await require('./recoveryEmailQuota.service').claim(emailNormalized, { now, env });
  if (!slot.granted) return { sent: false, reason: slot.reason };
  const token = crypto.randomBytes(32).toString('base64url');
  let link;
  try { link = portalLink(token); }   // validates FRONTEND_URL before anything is stored
  catch (error) { await slot.release(); throw error; }
  const expiresAt = new Date(now.getTime() + settings.linkHours * 3600000);
  const doc = await RecoveryToken.create({ emailNormalized, tokenHash: sha(token), expiresAt, source, issuedBy,
    purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_EXPIRY_MS) });
  const delivery = await require('./email.service').sendRecoveryPortalEmail({ to: emailNormalized, link, expiresInHours: settings.linkHours });
  if (!delivery?.success) {
    // An undelivered link is useless; revoke it so it can never be used.
    await RecoveryToken.updateOne({ _id: doc._id }, { $set: { revokedAt: new Date() } });
    // The student must be able to ask again at once: the cool-down and hourly slot are given back.
    await slot.release();
    logger.warn({ event: 'recovery_link_delivery_failed', code: /^[A-Z_]{1,40}$/.test(delivery?.code || '') ? delivery.code : 'UNKNOWN' });
    return { sent: false, reason: 'delivery_failed' };
  }
  logger.info({ event: 'recovery_link_issued', source });
  return { sent: true };
}

/** Link token -> portal session. Any problem (shape, unknown, expired, revoked, used up) is the same generic 410. */
async function exchange(rawToken, { now = new Date(), env = process.env } = {}) {
  if (typeof rawToken !== 'string' || !TOKEN_SHAPE.test(rawToken)) throw invalidLink();
  const settings = config(env), tokenHash = sha(rawToken);
  const found = await RecoveryToken.findOne({ tokenHash }).select('+tokenHash').lean();
  if (!found || !sameHash(found.tokenHash, tokenHash)) { logger.warn({ event: 'recovery_link_rejected', reason: 'unknown' }); throw invalidLink(); }
  // Count the use atomically, only while the link is still valid.
  const used = await RecoveryToken.findOneAndUpdate({ _id: found._id, revokedAt: null, expiresAt: { $gt: now }, usedCount: { $lt: settings.maxUses } },
    { $inc: { usedCount: 1 }, $set: { lastUsedAt: now } }, { returnDocument: 'after' }).lean();
  if (!used) {
    logger.warn({ event: 'recovery_link_rejected', reason: found.revokedAt ? 'revoked' : found.expiresAt <= now ? 'expired' : 'used_up' });
    throw invalidLink();
  }
  const session = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(now.getTime() + settings.sessionMinutes * 60000, new Date(used.expiresAt).getTime()));
  await RecoverySession.create({ tokenId: used._id, emailNormalized: used.emailNormalized, sessionHash: sha(session), expiresAt });
  logger.info({ event: 'recovery_link_exchanged', useCount: used.usedCount });
  return { session, expiresAt };
}

/** X-Recovery-Session -> { emailNormalized }. Rejects unknown, expired or revoked sessions, and sessions of a revoked link. */
async function verifySession(rawSession, { now = new Date() } = {}) {
  if (typeof rawSession !== 'string' || !TOKEN_SHAPE.test(rawSession)) throw invalidLink();
  const sessionHash = sha(rawSession);
  const found = await RecoverySession.findOne({ sessionHash, revokedAt: null, expiresAt: { $gt: now } }).select('+sessionHash').lean();
  if (!found || !sameHash(found.sessionHash, sessionHash)) throw invalidLink();
  const link = await RecoveryToken.findOne({ _id: found.tokenId, revokedAt: null }).select('_id').lean();
  if (!link) throw invalidLink();
  return { emailNormalized: found.emailNormalized, sessionId: found._id };
}

// Same status rule as the result page (canonicalResultState.guestResultStatus), so the list never promises what the page does not show.
const listStatus = (submission, feedback) => {
  const { status } = require('./canonicalResultState.service').guestResultStatus({ submission, feedback });
  return status === 'complete' ? 'ready' : ['failed', 'blocked'].includes(status) ? 'failed' : 'processing';
};

/**
 * Every guest submission made with this email whose assignment and class are still open to guests (the same conditions the result
 * page checks). Minimal projection: no scores, no feedback, no names, no email, no teacher or class ids.
 */
async function listAssignments(emailNormalized) {
  const Assignment = require('../models/assignment.model'), Class = require('../models/class.model');
  const submissions = await Submission.find({ submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null })
    .select('-ocrPages -transcriptPages').sort({ submittedAt: -1, _id: -1 }).limit(MAX_LIST).lean();
  if (!submissions.length) return [];
  const assignments = await Assignment.find({ _id: { $in: [...new Set(submissions.map(s => String(s.assignment)))] }, isActive: true, allowGuestSubmission: true })
    .select('_id title class teacher').lean();
  const classes = await Class.find(require('./classLifecycle.service').withActiveStatus({
    _id: { $in: [...new Set(assignments.map(a => String(a.class)))] }, isActive: true })).select('_id name teacher').lean();
  const classById = new Map(classes.map(c => [String(c._id), c]));
  const feedbacks = await require('../models/SubmissionFeedback').find({ submissionId: { $in: submissions.map(x => x._id) } }).lean();
  const feedbackBySubmission = new Map(feedbacks.map(fb => [String(fb.submissionId), fb]));
  const assignmentById = new Map(assignments.map(a => [String(a._id), a]));
  return submissions.flatMap(s => {
    const assignment = assignmentById.get(String(s.assignment)), classDoc = assignment && classById.get(String(assignment.class));
    if (!assignment || !classDoc || String(classDoc.teacher) !== String(assignment.teacher)) return [];
    return [{ id: String(s._id), assignmentTitle: String(assignment.title || '').slice(0, 200), className: String(classDoc.name || '').slice(0, 120),
      submittedAt: s.submittedAt || s.createdAt || null, status: listStatus(s, feedbackBySubmission.get(String(s._id)) || null) }];
  });
}

/** The guest submission, only if it belongs to the session's email. Same generic error otherwise (no existence oracle). */
async function submissionForSession(submissionId, rawSession) {
  const { emailNormalized } = await verifySession(rawSession);
  if (!/^[a-f\d]{24}$/i.test(String(submissionId || ''))) throw invalidLink();
  const doc = await Submission.findOne({ _id: submissionId, submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null });
  if (!doc) { logger.warn({ event: 'recovery_portal_denied' }); throw access.fail(404, 'Results unavailable.', 'RECOVERY_NOT_FOUND'); }
  return doc;
}

async function endSession(rawSession) {
  if (typeof rawSession !== 'string' || !TOKEN_SHAPE.test(rawSession)) return;
  await RecoverySession.updateOne({ sessionHash: sha(rawSession), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/** Revokes every live link (and so every portal session) of an address. For support and the future teacher flow. */
async function revokeAllForEmail(emailNormalized) {
  const result = await RecoveryToken.updateMany({ emailNormalized, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return result.modifiedCount || 0;
}

module.exports = { config, normalizeEmail, issueLink, exchange, verifySession, listAssignments, submissionForSession, endSession, revokeAllForEmail,
  sha, TOKEN_SHAPE, GENERIC_INVALID };
