'use strict';
// Sends the feedback email for work a teacher uploaded, once its marking is complete, only when the teacher asked for it
// ("Save and send" or Send: teacherUpload.email.status 'queued'). A plain "Save" (status 'none') is never emailed.
//
// Exactly once: a worker claims an email atomically (queued -> sending, with a lease), so parallel workers never send the same
// one twice. After a crash or restart an email left in 'sending' may already have been delivered, so it is never resent by
// itself: it is marked failed (DELIVERY_UNCERTAIN) and the teacher can press Resend. Failures are retried with backoff up to
// MAX_ATTEMPTS, then marked failed with a safe error code. At most RATE_LIMIT emails per teacher in any RATE_WINDOW_MS.
const Submission = require('../models/Submission');
const Assignment = require('../models/assignment.model');
const User = require('../models/user.model');
const Quota = require('../models/TeacherEmailQuota');
const access = require('./guestAccess.service');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const LEASE_MS = 5 * 60 * 1000;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_RETRY_MS = 60 * 1000;
const RECOVERY_LINKS_KEPT = 10;

const due = now => ({ $or: [{ 'teacherUpload.email.nextAttemptAt': null }, { 'teacherUpload.email.nextAttemptAt': { $lte: now } }] });

/** Reserves one email for this teacher in the sliding window; false when RATE_LIMIT were already sent in it. Atomic. */
async function reserveQuota(teacherId, now = new Date()) {
  const cutoff = new Date(now.getTime() - RATE_WINDOW_MS);
  const doc = await Quota.findOneAndUpdate({ _id: String(teacherId) }, [
    { $set: { sent: { $filter: { input: { $ifNull: ['$sent', []] }, cond: { $gt: ['$$this', cutoff] } } } } },
    { $set: { accepted: { $lt: [{ $size: '$sent' }, RATE_LIMIT] } } },
    { $set: { sent: { $cond: ['$accepted', { $concatArrays: ['$sent', [now]] }, '$sent'] } } }
  ], { upsert: true, returnDocument: 'after', updatePipeline: true }).lean();
  return Boolean(doc?.accepted);
}

/** Emails stuck in 'sending' past their lease (a crash or restart mid-send) are not resent: they may have been delivered. */
async function settleInterrupted(now) {
  const result = await Submission.updateMany({ 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': { $lte: now } }, {
    $set: { 'teacherUpload.email.status': 'failed', 'teacherUpload.email.failedAt': now, 'teacherUpload.email.lastErrorCode': 'DELIVERY_UNCERTAIN' },
    $unset: { 'teacherUpload.email.leaseUntil': 1, 'teacherUpload.email.nextAttemptAt': 1 } });
  if (result.modifiedCount) logger.warn({ event: 'teacher_upload_email_interrupted', count: result.modifiedCount });
}

/** Recipient, link and wording for one claimed submission. Guests get a new private link (added; earlier links keep working). */
async function messageFor(doc, lease) {
  const [assignment, teacher] = await Promise.all([
    Assignment.findById(doc.assignment).select('title').lean(),
    User.findById(doc.teacherUpload.uploadedBy).select('displayName').lean()
  ]);
  const common = { teacherName: teacher?.displayName || '', assignmentTitle: assignment?.title || '' };
  if (doc.submissionMode === 'guest') {
    const issued = access.issueToken();
    const stored = await Submission.updateOne({ _id: doc._id, 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': lease }, {
      $push: { 'guest.recoveryAccess': { $each: [{ hash: issued.accessHash, expiresAt: issued.expiresAt, createdAt: new Date() }], $slice: -RECOVERY_LINKS_KEPT } } });
    if (!stored.modifiedCount) return null;
    return { ...common, to: doc.guest.normalizedEmail, studentName: doc.guest.displayName, link: access.returnUrl(doc._id, issued.token),
      expiresAt: issued.expiresAt, needsLogin: false, issuedHash: issued.accessHash };
  }
  const student = await User.findById(doc.student).select('email displayName').lean();
  if (!student?.email) return { error: 'RECIPIENT_MISSING' };
  return { ...common, to: student.email, studentName: student.displayName || '', needsLogin: true,
    link: access.frontendLink(`/student/my-classes/detail/my-submissions/${doc.assignment}?classId=${doc.class}`) };
}

