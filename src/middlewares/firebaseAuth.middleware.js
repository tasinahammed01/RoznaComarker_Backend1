const User = require('../models/user.model');

const logger = require('../utils/logger');

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;

  return token.trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firebaseVerificationDiagnostic(err, admin) {
  const code = isNonEmptyString(err && err.code) ? err.code.trim() : 'auth/unknown-error';
  const rawMessage = isNonEmptyString(err && err.message) ? err.message.trim() : 'Firebase ID token verification failed';
  const safeMessage = rawMessage
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]');
  return {
    event: 'firebase.idTokenVerification.failed',
    authStage: 'verifyIdToken',
    code,
    message: safeMessage,
    firebaseProjectId: admin && (admin.firebaseProjectId || admin.app?.().options?.projectId) || null
  };
}

function firebaseSignInProvider(decodedToken) {
  const provider = decodedToken && decodedToken.firebase && decodedToken.firebase.sign_in_provider;
  return isNonEmptyString(provider) ? provider.trim() : null;
}

function requiresVerifiedEmail(decodedToken) {
  const provider = firebaseSignInProvider(decodedToken);
  return provider === 'password' || provider === 'google.com';
}

async function createOrGetUserFromFirebase(decodedToken) {
  const firebaseUid = decodedToken && decodedToken.uid;
  const email = decodedToken && decodedToken.email;

  if (!isNonEmptyString(firebaseUid) || !isNonEmptyString(email)) {
    return { user: null, isNew: false };
  }

  const normalizedFirebaseUid = firebaseUid.trim();
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await User.findOne({ firebaseUid: normalizedFirebaseUid });
  if (existingUser) {
    return { user: existingUser, isNew: false };
  }

  try {
    const createdUser = await User.create({
      firebaseUid: normalizedFirebaseUid,
      email: normalizedEmail,
      displayName: isNonEmptyString(decodedToken.name)
        ? decodedToken.name.trim()
        : undefined,
      photoURL: isNonEmptyString(decodedToken.picture)
        ? decodedToken.picture.trim()
        : undefined
    });

    return { user: createdUser, isNew: true };
  } catch (err) {
    if (err && err.code === 11000) {
      // Another request likely created the user concurrently
      const user = await User.findOne({ firebaseUid: normalizedFirebaseUid });
      if (user) return { user, isNew: false };
    }

    throw err;
  }
}

function loginError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

async function verifyFirebaseToken(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return loginError(res, 401, 'AUTH_REQUIRED', 'Authorization token missing');
  let auth;
  try {
    auth = require('../config/firebase').auth();
  } catch (err) {
    logger.error({ event: 'firebase.initialization.failed', errorName: err?.name });
    return loginError(res, 503, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is temporarily unavailable');
  }
  let decodedToken;
  try {
    decodedToken = await auth.verifyIdToken(token, true);
  } catch (err) {
    const invalid = ['auth/argument-error', 'auth/invalid-argument', 'auth/invalid-id-token',
      'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found',
      'auth/tenant-id-mismatch'].includes(err?.code);
    logger.error({ event: 'firebase.idTokenVerification.failed', code: invalid ? err.code : 'AUTH_PROVIDER_UNAVAILABLE' });
    return loginError(res, invalid ? 401 : 503, invalid ? 'AUTH_INVALID' : 'AUTH_PROVIDER_UNAVAILABLE',
      invalid ? 'Invalid or expired token' : 'Authentication provider is temporarily unavailable');
  }
  if (requiresVerifiedEmail(decodedToken) && decodedToken.email_verified !== true) {
    return loginError(res, 403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before continuing.');
  }
  try {
    const { user, isNew } = await createOrGetUserFromFirebase(decodedToken);
    if (!user) return loginError(res, 401, 'AUTH_INVALID', 'Invalid token payload');
    if (user.isActive === false) return loginError(res, 403, 'ACCOUNT_INACTIVE', 'Account is inactive');
    req.user = user;
    req.isNewUser = isNew;
    req.firebase = decodedToken;
    return next();
  } catch (err) {
    logger.error({ event: 'auth.lookup.failed', errorName: err?.name });
    return loginError(res, 503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable');
  }
}

// Verifies Firebase identity without requiring email verification or touching
// MongoDB. This is intentionally limited to pre-session operations such as
// sending a verification email.
async function verifyFirebaseIdentityToken(req, res, next) {
  try {
    const admin = require('../config/firebase');
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authorization token missing' });
    }
    req.firebase = await admin.auth().verifyIdToken(token, true);
    return next();
  } catch (err) {
    let admin = null;
    try { admin = require('../config/firebase'); } catch { /* sanitized below */ }
    logger.error(firebaseVerificationDiagnostic(err, admin));
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

module.exports = {
  createOrGetUserFromFirebase,
  firebaseVerificationDiagnostic,
  firebaseSignInProvider,
  requiresVerifiedEmail,
  verifyFirebaseIdentityToken,
  verifyFirebaseToken
};
