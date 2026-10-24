'use strict';
// Fail closed: only the explicit string "true" enables login-free access.
function guestSubmissionEnabled() { return process.env.GUEST_SUBMISSION_ENABLED === 'true'; }
const message = 'Guest submission is temporarily unavailable.';
function requireGuestSubmissionEnabled(_req, res, next) {
  if (!guestSubmissionEnabled()) return res.status(403).json({ success: false, code: 'GUEST_SUBMISSION_UNAVAILABLE', message });
  next();
}
module.exports = { guestSubmissionEnabled, requireGuestSubmissionEnabled, message };
