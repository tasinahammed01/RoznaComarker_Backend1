'use strict';
const portal = require('../services/recoveryPortal.service');
const logger = require('../utils/logger');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

/**
 * Where an unexpected failure happened, safe to log: the error's name, the first stack frame inside src/ as "src/...:line", and the
 * stage the list reached. Never the error message (a CastError message contains the stored value) and nothing personal.
 */
function failureTrace(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][\w]{0,59}$/.test(error.name) ? error.name : 'Error';
  let frame = 'unknown';
  for (const line of String(error?.stack || '').split('\n').slice(1)) {
    const match = /\(?([^()\s]+?):(\d+):\d+\)?\s*$/.exec(line.trim());
    const file = match && match[1].replace(/\\/g, '/');
    const at = file ? file.lastIndexOf('/src/') : -1;
    if (at >= 0 && !file.includes('/node_modules/')) { frame = `${file.slice(at + 1)}:${match[2]}`; break; }
  }
  return { errorName: name, frame, ...(['account_lookup', 'lookup', 'mapping'].includes(error?.stage) ? { stage: error.stage } : {}) };
}

function endpoint(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      // Never log request bodies, emails, tokens, sessions or error messages.
      const known = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
      logger.warn({ event: 'recovery_portal_request_failed', code: /^[A-Z_]{1,60}$/.test(error.code || '') ? error.code : 'RECOVERY_FAILED',
        ...(known ? {} : failureTrace(error)) });
      res.status(known ? error.statusCode : 503).json({ success: false,
        message: known ? error.message : 'Temporarily unavailable. Please retry.', code: known ? error.code : 'RECOVERY_UNAVAILABLE' });
    }
  };
}

// The answer is the same whether or not the address has submissions, and it is sent BEFORE any lookup or email work,
// so neither the body nor the response time tells an observer anything about the address.
const request = endpoint(async (req, res) => {
  const email = portal.normalizeEmail(req.body?.email);   // a malformed address is a 400 (format only, never existence)
  ok(res, require('../services/recoveryEmailQuota.service').publicAnswer(), 202);
  setImmediate(() => {
    portal.issueLink(email).catch(() => logger.warn({ event: 'recovery_link_issue_failed' }));
  });
});

const exchange = endpoint(async (req, res) => {
  const { session, expiresAt } = await portal.exchange(req.body?.token);
  ok(res, { session, expiresAt });
});

const assignments = endpoint(async (req, res) => {
  const { emailNormalized } = await portal.verifySession(req.get('X-Recovery-Session'));
  ok(res, { assignments: await portal.listAssignments(emailNormalized) });
});

const endSession = endpoint(async (req, res) => {
  await portal.endSession(req.get('X-Recovery-Session'));
  ok(res, { ended: true });
});

module.exports = { request, exchange, assignments, endSession };
