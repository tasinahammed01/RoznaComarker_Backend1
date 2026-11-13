'use strict';
// Improved Writing Model API, one model per submission (IMPROVED_WRITING_MODEL_ENABLED; off = 404 everywhere).
//   Teacher (owner of the submission's assignment and its class only; everyone else, students and guests included, gets 404):
//     GET  /api/submissions/:submissionId/writing-model/teacher                 the panel
//     PUT  /api/submissions/:submissionId/writing-model/teacher                 { action: 'save' | 'submit', text, releaseRule }
//     POST /api/submissions/:submissionId/writing-model/teacher/generate-draft  AI draft from THIS student's writing, 1 credit, explicit only
//   Student: GET /api/submissions/:submissionId/writing-model (their own submission only).
//   Guest:   GET /api/guest/submissions/:submissionId/writing-model (the submission their link opens only).
// Students and guests are identified by their own submission, never by assignment, and get only the submitted text.
// The old assignment-wide model (Assignment.writingModel) is kept but served to no student; its teacher sees it read-only in the panel.
const mongoose = require('mongoose');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const SubmissionWritingModel = require('../models/SubmissionWritingModel');
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

/** The teacher's own submission (its essay assignment and class are theirs and active), with its model; else 404. */
async function owned(req, { write = false } = {}) {
  if (req.user?.role !== 'teacher' || req.guestAccessContext || !mongoose.isValidObjectId(req.params.submissionId)) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const submission = await Submission.findById(req.params.submissionId).lean();
  if (!submission) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const assignment = await Assignment.findOne({ _id: submission.assignment, teacher: req.user._id, isActive: true })
    .select('+writingModel title instructions writingType rubric rubrics resourceType class teacher').lean();
  if (!assignment || (assignment.resourceType && assignment.resourceType !== 'essay')) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const classDoc = await Class.findOne({ _id: assignment.class, teacher: req.user._id, isActive: true }).select('status institutionId').lean();
  if (!classDoc) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const readOnly = classDoc.status === 'archived';
  if (write && readOnly) throw fail(409, 'WRITING_MODEL_CLASS_CLOSED');
  const stored = await SubmissionWritingModel.findOne({ submission: submission._id }).lean();
  return { submission, assignment, stored, readOnly, aiAvailable: !classDoc.institutionId, transcript: policy.transcriptOf(submission) };
}

const snapshotFor = (context, model) => policy.teacherSnapshot(model, { submission: context.submission, transcriptHash: context.transcript.hash,
  readOnly: context.readOnly, aiAvailable: context.aiAvailable, legacy: context.assignment.writingModel });

/** Writes the model only if nobody saved in between (optimistic on the stored revision); the first write creates it. */
async function persist({ submission, assignment, stored }, model) {
  const fields = { draftText: model.draftText, source: model.source, releaseRule: model.releaseRule, basedOnTranscriptHash: model.basedOnTranscriptHash,
    published: model.published, revision: model.revision, updatedBy: model.updatedBy, requests: model.requests, generations: model.generations };
  if (!stored) {
    try { await SubmissionWritingModel.create({ submission: submission._id, assignment: assignment._id, teacher: assignment.teacher, ...fields }); }
    catch (error) { if (error?.code === 11000) throw fail(409, 'WRITING_MODEL_REVISION_CONFLICT'); throw error; }
    return;
  }
  const saved = await SubmissionWritingModel.updateOne({ _id: stored._id, revision: stored.revision }, { $set: fields });
  if (saved.modifiedCount !== 1) throw fail(409, 'WRITING_MODEL_REVISION_CONFLICT');
}
/** Puts the model back as it was (an AI draft that could not be charged). */
async function restore({ submission, stored }, model) {
  if (!stored) return SubmissionWritingModel.deleteOne({ submission: submission._id, revision: model.revision });
  const { _id, createdAt, updatedAt, ...previous } = stored;
  return SubmissionWritingModel.updateOne({ _id, revision: model.revision }, { $set: previous });
}

