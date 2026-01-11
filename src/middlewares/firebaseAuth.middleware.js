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

async function createOrGetUserFromFirebase(decodedToken) {
  const firebaseUid = decodedToken && decodedToken.uid;
  const email = decodedToken && decodedToken.email;

  if (!isNonEmptyString(firebaseUid) || !isNonEmptyString(email)) {
    return null;
  }

  const normalizedFirebaseUid = firebaseUid.trim();
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await User.findOne({ firebaseUid: normalizedFirebaseUid });
  if (existingUser) {
    return existingUser;
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
      // role defaults to student (schema)
    });

    return createdUser;
  } catch (err) {
    if (err && err.code === 11000) {
      // Another request likely created the user concurrently
      const user = await User.findOne({ firebaseUid: normalizedFirebaseUid });
      if (user) return user;
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

    const user = await createOrGetUserFromFirebase(decodedToken);

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
