'use strict';
// Essay-only routes refuse speaking work explicitly (audio + speech-to-text, stage 5). A speaking submission (sourceKind 'audio') has no pages,
// OCR, corrections, annotations or essay feedback, and a speaking assignment has no essay rubric; letting essay code run on them would at
// best fail later and at worst write essay state onto them. The answer is the same 404 body as the switched-off feature routers, for
// everyone (owner or not): it reveals nothing about whether the id exists or what kind it is. Placed after sign-in, role and id validation
// and BEFORE any upload, so a refused request writes nothing. One indexed _id lookup with no fields loaded.
// tests/audioGuardInventory.test.js lists every route that takes a submission id and proves each one is guarded or deliberately allowed.
const NOT_FOUND = Object.freeze({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
const objectId = value => /^[a-f\d]{24}$/i.test(String(value || ''));

function refuse(res) { return res.status(404).json(NOT_FOUND); }

/** For routes with :submissionId. An id that is not an ObjectId is left to the route's own validation. */
function refuseAudioSubmission(req, res, next) {
  const id = req.params?.submissionId;
  if (!objectId(id)) return next();
  return require('../models/Submission').exists({ _id: id, sourceKind: 'audio' })
    .then(found => (found ? refuse(res) : next()), next);
}

/** For essay-only routes that take an assignment id (param name given). */
function refuseSpeakingAssignment(paramName = 'id') {
  return function refuseSpeakingAssignmentMiddleware(req, res, next) {
    const id = req.params?.[paramName];
    if (!objectId(id)) return next();
    return require('../models/assignment.model').exists({ _id: id, resourceType: 'speaking' })
      .then(found => (found ? refuse(res) : next()), next);
  };
}

/**
 * The essay image upload (POST /api/submissions/:assignmentId and /qr/:qrToken) for a speaking assignment: refused BEFORE the upload is read,
 * with a message the student can act on. (These routes already tell a student that an assignment exists: 404 vs 403 "Not class member".)
 */
function refuseSpeakingEssayUpload(by) {
  return function refuseSpeakingEssayUploadMiddleware(req, res, next) {
    const value = String(req.params?.[by === 'qrToken' ? 'qrToken' : 'assignmentId'] || '').trim();
    if (!value || (by !== 'qrToken' && !objectId(value))) return next();
    return require('../models/assignment.model').exists({ ...(by === 'qrToken' ? { qrToken: value } : { _id: value }), resourceType: 'speaking' })
      .then(found => (found ? res.status(409).json({ success: false, code: 'SPEAKING_NEEDS_RECORDING',
        message: 'This assignment needs a recording. Open it to record or upload your answer.' }) : next()), next);
  };
}

module.exports = { refuseAudioSubmission, refuseSpeakingAssignment, refuseSpeakingEssayUpload, NOT_FOUND };
