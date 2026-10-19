'use strict';
// These capabilities are created only after dedicated guest token authorization.
// They are never deserialized from a request or accepted by Firebase middleware.
const guests = new WeakSet();
function guestContext(submission) {
  if (submission?.submissionMode !== 'guest' || !submission._id) throw new Error('Invalid guest context');
  const context = Object.freeze({ submissionId: String(submission._id) });
  guests.add(context);
  return context;
}
function isGuest(actor) { return !!actor && typeof actor === 'object' && guests.has(actor); }
function ownsSubmission(submission, actor) {
  return isGuest(actor) ? submission.submissionMode === 'guest' && String(submission._id) === actor.submissionId
    : !!actor && !!submission.student && String(submission.student) === String(actor);
}
function ownerFields(actor) {
  return isGuest(actor) ? { guestSubmissionId: actor.submissionId } : { studentId: actor };
}
function ownsSession(session, actor) {
  return isGuest(actor) ? String(session.submissionId) === actor.submissionId
    && String(session.guestSubmissionId) === actor.submissionId && !session.studentId
    : !!actor && !!session.studentId && String(session.studentId) === String(actor);
}
function sessionOwnerFields(session) {
  return session.guestSubmissionId ? { guestSubmissionId: session.guestSubmissionId } : { studentId: session.studentId };
}
module.exports = { guestContext, isGuest, ownsSubmission, ownerFields, ownsSession, sessionOwnerFields };