async function sendOne(candidate, now) {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await Submission.findOneAndUpdate({ _id: candidate._id, 'teacherUpload.email.status': 'queued', assessmentStatus: 'complete', ...due(now) },
    { $set: { 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': lease }, $inc: { 'teacherUpload.email.attempts': 1 } },
    { returnDocument: 'after' }).select('+teacherUpload +guest.normalizedEmail _id submissionMode student assignment class guest.displayName').lean();
  if (!claimed) return 'skipped';                                        // another worker took it, or it changed
  const owned = { _id: claimed._id, 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': lease };
  const teacherId = claimed.teacherUpload.uploadedBy;
  if (!await reserveQuota(teacherId, now)) {
    await Submission.updateOne(owned, { $set: { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.nextAttemptAt': new Date(now.getTime() + RATE_RETRY_MS) },
      $inc: { 'teacherUpload.email.attempts': -1 }, $unset: { 'teacherUpload.email.leaseUntil': 1 } });
    return 'deferred';
  }
  let message, delivery;
  try {
    message = await messageFor(claimed, lease);
    delivery = !message ? { success: false, code: 'CHANGED_WHILE_SENDING' } : message.error ? { success: false, code: message.error }
      : await require('./email.service').sendTeacherUploadFeedbackEmail(message);
  } catch {
    delivery = { success: false, code: 'OTHER_SAFE_PROVIDER_FAILURE' };
  }
  if (delivery.success) {
    await Submission.updateOne(owned, { $set: { 'teacherUpload.email.status': 'sent', 'teacherUpload.email.sentAt': new Date() },
      $unset: { 'teacherUpload.email.leaseUntil': 1, 'teacherUpload.email.nextAttemptAt': 1, 'teacherUpload.email.lastErrorCode': 1, 'teacherUpload.email.failedAt': 1 } });
    return 'sent';
  }
  const code = String(delivery.code || 'OTHER_SAFE_PROVIDER_FAILURE').slice(0, 64);
  const attempts = Number(claimed.teacherUpload.email.attempts) || 1;
  const finalFailure = attempts >= MAX_ATTEMPTS || ['RECIPIENT_MISSING', 'TEMPLATE_FAILURE'].includes(code);
  await Submission.updateOne(owned, {
    $set: finalFailure
      ? { 'teacherUpload.email.status': 'failed', 'teacherUpload.email.failedAt': new Date(), 'teacherUpload.email.lastErrorCode': code }
      : { 'teacherUpload.email.status': 'queued', 'teacherUpload.email.lastErrorCode': code,
        'teacherUpload.email.nextAttemptAt': new Date(now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]) },
    $unset: { 'teacherUpload.email.leaseUntil': 1 },
    ...(message?.issuedHash ? { $pull: { 'guest.recoveryAccess': { hash: message.issuedHash } } } : {}) });
  logger.warn({ event: 'teacher_upload_email_not_sent', code, attempts, final: finalFailure });
  return finalFailure ? 'failed' : 'retry';
}

/** One pass of the queue. Safe to run on several workers at once. */
/** An email waiting for marking that then failed is held, not left queued forever: there is no feedback to send. "Retry
 *  marking" puts it back in the queue, so it is sent once, when marking succeeds. */
async function holdForFailedMarking() {
  const result = await Submission.updateMany({ 'teacherUpload.email.status': 'queued', assessmentStatus: 'failed' },
    { $set: { 'teacherUpload.email.status': 'held' }, $unset: { 'teacherUpload.email.nextAttemptAt': 1 } });
  if (result.modifiedCount) logger.info({ event: 'teacher_upload_email_held', count: result.modifiedCount });
}

async function run({ batchSize = 25, now = new Date() } = {}) {
  await settleInterrupted(now);
  await holdForFailedMarking();
  const candidates = await Submission.find({ 'teacherUpload.email.status': 'queued', assessmentStatus: 'complete', ...due(now) })
    .sort({ 'teacherUpload.email.requestedAt': 1 }).limit(batchSize).select('_id').lean();
  const outcome = { sent: 0, retry: 0, failed: 0, deferred: 0, skipped: 0 };
  for (const candidate of candidates) {
    try { outcome[await sendOne(candidate, now)] += 1; }
    catch (error) { logger.error({ event: 'teacher_upload_email_worker_failed', name: error?.name }); }
  }
  return outcome;
}

module.exports = { run, reserveQuota, MAX_ATTEMPTS, BACKOFF_MS, RATE_LIMIT, RATE_WINDOW_MS, LEASE_MS };
