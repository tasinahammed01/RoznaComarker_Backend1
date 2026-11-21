'use strict';
// /api/guest/speaking handlers (routes/speakingGuest.routes.js). Thin: the rules live in services/audio/speakingGuest.service.js. Errors answer
// { success: false, code, message } with a fixed message; anything unexpected is a 503 with a fixed text. Logs carry codes only (never the
// body, the email, the token or a file name).
const service = require('../services/audio/speakingGuest.service');
const access = require('../services/guestAccess.service');
const { effectiveMaxRecordingSeconds } = require('../services/audio/speakingAssignment');
const { readLimits } = require('../services/audio/policy');
const logger = require('../utils/logger');

const UNAVAILABLE = 'Temporarily unavailable. Please retry.';
/** Every access problem on a guest speaking submission (another guest, no link, an expired or revoked link, not a recording): one answer. */
const DENIED = Object.freeze({ success: false, code: 'GUEST_LINK_INVALID', message: 'This link is invalid or has expired. Request a new link.' });

function respondError(res, error) {
  const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
  logger.warn({ event: 'speaking_guest_request_failed', code: /^[A-Z_]{1,60}$/.test(error?.code || '') ? error.code : 'SPEAKING_GUEST_FAILED' });
  return res.status(status).json({ success: false, code: status === 503 ? 'SPEAKING_GUEST_UNAVAILABLE' : error.code || 'GUEST_REQUEST_INVALID',
    message: status === 503 ? UNAVAILABLE : error.message });
}

async function entry(req, res) {
  try { return res.json({ success: true, data: await service.entry(req.params.qrToken) }); }
  catch (error) { return respondError(res, error); }
}

/** Before the file is read. */
async function prepare(req, res, next) {
  try {
    req.speakingGuestContext = await service.prepare({ qrToken: req.params.qrToken, idempotencyKey: req.get('Idempotency-Key') });
    return next();
  } catch (error) { return respondError(res, error); }
}

/** The assignment's own maximum for the upload checks (never above the policy). */
const maxDurationFor = req => (req.speakingGuestContext ? effectiveMaxRecordingSeconds(req.speakingGuestContext.assignment, readLimits().limits) : undefined);

/** After the upload checks. The essay guest answers: received, the return link, whether it was emailed. */
async function submit(req, res) {
  try {
    const out = await service.commit({ context: req.speakingGuestContext, body: req.body, upload: req.audioUpload });
    if (out.duplicate) return res.json({ success: true, data: { received: true, duplicate: true,
      message: 'Your recording was already received. Use the emailed link or request a new link.' } });
    return res.json({ success: true, data: { received: true, returnUrl: out.link, emailSent: out.emailSent,
      message: out.emailSent ? 'Recording received. Your private link has been emailed.'
        : 'Recording received. Save your private link; the email could not be sent. You can request another link later.' } });
  } catch (error) { return respondError(res, error); }
}

/**
 * The guest access check of the essay guest routes (guestAccess.requireGuestAccess: the link or a read-only portal session, the assignment and
 * class still open), then: the submission must be a recording. Every refusal is the same 404 (DENIED); a server problem stays a 503.
 */
function requireSpeakingGuest(req, res, next) {
  const quiet = { status: code => ({ json: () => (code >= 500 ? res.status(503).json({ success: false, code: 'SPEAKING_GUEST_UNAVAILABLE', message: UNAVAILABLE })
    : res.status(404).json(DENIED)) }) };
  return access.requireGuestAccess(req, quiet, () => (req.guestSubmission?.sourceKind === 'audio' ? next() : res.status(404).json(DENIED)));
}

async function result(req, res) {
  try { return res.json({ success: true, data: require('../services/studentTeacherIdentity.service').withoutInternal(
    await service.result({ submission: req.guestSubmission, assignment: req.guestAssignment })) }); }
  catch (error) { return respondError(res, error); }
}

/** "Lost your link?" on the speaking guest page: the essay answer (sent BEFORE any lookup), then the resend in the background. */
async function recover(req, res) {
  let guest;
  try { guest = access.identity({ name: 'Recovery', email: req.body?.email }); }
  catch (error) { return respondError(res, error); }
  res.json({ success: true, data: require('../services/recoveryEmailQuota.service').publicAnswer() });
  const { qrToken } = req.params;
  setImmediate(() => {
    require('../services/guestRecovery.service').resendGuestLink({ emailNormalized: guest.normalizedEmail, qrToken, kind: 'speaking' })
      .catch(() => logger.warn({ event: 'guest_recovery_failed' }));
  });
  return undefined;
}

module.exports = { entry, prepare, maxDurationFor, submit, requireSpeakingGuest, result, recover, DENIED };
