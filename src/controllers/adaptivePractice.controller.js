'use strict';

const service = require('../services/adaptivePractice.service');
const attemptService = require('../services/adaptivePracticeAttempt.service');

function send(res, status, data) {
  return res.status(status).json({ success: true, data });
}

function handleError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    success: false,
    code: error?.code || 'ADAPTIVE_PRACTICE_ERROR',
    message: status >= 500 ? 'Adaptive practice is temporarily unavailable.' : error.message
  });
}

async function getSession(req, res) {
  try {
    return send(res, 200, await service.getCurrentSession(req.params.submissionId, req.user._id));
  } catch (error) {
    return handleError(res, error);
  }
}

async function generateSession(req, res) {
  try {
    if (req.body?.regenerate === true) {
      return res.status(400).json({ success: false, code: 'REGENERATION_UNSUPPORTED', message: 'Regeneration is not supported yet.' });
    }
    const data = await service.generateSession(req.params.submissionId, req.user._id, { retry: req.body?.retry === true });
    return send(res, data.state === 'generating' ? 202 : 200, data);
  } catch (error) {
    return handleError(res, error);
  }
}

async function checkResponse(req, res) {
  try {
    const data = await attemptService.checkResponse(req.params.sessionId, req.params.activityId, req.user._id, req.body);
    return send(res, data.state === 'checking' ? 202 : 200, data);
  } catch (error) { return handleError(res, error); }
}

async function listAttempts(req, res) {
  try { return send(res, 200, await attemptService.listAttempts(req.params.sessionId, req.user._id, req.query.activityId)); }
  catch (error) { return handleError(res, error); }
}

module.exports = { getSession, generateSession, checkResponse, listAttempts };
