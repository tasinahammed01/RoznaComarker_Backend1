'use strict';
// Improved Writing Model API (IMPROVED_WRITING_MODEL_ENABLED; off = 404 everywhere).
//   Teacher (owner of the assignment and its class only; everyone else, students and guests included, gets 404):
//     GET  /api/assignments/:id/writing-model                 the panel
//     PUT  /api/assignments/:id/writing-model                 save text, approval, release rule, manual release
//     POST /api/assignments/:id/writing-model/generate-draft  AI draft, 1 credit, explicit only
//   Student: GET /api/submissions/:submissionId/writing-model (own submission). Guest: GET /api/guest/submissions/:id/writing-model.
// Closed (archived) class: read-only. No student data ever reaches the AI; students never see a draft.
const mongoose = require('mongoose');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const policy = require('../services/writingModel.service');
const logger = require('../utils/logger');

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const endpoint = fn => async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    if (!policy.enabled()) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
    await fn(req, res);
  } catch (error) {
    const code = /^(WRITING_MODEL_[A-Z_]+|INSUFFICIENT_ASSESSMENT_CREDITS)$/.test(error.code || error.message) ? (error.code || error.message) : 'WRITING_MODEL_OPERATION_FAILED';
    if (!error.statusCode) logger.error({ event: 'writing_model_failed', error: error.name });
    res.status(error.statusCode || 500).json({ success: false, code, message: code });
  }
};

/** The teacher's own active essay assignment in their own active class, with its model; else 404. */
async function owned(req, { write = false } = {}) {
  if (req.user?.role !== 'teacher' || req.guestAccessContext || !mongoose.isValidObjectId(req.params.id)) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const assignment = await Assignment.findOne({ _id: req.params.id, teacher: req.user._id, isActive: true })
    .select('+writingModel title instructions writingType rubric rubrics resourceType class teacher').lean();
  if (!assignment || (assignment.resourceType && assignment.resourceType !== 'essay')) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const classDoc = await Class.findOne({ _id: assignment.class, teacher: req.user._id, isActive: true }).select('status institutionId').lean();
  if (!classDoc) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const readOnly = classDoc.status === 'archived';
  if (write && readOnly) throw fail(409, 'WRITING_MODEL_CLASS_CLOSED');
  return { assignment, classDoc, readOnly, aiAvailable: !classDoc.institutionId };
}

/** Writes the model only if nobody saved in between (optimistic on the stored revision). */
async function persist(assignment, model) {
  const stored = assignment.writingModel;
  const match = { _id: assignment._id, 'writingModel.revision': stored ? stored.revision : { $exists: false } };
  const saved = await Assignment.updateOne(match, { $set: { writingModel: model } });
  if (saved.modifiedCount !== 1) throw fail(409, 'WRITING_MODEL_REVISION_CONFLICT');
}

const get = endpoint(async (req, res) => {
  const { assignment, readOnly, aiAvailable } = await owned(req);
  res.json({ success: true, data: policy.teacherSnapshot(assignment.writingModel, { readOnly, aiAvailable }) });
});

const save = endpoint(async (req, res) => {
  const { assignment, aiAvailable } = await owned(req, { write: true });
  const { model, replay } = policy.prepareSave(assignment.writingModel, req.body, req.user._id);
  if (!replay) await persist(assignment, model);
  res.json({ success: true, data: { ...(replay ? { replay: true } : {}), snapshot: policy.teacherSnapshot(model, { aiAvailable }) } });
});

const generateDraft = endpoint(async (req, res) => {
  const { assignment, aiAvailable } = await owned(req, { write: true });
  const credits = require('../services/credit.service');
  const check = policy.checkGenerate(assignment.writingModel, req.body);
  if (check.replay) {
    // The same request again: no new draft. The debit is idempotent on the request id (covers a crash between save and charge).
    await credits.consumeWritingModelCredit({ userId: req.user._id, assignmentId: assignment._id, requestId: req.body.requestId });
    return res.json({ success: true, data: { replay: true, snapshot: policy.teacherSnapshot(assignment.writingModel, { aiAvailable }) } });
  }
  // Institution-funded classes have their own credit pool and ledger; this feature does not charge it yet.
  if (!aiAvailable) throw fail(409, 'WRITING_MODEL_AI_INSTITUTION_UNSUPPORTED');
  const wallet = await credits.canRunAssessment(req.user._id);
  if (!wallet.allowed) throw fail(403, 'INSUFFICIENT_ASSESSMENT_CREDITS');
  let text;
  try { text = await policy.generateDraft(assignment); } catch (error) {
    logger.warn({ event: 'writing_model_generation_failed', code: error?.code || error?.name });
    throw fail(502, 'WRITING_MODEL_AI_FAILED');   // nothing saved, nothing charged
  }
  const model = policy.withGeneratedDraft(assignment.writingModel, text, req.body.requestId, req.user._id);
  await persist(assignment, model);
  try {
    await credits.consumeWritingModelCredit({ userId: req.user._id, assignmentId: assignment._id, requestId: req.body.requestId });
  } catch (error) {
    // Not charged (the balance ran out meanwhile): the draft is taken back, so nothing is kept that was not paid for.
    await Assignment.updateOne({ _id: assignment._id, 'writingModel.revision': model.revision },
      assignment.writingModel ? { $set: { writingModel: assignment.writingModel } } : { $unset: { writingModel: 1 } });
    throw error.code === 'INSUFFICIENT_ASSESSMENT_CREDITS' ? fail(403, 'INSUFFICIENT_ASSESSMENT_CREDITS') : error;
  }
  res.json({ success: true, data: { charged: true, snapshot: policy.teacherSnapshot(model, { aiAvailable }) } });
});

/** Student or guest: the approved, released text for their own submission's assignment, or { available: false }. */
async function studentResult(submission) {
  const assignment = submission && await Assignment.findOne({ _id: submission.assignment, isActive: true }).select('+writingModel').lean();
  return assignment ? policy.studentView(assignment.writingModel, submission) : { available: false };
}
const forStudent = endpoint(async (req, res) => {
  if (req.user?.role !== 'student' || !mongoose.isValidObjectId(req.params.submissionId)) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const submission = await Submission.findOne({ _id: req.params.submissionId, student: req.user._id }).select('assignment draftNumber').lean();
  if (!submission) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  res.json({ success: true, data: await studentResult(submission) });
});
const forGuest = endpoint(async (req, res) => {
  res.json({ success: true, data: await studentResult(req.guestSubmission) });
});

module.exports = { get, save, generateDraft, forStudent, forGuest };
