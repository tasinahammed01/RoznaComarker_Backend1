'use strict';
// HTTP layer for teacher-uploaded recordings (stage 9). Rules live in services/audio/speakingTeacherUpload.service.js. Errors keep the essay
// teacher-upload shape ({ success: false, message, code, details? }); anything unexpected is a generic 500 and is logged by name and code only.
const service = require('../services/audio/speakingTeacherUpload.service');
const { effectiveMaxRecordingSeconds } = require('../services/audio/speakingAssignment');
const { readLimits } = require('../services/audio/policy');
const logger = require('../utils/logger');

function sendError(req, res, error) {
  const known = Number.isInteger(error?.statusCode) && error.statusCode < 500;
  if (!known) logger.error({ event: 'speaking_teacher_upload_request_failed', route: req.route?.path, code: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
    name: String(error?.name || 'Error').slice(0, 60) });
  res.status(known ? error.statusCode : 500).json({ success: false, message: known ? error.message : 'Something went wrong. Please try again.',
    ...(known && error.code ? { code: error.code } : {}), ...(known && error.details ? { details: error.details } : {}) });
}

function endpoint(fn) {
  return async (req, res) => {
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) { sendError(req, res, error); }
  };
}

/** Before the file is read: 404 unless this teacher owns the speaking assignment; the fixed 429 when their minutes are used up. */
async function prepare(req, res, next) {
  try {
    req.speakingTeacherContext = await service.prepare({ teacher: req.user, assignmentId: req.params.assignmentId });
    return next();
  } catch (error) { return sendError(req, res, error); }
}

/** The assignment's own maximum length for the upload checks (never above the policy), as for students. */
const maxDurationFor = req => (req.speakingTeacherContext ? effectiveMaxRecordingSeconds(req.speakingTeacherContext.assignment, readLimits().limits) : undefined);

module.exports = {
  prepare,
  maxDurationFor,
  list: endpoint(req => service.list({ teacher: req.user, assignmentId: req.params.assignmentId })),
  check: endpoint(req => service.check({ teacher: req.user, assignmentId: req.params.assignmentId, students: req.body?.students })),
  save: endpoint(req => service.save({ req, teacher: req.user, ctx: req.speakingTeacherContext })),
  send: endpoint(req => service.requestSend({ teacher: req.user, assignmentId: req.params.assignmentId, submissionId: req.params.submissionId,
    resend: req.body?.resend === true, requestId: typeof req.body?.requestId === 'string' ? req.body.requestId : null })),
  retry: endpoint(req => service.retry({ teacher: req.user, assignmentId: req.params.assignmentId, submissionId: req.params.submissionId }))
};
