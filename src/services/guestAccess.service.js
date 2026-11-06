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
// A link into the frontend: http(s) only, no credentials in the URL, https in production.
function frontendLink(pathAndFragment) {
  const base = new URL(process.env.FRONTEND_URL || 'http://localhost:4200');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
      || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) throw fail(503, 'Return links are temporarily unavailable.');
  return new URL(pathAndFragment, base).href;
}
function returnUrl(submissionId, token) {
  // Fragments are never sent to HTTP servers or in Referrer headers.
  return frontendLink(`/guest/results/${submissionId}#${token}`);
}
async function authorize(submissionId, token) {
  if (!/^[a-f\d]{24}$/i.test(String(submissionId || '')) || !/^[\w-]{43}$/.test(String(token || ''))) {
    logger.warn({ event: 'guest_link_rejected', tokenPresent: Boolean(token), tokenLength: String(token || '').length,
      headerPresent: token != null, validShape: false });
    throw fail(410, 'This link is invalid or has expired. Request a new link from your assignment page.', 'GUEST_LINK_EXPIRED');
  }
  const doc = await Submission.findOne({ _id: submissionId, submissionMode: 'guest',
    $or: [{ 'guest.accessHash': hash(token), 'guest.expiresAt': { $gt: new Date() } },
      { 'guest.resultAccessHash': hash(token), 'guest.resultExpiresAt': { $gt: new Date() } },
      // Links sent by email recovery; each one stays valid until its own expiry.
      { 'guest.recoveryAccess': { $elemMatch: { hash: hash(token), expiresAt: { $gt: new Date() } } } }], 'guest.revokedAt': null });
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
    const guestToken = req.get('X-Guest-Token'), portalSession = req.get('X-Recovery-Session');
    // A recovery-portal session opens results READ-ONLY (GET/HEAD) and only for submissions made with the session's email.
    // Revisions, practice generation and uploads still need the submission's own link.
    req.guestSubmission = !guestToken && portalSession && ['GET', 'HEAD'].includes(req.method)
      ? await require('./recoveryPortal.service').submissionForSession(req.params.submissionId, portalSession)
      : await authorize(req.params.submissionId, guestToken);
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
module.exports = { fail, hash, identity, issueToken, frontendLink, returnUrl, authorize, requireGuestAccess };
