'use strict';
// Teacher evaluation edits (Phase B2): GET the edit panel's snapshot, POST one save. Only the teacher who owns the class and assignment;
// everyone else, students and guests included, gets 404 (the owner check is the annotation editor's). Feature off: 404 for everyone.
// Closed (archived) class: read-only (409 on writes). Saving never calls an AI provider and never charges credits.
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const User = require('../models/user.model');
const policy = require('../services/teacherEvaluation.service');
const { assessmentBusy } = require('../services/scoreReview.service');
const { authorized } = require('./teacherAnnotation.controller');
const logger = require('../utils/logger');

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const ANNOTATION_CODES = { ANNOTATION_NOT_FOUND: 'TEACHER_EVALUATION_NOT_FOUND', ANNOTATION_CLASS_CLOSED: 'TEACHER_EVALUATION_CLASS_CLOSED' };

const endpoint = fn => async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    if (!policy.enabled()) throw fail(404, 'TEACHER_EVALUATION_NOT_FOUND');
    await fn(req, res);
  } catch (error) {
    const code = ANNOTATION_CODES[error.message] || (/^TEACHER_EVALUATION_[A-Z_]+$/.test(error.message) ? error.message : 'TEACHER_EVALUATION_OPERATION_FAILED');
    if (!error.statusCode) logger.error({ event: 'teacher_evaluation_failed', submissionId: String(req.params.submissionId || ''), error: error.name });
    res.status(error.statusCode || 500).json({ success: false, code, message: code });
  }
};

const loadFeedback = submissionId => SubmissionFeedback.findOne({ submissionId }).select('+teacherEvaluation').lean();

/** Why the scores cannot be edited now, or null. The scores must be the current, finished evaluation of this draft. */
function blockedReason(doc, feedback, classClosed) {
  if (classClosed) return 'CLASS_CLOSED';
  if (!feedback) return 'NO_EVALUATION';
  if (policy.isCustomRubric(feedback)) return 'CUSTOM_RUBRIC';
  if (assessmentBusy(doc)) return 'ASSESSMENT_BUSY';
  if (feedback.evaluationStatus !== 'completed' || !feedback.evaluationSourceHash || feedback.evaluationSourceHash !== doc.correctionSourceHash) return 'EVALUATION_NOT_CURRENT';
  return null;
}
const snapshotOf = (doc, feedback, classClosed) => {
  const reason = blockedReason(doc, feedback, classClosed);
  return feedback ? policy.teacherSnapshot(feedback, doc, { editable: !reason, blockedReason: reason })
    : { enabled: true, editable: false, blockedReason: reason, revision: 0, criteria: [], history: [] };
};

const get = endpoint(async (req, res) => {
  const doc = await authorized(req);
  res.json({ success: true, data: snapshotOf(doc, await loadFeedback(doc._id), req.annotationClassClosed) });
});

const save = endpoint(async (req, res) => {
  const doc = await authorized(req, { write: true });
  policy.checkBody(req.body);
  const feedback = await loadFeedback(doc._id);
  const actor = await User.findById(req.user._id).select('displayName email').lean();
  const actorName = String(actor?.displayName || actor?.email || '').slice(0, 120);
  // A repeated request is answered with its first result before any state check (it may have been the change that made the state differ).
  if (feedback?.teacherEvaluation?.history?.some(row => row.requestId === req.body.requestId)) {
    const replay = policy.prepare(feedback, doc, req.user._id, actorName, req.body);
    return res.json({ success: true, data: { revision: replay.revision, replay: true, snapshot: snapshotOf(doc, feedback, false) } });
  }
  const reason = blockedReason(doc, feedback, false);
  if (reason === 'NO_EVALUATION' || reason === 'EVALUATION_NOT_CURRENT') throw fail(409, 'TEACHER_EVALUATION_NOT_CURRENT');
  if (reason === 'ASSESSMENT_BUSY') throw fail(409, 'TEACHER_EVALUATION_ASSESSMENT_BUSY');
  if (reason === 'CUSTOM_RUBRIC') throw fail(409, 'TEACHER_EVALUATION_CUSTOM_RUBRIC');
  const result = policy.prepare(feedback, doc, req.user._id, actorName, req.body);
  // Written only if nothing moved since it was read: the record's revision, the AI run, and the draft.
  const stillDraft = await Submission.exists({ _id: doc._id, draftNumber: doc.draftNumber ?? { $exists: false }, correctionSourceHash: doc.correctionSourceHash });
  if (!stillDraft) throw fail(409, 'TEACHER_EVALUATION_REVISION_CONFLICT');
  const match = { _id: feedback._id, evaluationJobId: feedback.evaluationJobId ?? { $exists: false }, evaluationSourceHash: feedback.evaluationSourceHash,
    'teacherEvaluation.revision': feedback.teacherEvaluation ? feedback.teacherEvaluation.revision : { $exists: false } };
  const saved = await SubmissionFeedback.updateOne(match, { $set: { teacherEvaluation: result.record } });
  if (saved.modifiedCount !== 1) throw fail(409, 'TEACHER_EVALUATION_REVISION_CONFLICT');
  res.json({ success: true, data: { revision: result.revision, snapshot: snapshotOf(doc, { ...feedback, teacherEvaluation: result.record }, false) } });
});

module.exports = { get, save, blockedReason };
