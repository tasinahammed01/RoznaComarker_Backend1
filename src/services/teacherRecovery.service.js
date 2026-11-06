'use strict';
// A teacher sends a recovery link for ONE guest submission in the teacher's own class (Task 5).
//   link        the same per-submission link a student resend creates (guest.recoveryAccess): it opens only this submission,
//               never other teachers' classes, and never invalidates the student's existing links
//   recipient   always the email stored on the submission; the request carries no address
//   limits      per teacher per hour + the shared per-address cool-down and hourly cap; all atomic; a failed send gives them back
//   response    honest for the authenticated owner (sent / throttled + retryAfterSeconds / no email / refused) with a MASKED address;
//               never the link, the token or the full address
//   audit       every attempt in RecoveryLinkAudit (masked address, result), never secrets
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Class = require('../models/class.model');
const RecoveryLinkAudit = require('../models/RecoveryLinkAudit');
const quota = require('./recoveryEmailQuota.service');
const { deliverRecoveryLink } = require('./guestRecovery.service');
const logger = require('../utils/logger');

const fail = (statusCode, code, message, extra = {}) => Object.assign(new Error(message), { statusCode, code, ...extra });

/** "jane.doe@gmail.com" -> "j***@gmail.com". Shows enough to recognise the address, not enough to use it. */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return null;
  return `${local[0]}***@${domain}`;
}

/** The guest submission, only if it is in a class this teacher owns. Anything else is the same 404 (no existence oracle). */
async function ownedSubmission(teacherId, submissionId) {
  if (!mongoose.isValidObjectId(submissionId)) throw fail(404, 'SUBMISSION_NOT_FOUND', 'Submission not found');
  const submission = await Submission.findById(submissionId).select('+guest.normalizedEmail submissionMode class guest.revokedAt').lean();
  if (!submission) throw fail(404, 'SUBMISSION_NOT_FOUND', 'Submission not found');
  // Same ownership rule as the teacher's submission list: an active class taught by this teacher.
  const owned = await Class.exists({ _id: submission.class, teacher: teacherId, isActive: true });
  if (!owned) throw fail(404, 'SUBMISSION_NOT_FOUND', 'Submission not found');
  return submission;
}

async function audit(entry) {
  try { await RecoveryLinkAudit.create({ source: 'teacher', ...entry }); }
  catch { logger.warn({ event: 'teacher_recovery_audit_failed' }); }
}

/** What the teacher's screen shows before sending. */
async function status(teacherId, submissionId) {
  const submission = await ownedSubmission(teacherId, submissionId);
  const lastSent = await RecoveryLinkAudit.findOne({ submissionId: submission._id, result: 'sent' }).sort({ createdAt: -1 }).select('createdAt').lean();
  const email = submission.guest?.normalizedEmail || null;
  const reason = submission.submissionMode !== 'guest' ? 'registered' : submission.guest?.revokedAt ? 'revoked' : !email ? 'no_email' : null;
  return { available: !reason, reason, emailMasked: maskEmail(email), lastSentAt: lastSent?.createdAt || null };
}

/** Sends the link. Throws coded errors (statusCode + code + safe message) for every outcome other than "sent". */
async function sendLink(teacherId, submissionId, { now = new Date(), env = process.env } = {}) {
  const submission = await ownedSubmission(teacherId, submissionId);
  const base = { issuedBy: teacherId, submissionId: submission._id, classId: submission.class || null };
  if (submission.submissionMode !== 'guest') {
    await audit({ ...base, result: 'refused', reason: 'registered' });
    throw fail(409, 'REGISTERED_STUDENT', 'This student has an account and can sign in to see their work. Recovery links are only for guest submissions.');
  }
  if (submission.guest?.revokedAt) {
    await audit({ ...base, result: 'refused', reason: 'revoked' });
    throw fail(409, 'GUEST_ACCESS_REVOKED', 'Guest access to this submission was revoked, so a new link would not open it.');
  }
  const email = submission.guest?.normalizedEmail;
  const emailMasked = maskEmail(email);
  if (!emailMasked) {
    await audit({ ...base, result: 'no_email' });
    throw fail(409, 'NO_EMAIL_ON_RECORD', 'There is no email address on record for this submission.');
  }
  const teacherSlot = await quota.claimTeacherSlot(teacherId, { now, env });
  if (!teacherSlot.granted) {
    await audit({ ...base, emailMasked, result: 'throttled', reason: teacherSlot.reason });
    throw fail(429, 'TEACHER_LIMIT', 'You have sent many recovery links recently. Please try again later.', { retryAfterSeconds: teacherSlot.retryAfterSeconds, emailMasked });
  }
  const addressSlot = await quota.claim(email, { now, env });
  if (!addressSlot.granted) {
    await teacherSlot.release();
    await audit({ ...base, emailMasked, result: 'throttled', reason: addressSlot.reason });
    throw fail(429, addressSlot.reason === 'cooldown' ? 'ADDRESS_COOLDOWN' : 'ADDRESS_HOURLY_LIMIT',
      addressSlot.reason === 'cooldown' ? 'A link was sent to this address a moment ago. Please wait before sending another.'
        : 'This address has received the maximum number of links for now. Please try again later.',
      { retryAfterSeconds: addressSlot.retryAfterSeconds, emailMasked });
  }
  const result = await deliverRecoveryLink({ submissionId: submission._id, now,
    release: async () => { await Promise.all([teacherSlot.release(), addressSlot.release()]); },
    send: (link, expiresInDays) => require('./email.service').sendTeacherRecoveryEmail({ to: email, link, expiresInDays }) });
  if (!result.sent) {
    await audit({ ...base, emailMasked, result: 'failed', reason: result.reason });
    throw result.reason === 'no_submission'
      ? fail(409, 'GUEST_ACCESS_REVOKED', 'Guest access to this submission was revoked, so a new link would not open it.')
      : fail(502, 'EMAIL_FAILED', 'The email could not be sent. Nothing was changed; please try again.', { emailMasked });
  }
  await audit({ ...base, emailMasked, result: 'sent' });
  logger.info({ event: 'teacher_recovery_link_sent' });
  return { sent: true, emailMasked, lastSentAt: now };
}

module.exports = { maskEmail, status, sendLink };
