'use strict';
const service = require('../services/teacherRecovery.service');
const logger = require('../utils/logger');

function endpoint(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) {
      const known = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 && error.code;
      if (!known) logger.warn({ event: 'teacher_recovery_failed' });   // never the email, link or token
      res.status(known ? error.statusCode : 503).json({ success: false, code: known ? error.code : 'RECOVERY_UNAVAILABLE',
        message: known ? error.message : 'Temporarily unavailable. Please retry.',
        ...(known && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        ...(known && error.emailMasked ? { emailMasked: error.emailMasked } : {}) });
    }
  };
}

const status = endpoint(req => service.status(req.user._id, req.params.submissionId));

// The recipient is always the address stored on the submission: the request takes no input at all, so the platform can never be
// pointed at another address.
const send = endpoint(req => {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    throw Object.assign(new Error('This action takes no input. The link always goes to the email stored on the submission.'),
      { statusCode: 400, code: 'NO_INPUT_ACCEPTED' });
  }
  return service.sendLink(req.user._id, req.params.submissionId);
});

module.exports = { status, send };
