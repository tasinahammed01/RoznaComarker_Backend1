'use strict';
// Single-submission link resend ("Lost your feedback link?"). Called after the public answer has been sent.
// It never invalidates a link: a resend ADDS one more link to the submission (guest.recoveryAccess, newest 10 kept). So a third
// party who knows the email cannot cut the student off, and every email that is sent contains a link that works.
// Limits (cool-down + hourly cap per address) are the shared, atomic recovery limits; a failed send gives them back.
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const access = require('./guestAccess.service');
const quota = require('./recoveryEmailQuota.service');
const logger = require('../utils/logger');

const MAX_RECOVERY_LINKS = 10;

async function resendGuestLink({ emailNormalized, submissionId = null, qrToken = null, now = new Date(), env = process.env }) {
  let assignmentToken = qrToken;
  if (submissionId) {
    if (!mongoose.isValidObjectId(submissionId)) return { sent: false, reason: 'no_submission' };
    const original = await Submission.findOne({ _id: submissionId, submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized,
      'guest.revokedAt': null }).select('qrToken').lean();
    if (!original) return { sent: false, reason: 'no_submission' };
    assignmentToken = original.qrToken;
  }
  let assignment;
  try { ({ assignment } = await require('../controllers/guestSubmission.controller').assignmentFor(assignmentToken)); }
  catch { return { sent: false, reason: 'unavailable' }; }
  // The latest submission for this email in this assignment (or exactly the one asked for).
  const candidate = await Submission.findOne({ ...(submissionId ? { _id: submissionId } : {}), assignment: assignment._id, submissionMode: 'guest',
    'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null }).sort({ submittedAt: -1 }).select('_id').lean();
  if (!candidate) return { sent: false, reason: 'no_submission' };

  const slot = await quota.claim(emailNormalized, { now, env });
  if (!slot.granted) return { sent: false, reason: slot.reason };
  // A dedicated recovery email (not the submission receipt): what the link opens and how long it works; no title, name or score.
  const result = await deliverRecoveryLink({ submissionId: candidate._id, now, release: slot.release,
    send: (link, expiresInDays) => require('./email.service').sendGuestRecoveryEmail({ to: emailNormalized, link, expiresInDays }) });
  if (result.sent) logger.info({ event: 'guest_recovery_link_sent' });
  return result;
}

/**
 * Adds one new link to a guest submission and emails it with `send(link, expiresInDays)`. Shared by the student resend and the
 * teacher-sent link. Existing links are never invalidated. If the submission is gone/revoked or the email cannot be sent, the
 * unsent link is removed and `release()` gives the limits back, so nobody is locked out. Returns { sent, reason, code }.
 */
async function deliverRecoveryLink({ submissionId, now = new Date(), release, send }) {
  const issued = access.issueToken();
  let link;
  try { link = access.returnUrl(submissionId, issued.token); }    // frontend URL validated before anything is stored
  catch (error) { await release(); throw error; }
  const added = await Submission.updateOne({ _id: submissionId, submissionMode: 'guest', 'guest.revokedAt': null }, {
    $push: { 'guest.recoveryAccess': { $each: [{ hash: issued.accessHash, expiresAt: issued.expiresAt, createdAt: now }], $slice: -MAX_RECOVERY_LINKS } },
    $set: { 'guest.recoveredAt': now } });
  if (!added.modifiedCount) { await release(); return { sent: false, reason: 'no_submission' }; }
  let delivery;
  try { delivery = await send(link, Math.max(1, Math.round((issued.expiresAt.getTime() - now.getTime()) / 86400000))); }
  catch { delivery = { success: false, code: 'UNKNOWN' }; }
  if (!delivery?.success) {
    // Nobody received this link: remove it, and give the limits back so the student can be sent one again at once.
    await Submission.updateOne({ _id: submissionId }, { $pull: { 'guest.recoveryAccess': { hash: issued.accessHash } } });
    await release();
    const code = /^[A-Z_]{1,40}$/.test(delivery?.code || '') ? delivery.code : 'UNKNOWN';
    logger.warn({ event: 'guest_recovery_email_failed', code });
    return { sent: false, reason: 'delivery_failed', code };
  }
  return { sent: true };
}

module.exports = { resendGuestLink, deliverRecoveryLink, MAX_RECOVERY_LINKS };
