const mongoose = require('mongoose');

const User = require('../models/user.model');

const { ensureActivePlan } = require('../middlewares/usage.middleware');
const { signJwt } = require('../utils/jwt');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function createOrGetUser(req, res) {
  try {
    const { firebaseUid, email, displayName, photoURL } = req.body || {};

    if (!isNonEmptyString(firebaseUid)) {
      return sendError(res, 400, 'firebaseUid is required');
    }

    if (!isNonEmptyString(email)) {
      return sendError(res, 400, 'email is required');
    }

    const normalizedFirebaseUid = firebaseUid.trim();
    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await User.findOne({ firebaseUid: normalizedFirebaseUid });
    if (existingUser) {
      try {
        await ensureActivePlan(existingUser);
      } catch (err) {
        return sendError(res, 500, 'Failed to initialize subscription');
      }
      return sendSuccess(res, existingUser);
    }

    const createdUser = await User.create({
      firebaseUid: normalizedFirebaseUid,
      email: normalizedEmail,
      displayName: isNonEmptyString(displayName) ? displayName.trim() : undefined,
      photoURL: isNonEmptyString(photoURL) ? photoURL.trim() : undefined
      // role defaults to student (schema)
    });

    try {
      await ensureActivePlan(createdUser);
    } catch (err) {
      return sendError(res, 500, 'Failed to initialize subscription');
    }

    return sendSuccess(res, createdUser);
  } catch (err) {
    if (err && err.code === 11000) {
      // Another request likely created the user concurrently
      const keyValue = err.keyValue || {};
      const firebaseUid = keyValue.firebaseUid;

      if (firebaseUid) {
        const user = await User.findOne({ firebaseUid });
        if (user) {
          return sendSuccess(res, user);
        }
      }

      return sendError(res, 409, 'User already exists');
    }

    return sendError(res, 500, 'Failed to create or get user');
  }
}

async function getMe(req, res) {
  try {
    const user = req && req.user;
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    return sendSuccess(res, {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: user.role
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch user');
  }
}

async function setMyRole(req, res) {
  try {
    const role = req && req.body && req.body.role;

    if (!isNonEmptyString(role)) {
      return sendError(res, 400, 'role is required');
    }

    const normalizedRole = role.trim();

    if (!['teacher', 'student'].includes(normalizedRole)) {
      return sendError(res, 400, 'Invalid role');
    }

    const user = req && req.user;

    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    user.role = normalizedRole;
    await user.save();

    const token = signJwt(user);

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to update role');
  }
}

async function getUserById(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid user id');
    }

    const user = await User.findById(id);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    return sendSuccess(res, user);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch user');
  }
}

async function getUserByFirebaseUid(req, res) {
  try {
    const { firebaseUid } = req.params;

    if (!isNonEmptyString(firebaseUid)) {
      return sendError(res, 400, 'firebaseUid is required');
    }

    const user = await User.findOne({ firebaseUid: firebaseUid.trim() });
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    return sendSuccess(res, user);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch user');
  }
}

async function deactivateUser(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid user id');
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    return sendSuccess(res, user);
  } catch (err) {
    return sendError(res, 500, 'Failed to deactivate user');
  }
}

module.exports = {
  createOrGetUser,
  setMyRole,
  getMe,
  getUserById,
  getUserByFirebaseUid,
  deactivateUser
};
