'use strict';
// HTTP layer for teacher uploads. Business rules and validation live in services/teacherUpload.service.js.
const service = require('../services/teacherUpload.service');
const logger = require('../utils/logger');

function sendError(req, res, error) {
  const known = Number.isInteger(error.statusCode) && error.statusCode < 500;
  // The handwriting check's own "try again later" answers (503) keep their safe message and code.
  const unavailable = error.statusCode === 503 && /^OCR_[A-Z0-9_]{1,90}$/.test(error.code || '');
  if (!known && !unavailable) logger.error({ event: 'teacher_upload_request_failed', route: req.route?.path, code: error.code, name: error.name });
  res.status(known || unavailable ? error.statusCode : 500).json({ success: false,
    message: known || unavailable ? error.message : 'Something went wrong. Please try again.',
    ...((known || unavailable) && error.code ? { code: error.code } : {}), ...(known && error.details ? { details: error.details } : {}) });
}

function endpoint(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      res.json({ success: true, data });
    } catch (error) { sendError(req, res, error); }
  };
}

/** Middleware: binds the handwriting check to this student (owner) and teacher (uploader); 404 for anyone but the owner. */
async function source(req, res, next) {
  try {
    req.teacherUploadSource = await service.sourceFor({ teacher: req.user, assignmentId: req.params.assignmentId, body: req.body });
    return next();
  } catch (error) {
    const files = [req.file, ...(Array.isArray(req.files) ? req.files : [])].filter(Boolean);
    await Promise.all(files.map(file => file.path ? require('fs/promises').unlink(file.path).catch(() => {}) : null));
    return sendError(req, res, error);
  }
}

module.exports = {
  list: endpoint(req => service.list({ teacher: req.user, assignmentId: req.params.assignmentId })),
  check: endpoint(req => service.check({ teacher: req.user, assignmentId: req.params.assignmentId, students: req.body?.students })),
  save: endpoint(req => service.save({ req, teacher: req.user, assignmentId: req.params.assignmentId })),
  send: endpoint(req => service.requestSend({ teacher: req.user, assignmentId: req.params.assignmentId, submissionId: req.params.submissionId })),
  retry: endpoint(req => service.retryMarking({ teacher: req.user, assignmentId: req.params.assignmentId, submissionId: req.params.submissionId })),
  source
};
