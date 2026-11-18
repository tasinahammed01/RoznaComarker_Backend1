'use strict';
const Submission = require('../models/Submission');
const access = require('./guestAccess.service');
const logger = require('../utils/logger');

// Completed submissions are the durable work queue. A result-email token is
// independent of the original confirmation token, so delivery never invalidates
// the student's original return link. Both remain revocable and email recovery
// rotates both capabilities. Only hashes are persisted.
// Teacher uploads are never emailed here: their students are emailed only when the teacher chose "Save and send".
// A guest's recording (sourceKind 'audio', stage 10): its speaking assignment, its speaking page and the speaking wording.
const NOT_TEACHER_UPLOAD = { 'teacherUpload.uploadedBy': { $exists: false } };
async function run({ batchSize = 10 } = {}) {
  if (!require('../config/guestSubmission').guestSubmissionEnabled()) return;
  const now = new Date();
  const candidates = await Submission.find({ submissionMode: 'guest', assessmentStatus: 'complete', ...NOT_TEACHER_UPLOAD,
    'guest.revokedAt': null, 'guest.resultEmailSentAt': null,
    $and: [
      { $or: [{ 'guest.resultEmailLeaseUntil': null }, { 'guest.resultEmailLeaseUntil': { $lte: now } }] },
      { $or: [{ 'guest.resultEmailNextAttemptAt': null }, { 'guest.resultEmailNextAttemptAt': { $lte: now } }] }
    ] }).select('_id qrToken draftNumber sourceKind').limit(batchSize).lean();
  for (const candidate of candidates) {
    try {
      const speaking = candidate.sourceKind === 'audio';
      const { assignment } = speaking ? await require('./audio/speakingGuest.service').assignmentFor(candidate.qrToken)
        : await require('../controllers/guestSubmission.controller').assignmentFor(candidate.qrToken);
      const issued = access.issueToken();
      const link = speaking ? access.speakingReturnUrl(candidate._id, issued.token) : access.returnUrl(candidate._id, issued.token);
      const doc = await Submission.findOneAndUpdate({ _id: candidate._id, assessmentStatus: 'complete', draftNumber: candidate.draftNumber, ...NOT_TEACHER_UPLOAD, 'guest.revokedAt': null,
        'guest.resultEmailSentAt': null, $or: [{ 'guest.resultEmailLeaseUntil': null }, { 'guest.resultEmailLeaseUntil': { $lte: now } }] },
      { $set: { 'guest.resultEmailLeaseUntil': new Date(Date.now() + 5 * 60 * 1000),
        'guest.resultAccessHash': issued.accessHash, 'guest.resultExpiresAt': issued.expiresAt } }, { returnDocument: 'after' })
        .select('+guest.normalizedEmail');
      if (!doc) continue;
      const delivery = await require('./email.service').sendGuestSubmissionEmail({ to: doc.guest.normalizedEmail,
        assignmentTitle: assignment.title, returnUrl: link, resultReady: true, ...(speaking ? { kind: 'speaking' } : {}) });
      await Submission.updateOne({ _id: doc._id, assessmentStatus: 'complete', draftNumber: doc.draftNumber, 'guest.resultAccessHash': issued.accessHash }, {
        $set: delivery.success ? { 'guest.resultEmailSentAt': new Date() }
          : { 'guest.resultEmailNextAttemptAt': new Date(Date.now() + 15 * 60 * 1000) },
        $unset: { 'guest.resultEmailLeaseUntil': 1 }
      });
    } catch {
      await Submission.updateOne({ _id: candidate._id }, { $set: { 'guest.resultEmailNextAttemptAt': new Date(Date.now() + 15 * 60 * 1000) } }).catch(() => {});
      logger.warn({ event: 'guest_result_email_deferred' });
    }
  }
}
module.exports = { run };
