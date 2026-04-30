const User = require('../models/user.model');

const { ensureActivePlan } = require('./usage.middleware');

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

async function createOrGetUserFromFirebase(decodedToken, intendedRole) {
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

  const ALLOWED_ROLES = ['teacher', 'student'];
  const roleToAssign = (intendedRole && ALLOWED_ROLES.includes(String(intendedRole).toLowerCase()))
    ? String(intendedRole).toLowerCase()
    : 'student';

  try {
    const createdUser = await User.create({
      firebaseUid: normalizedFirebaseUid,
      email: normalizedEmail,
      displayName: isNonEmptyString(decodedToken.name)
        ? decodedToken.name.trim()
        : undefined,
      photoURL: isNonEmptyString(decodedToken.picture)
        ? decodedToken.picture.trim()
        : undefined,
      role: roleToAssign
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

    const decodedToken = await admin.auth().verifyIdToken(token);

    const intendedRole = req.body && req.body.intendedRole;
    const { user, isNew } = await createOrGetUserFromFirebase(decodedToken, intendedRole);

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
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
}

module.exports = {
  verifyFirebaseToken
};
