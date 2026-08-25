const User = require('../models/user.model');

const { ensureActivePlan } = require('./usage.middleware');
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

async function verifyFirebaseToken(req, res, next) {
  try {
    const admin = require('../config/firebase');
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token missing'
      });
    }

    // checkRevoked=true also rejects disabled Firebase users and revoked ID
    // tokens when creating a new backend session.
    const decodedToken = await admin.auth().verifyIdToken(token, true);

    if (requiresVerifiedEmail(decodedToken) && decodedToken.email_verified !== true) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before continuing.'
      });
    }

    const { user, isNew } = await createOrGetUserFromFirebase(decodedToken);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload'
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'User is inactive'
      });
    }

    try {
      await ensureActivePlan(user);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize subscription'
      });
    }

    req.user = user;
    req.isNewUser = isNew;
    req.firebase = decodedToken;

    return next();
  } catch (err) {
    let admin = null;
    try { admin = require('../config/firebase'); } catch { /* initialization error is already sanitized below */ }
    logger.error(firebaseVerificationDiagnostic(err, admin));
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
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
