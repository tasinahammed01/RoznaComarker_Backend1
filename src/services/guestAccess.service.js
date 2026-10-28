'use strict';
const crypto = require('crypto');
const Submission = require('../models/Submission');
const logger = require('../utils/logger');

function fail(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function identity(body) {
  const displayName = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/gu, ' ') : '';
  const normalizedEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!displayName || displayName.length > 120 || !/[\p{L}\p{N}]/u.test(displayName)
      || /[\u0000-\u001f\u007f]/u.test(displayName)) throw fail(400, 'Enter a name of up to 120 characters.');
  const local = normalizedEmail.split('@')[0];
  if (normalizedEmail.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
      || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(normalizedEmail)) {
    throw fail(400, 'Enter a valid email address.');
  }
  return { displayName, normalizedEmail };
}
function issueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  const configured = Number(process.env.GUEST_ACCESS_DAYS);
  const days = Number.isFinite(configured) && configured >= 1 && configured <= 365 ? configured : 30;
  return { token, accessHash: hash(token), expiresAt: new Date(Date.now() + days * 86400000) };
}
function returnUrl(submissionId, token) {
  const base = new URL(process.env.FRONTEND_URL || 'http://localhost:4200');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
      || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) throw fail(503, 'Return links are temporarily unavailable.');
  // Fragments are never sent to HTTP servers or in Referrer headers.
  return new URL(`/guest/results/${submissionId}#${token}`, base).href;
}
async function authorize(submissionId, token) {
  if (!/^[a-f\d]{24}$/i.test(String(submissionId || '')) || !/^[\w-]{43}$/.test(String(token || ''))) {
    logger.warn({ event: 'guest_link_rejected', tokenPresent: Boolean(token), tokenLength: String(token || '').length,
      headerPresent: token != null, validShape: false });
    throw fail(410, 'This link is invalid or has expired. Request a new link from your assignment page.', 'GUEST_LINK_EXPIRED');
  }
  const doc = await Submission.findOne({ _id: submissionId, submissionMode: 'guest',
    $or: [{ 'guest.accessHash': hash(token), 'guest.expiresAt': { $gt: new Date() } },
      { 'guest.resultAccessHash': hash(token), 'guest.resultExpiresAt': { $gt: new Date() } }], 'guest.revokedAt': null });
  if (!doc) {
    // Diagnostics never authorize access and never include identifiers, tokens or hashes.
    try {
      const candidate = await Submission.findById(submissionId).select('submissionMode guest.expiresAt guest.revokedAt +guest.accessHash').lean();
      logger.warn({ event: 'guest_link_rejected', tokenPresent: true, tokenLength: token.length, headerPresent: true,
        submissionIdMatches: Boolean(candidate), submissionMode: candidate?.submissionMode === 'guest' ? 'guest' : candidate ? 'registered' : 'missing',
        storedHashPresent: Boolean(candidate?.guest?.accessHash), computedHashMatches: candidate?.guest?.accessHash === hash(token),
        tokenExpired: !candidate?.guest?.expiresAt || new Date(candidate.guest.expiresAt) <= new Date(),
        tokenRevoked: Boolean(candidate?.guest?.revokedAt) });
    } catch { logger.warn({ event: 'guest_link_rejected', diagnosticUnavailable: true }); }
    throw fail(410, 'This link is invalid or has expired. Request a new link from your assignment page.', 'GUEST_LINK_EXPIRED');
  }
  return doc;
}
async function requireGuestAccess(req, res, next) {
  try {
    req.guestSubmission = await authorize(req.params.submissionId, req.get('X-Guest-Token'));
    const assignment = await require('../models/assignment.model').findOne({ _id: req.guestSubmission.assignment, isActive: true, allowGuestSubmission: true });
    if (!assignment) throw fail(404, 'Results unavailable.');
    const classDoc = await require('../models/class.model').findOne(
      require('./classLifecycle.service').withActiveStatus({ _id: assignment.class, teacher: assignment.teacher, isActive: true }));
    if (!classDoc) throw fail(404, 'Results unavailable.');
    req.guestAssignment = assignment;
    req.guestClass = classDoc;
    req.guestAccessContext = require('./submissionAccessContext.service').guestContext(req.guestSubmission);
    next();
  } catch (error) { res.status(error.statusCode || 503).json({ success: false,
    message: error.statusCode ? error.message : 'Results are temporarily unavailable.', code: error.code }); }
}
module.exports = { fail, hash, identity, issueToken, returnUrl, authorize, requireGuestAccess };
