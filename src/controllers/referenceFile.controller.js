'use strict';
// HTTP layer for AI knowledge and reference files. All logic and every response shape live in services/referenceFiles/referenceFile.service.js.
const service = require('../services/referenceFiles/referenceFile.service');
const logger = require('../utils/logger');

function sendError(res, error) {
  const status = Number(error?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    logger.error({ message: 'Reference file request failed', code: 'REFERENCE_FILE_INTERNAL', errorName: error?.name });
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
  }
  return res.status(status).json({ success: false, code: error.code || 'ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) });
}
/** Loads the owned class or assignment before the upload is parsed, so a file for someone else's class is never read. */
const loadScope = scope => async (req, res, next) => {
  try { req.referenceTarget = await service.ownedScope(req.user._id, scope, req.params.id); return next(); }
  catch (error) { return sendError(res, error); }
};

const run = fn => async (req, res) => {
  try { const { status = 200, data } = await fn(req); return res.status(status).json({ success: true, data }); }
  catch (error) { return sendError(res, error); }
};

module.exports = {
  sendError,
  loadScope,
  list: run(async req => ({ data: await service.listReferenceFiles(req.referenceTarget) })),
  upload: run(async req => {
    const data = await service.uploadReferenceFile({ teacher: req.user, target: req.referenceTarget, file: req.file,
      requestId: req.body?.requestId, markedAsRubric: ['true', true, '1'].includes(req.body?.markedAsRubric) });
    return { status: data.duplicate ? 200 : 201, data };
  }),
  get: run(async req => ({ data: await service.getReferenceFile(req.user._id, req.params.fileId) })),
  remove: run(async req => ({ data: await service.removeReferenceFile(req.user._id, req.params.fileId) })),
  draftRubric: run(async req => ({ data: await service.draftRubric(req.user._id, req.params.fileId) })),
  applyRubric: run(async req => ({ data: await service.applyRubric({ teacherId: req.user._id, id: req.params.fileId,
    rubricDesigner: req.body?.rubricDesigner, replace: req.body?.replace, req }) }))
};
