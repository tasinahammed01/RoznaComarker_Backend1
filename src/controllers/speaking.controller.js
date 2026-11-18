'use strict';
// /api/speaking handlers (routes/speaking.routes.js). Thin: the rules live in services/audio/speakingSubmission.service.js.
const service = require('../services/audio/speakingSubmission.service');
const { effectiveMaxRecordingSeconds } = require('../services/audio/speakingAssignment');
const { readLimits } = require('../services/audio/policy');
const logger = require('../utils/logger');

function respondError(res, error, event) {
  if (error instanceof service.SpeakingError) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
  logger.error({ event, errorName: String(error?.name || 'Error').slice(0, 60), errorCode: typeof error?.code === 'string' ? error.code.slice(0, 60) : null });
  return res.status(500).json({ success: false, code: 'SPEAKING_FAILED', message: 'Something went wrong. Please try again.' });
}

/** Before the file is read. A repeated request answers with its stored result straight away. */
async function prepare(req, res, next) {
  try {
    const context = await service.prepareStudentUpload({ user: req.user, assignmentId: req.params.assignmentId, requestId: req.get('Idempotency-Key') });
    if (context.replay) {
      const submission = context.replay;
      const recording = await service.loadRecording(submission.audioRecording);
      return res.status(200).json({ success: true, data: service.studentView({ submission, recording, assignment: context.assignment,
        marked: await service.isMarked(submission) }) });
    }
    req.speakingContext = context;
    return next();
  } catch (error) { return respondError(res, error, 'speaking_upload_prepare_failed'); }
}

/** The assignment's own maximum for the upload checks (never above the policy). */
const maxDurationFor = req => (req.speakingContext ? effectiveMaxRecordingSeconds(req.speakingContext.assignment, readLimits().limits) : undefined);

/** After the upload checks. */
async function commit(req, res) {
  try {
    const result = await service.commitStudentUpload({ user: req.user, context: req.speakingContext, upload: req.audioUpload });
    return res.status(result.created ? 201 : 200).json({ success: true, data: service.studentView({ submission: result.submission, recording: result.recording,
      assignment: req.speakingContext.assignment }) });
  } catch (error) { return respondError(res, error, 'speaking_upload_failed'); }
}

async function myStatus(req, res) {
  try { return res.json({ success: true, data: await service.studentStatus({ user: req.user, assignmentId: req.params.assignmentId }) }); }
  catch (error) { return respondError(res, error, 'speaking_status_failed'); }
}

const requeueHeldEmail = id => require('../services/audio/speakingTeacherUpload.service').requeueHeldEmail(id);

async function retry(req, res) {
  try {
    const data = await service.retryTranscription({ user: req.user, submissionId: req.params.submissionId });
    // A teacher upload whose email was held (no result yet) is queued again: sent once, when the new marking succeeds (stage 9).
    await requeueHeldEmail(req.params.submissionId);
    return res.json({ success: true, data });
  }
  catch (error) { return respondError(res, error, 'speaking_retry_failed'); }
}

/** The owning teacher's view of one speaking submission; 404 for anyone else. */
async function teacherView(req, res) {
  try {
    const context = await service.accessFor(req.params.submissionId, req.user);
    if (!context || context.role !== 'teacher') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    return res.json({ success: true, data: service.teacherView({ ...context, studentName: await service.studentNameFor(context.submission) }) });
  } catch (error) { return respondError(res, error, 'speaking_teacher_view_failed'); }
}

/** The result (stage 6): the owning student or teacher; 404 for anyone else. */
async function result(req, res) {
  try {
    const context = await service.accessFor(req.params.submissionId, req.user);
    if (!context) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    return res.json({ success: true, data: await require('../services/audio/speakingResult.service').readResult(context) });
  } catch (error) { return respondError(res, error, 'speaking_result_failed'); }
}

/** The owning teacher queues a failed or blocked assessment again; 404 for anyone else. */
async function retryAssessment(req, res) {
  try {
    const context = await service.accessFor(req.params.submissionId, req.user);
    if (!context || context.role !== 'teacher') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    await require('../services/audio/speakingAssessment.service').retryAssessment({ context });
    await requeueHeldEmail(req.params.submissionId);
    return res.json({ success: true, data: await require('../services/audio/speakingResult.service').readResult(context) });
  } catch (error) {
    if (error?.statusCode && error.code) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return respondError(res, error, 'speaking_retry_assessment_failed');
  }
}

module.exports = { prepare, commit, maxDurationFor, myStatus, retry, teacherView, result, retryAssessment };
