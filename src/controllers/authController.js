'use strict';

// Compatibility-only cryptographic helpers retained for the security contract.
// This controller is not mounted and does not generate email verification or
// password-reset links; Firebase Admin is the sole action-link authority.
const crypto = require('crypto');

module.exports = {
  generateOTP() { return crypto.randomInt(100000, 1000000).toString(); },
  generateToken() { return crypto.randomBytes(32).toString('base64url'); },
};