const get = endpoint(async (req, res) => {
  const context = await owned(req);
  res.json({ success: true, data: snapshotFor(context, context.stored) });
});

const save = endpoint(async (req, res) => {
  const context = await owned(req, { write: true });
  const { model, replay } = policy.prepareSave(context.stored, req.body, req.user._id, { transcriptHash: context.transcript.hash });
  if (!replay) await persist(context, model);
  logger.info({ event: 'writing_model_saved', action: req.body?.action, replay, submissionId: String(context.submission._id) });
  res.json({ success: true, data: { ...(replay ? { replay: true } : {}), snapshot: snapshotFor(context, model) } });
});

const generateDraft = endpoint(async (req, res) => {
  const context = await owned(req, { write: true });
  const { submission, assignment, stored } = context;
  const credits = require('../services/credit.service');
  const check = policy.checkGenerate(stored, req.body);
  if (check.replay) {
    // The same request again: no new draft. The debit is idempotent on the request id (covers a crash between save and charge).
    await credits.consumeWritingModelCredit({ userId: req.user._id, assignmentId: assignment._id, requestId: req.body.requestId });
    return res.json({ success: true, data: { replay: true, snapshot: snapshotFor(context, stored) } });
  }
  // Institution-funded classes have their own credit pool and ledger; this feature does not charge it yet.
  if (!context.aiAvailable) throw fail(409, 'WRITING_MODEL_AI_INSTITUTION_UNSUPPORTED');
  if (!context.transcript.text) throw fail(409, 'WRITING_MODEL_NO_TRANSCRIPT');
  const wallet = await credits.canRunAssessment(req.user._id);
  if (!wallet.allowed) throw fail(403, 'INSUFFICIENT_ASSESSMENT_CREDITS');
  const feedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).select('rubricScores detailedFeedback').lean();
  let text;
  try { text = await policy.generateDraft({ assignment, submission, transcript: context.transcript.text, feedback }); } catch (error) {
    logger.warn({ event: 'writing_model_generation_failed', code: error?.code || error?.name });
    throw fail(502, 'WRITING_MODEL_AI_FAILED');   // nothing saved, nothing charged
  }
  const model = policy.withGeneratedDraft(stored, text, req.body.requestId, req.user._id, { transcriptHash: context.transcript.hash });
  await persist(context, model);
  try {
    await credits.consumeWritingModelCredit({ userId: req.user._id, assignmentId: assignment._id, requestId: req.body.requestId });
  } catch (error) {
    // Not charged (the balance ran out meanwhile): the draft is taken back, so nothing is kept that was not paid for.
    await restore(context, model);
    throw error.code === 'INSUFFICIENT_ASSESSMENT_CREDITS' ? fail(403, 'INSUFFICIENT_ASSESSMENT_CREDITS') : error;
  }
  res.json({ success: true, data: { charged: true, snapshot: snapshotFor(context, model) } });
});

/** Student or guest: the submitted text of the model for THIS submission (looked up by the submission's own id only). */
async function studentResult(submission) {
  if (!submission?._id) return { available: false };
  const model = await SubmissionWritingModel.findOne({ submission: submission._id }).select('published').lean();
  return policy.studentView(model, submission);
}
const forStudent = endpoint(async (req, res) => {
  if (req.user?.role !== 'student' || !mongoose.isValidObjectId(req.params.submissionId)) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  const submission = await Submission.findOne({ _id: req.params.submissionId, student: req.user._id }).select('_id draftNumber').lean();
  if (!submission) throw fail(404, 'WRITING_MODEL_NOT_FOUND');
  res.json({ success: true, data: await studentResult(submission) });
});
const forGuest = endpoint(async (req, res) => {
  // requireGuestAccess has already bound req.guestSubmission to the submission this guest's own link opens.
  res.json({ success: true, data: await studentResult(req.guestSubmission) });
});

module.exports = { get, save, generateDraft, forStudent, forGuest };
