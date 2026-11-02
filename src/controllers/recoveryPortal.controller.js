'use strict';
const portal = require('../services/recoveryPortal.service');
const logger = require('../utils/logger');

const GENERIC_SENT = 'If we find submissions for this email address, we will send a link to see all of them. Check your inbox in a few minutes.';
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

function endpoint(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      // Never log request bodies, emails, tokens or sessions.
      logger.warn({ event: 'recovery_portal_request_failed', code: /^[A-Z_]{1,60}$/.test(error.code || '') ? error.code : 'RECOVERY_FAILED' });
      const known = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
      res.status(known ? error.statusCode : 503).json({ success: false,
        message: known ? error.message : 'Temporarily unavailable. Please retry.', code: known ? error.code : 'RECOVERY_UNAVAILABLE' });
    }
  };
}

// The answer is the same whether or not the address has submissions, and it is sent BEFORE any lookup or email work,
// so neither the body nor the response time tells an observer anything about the address.
const request = endpoint(async (req, res) => {
  const email = portal.normalizeEmail(req.body?.email);   // a malformed address is a 400 (format only, never existence)
  ok(res, { message: GENERIC_SENT }, 202);
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

module.exports = { request, exchange, assignments, endSession, GENERIC_SENT };
