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

function clampNumber(value, { min, max, fallback }) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeAiConfigPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};

  const strictnessRaw = typeof obj.strictness === 'string' ? obj.strictness.trim().toLowerCase() : null;
  const strictnessAllowed = ['friendly', 'balanced', 'strict'];
  const strictness = strictnessAllowed.includes(String(strictnessRaw)) ? String(strictnessRaw) : undefined;

  const checksObj = obj.checks && typeof obj.checks === 'object' ? obj.checks : {};
  const checks = {
    grammarSpelling: typeof checksObj.grammarSpelling === 'boolean' ? checksObj.grammarSpelling : undefined,
    coherenceLogic: typeof checksObj.coherenceLogic === 'boolean' ? checksObj.coherenceLogic : undefined,
    factChecking: typeof checksObj.factChecking === 'boolean' ? checksObj.factChecking : undefined
  };

  const hasAnyChecks = Object.values(checks).some((v) => typeof v === 'boolean');
  if (!strictness && !hasAnyChecks) return null;

  return {
    ...(strictness ? { strictness } : {}),
    ...(hasAnyChecks ? { checks } : {})
  };
}

function normalizeClassroomDefaultsPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const gradingScaleRaw = typeof obj.gradingScale === 'string' ? obj.gradingScale.trim().toLowerCase() : null;
  const gradingScaleAllowed = ['score_0_100', 'grade_a_f', 'pass_fail'];
  const gradingScale = gradingScaleAllowed.includes(String(gradingScaleRaw)) ? String(gradingScaleRaw) : undefined;

  const latePenalty = typeof obj.lateSubmissionPenaltyPercent !== 'undefined'
    ? clampNumber(obj.lateSubmissionPenaltyPercent, { min: 0, max: 100, fallback: undefined })
    : undefined;

  const autoPublishGrades = typeof obj.autoPublishGrades === 'boolean' ? obj.autoPublishGrades : undefined;

  if (!gradingScale && typeof latePenalty === 'undefined' && typeof autoPublishGrades === 'undefined') return null;

  return {
    ...(gradingScale ? { gradingScale } : {}),
    ...(typeof latePenalty === 'number' ? { lateSubmissionPenaltyPercent: latePenalty } : {}),
    ...(typeof autoPublishGrades === 'boolean' ? { autoPublishGrades } : {})
  };
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
      institution: user.institution,
      bio: user.bio,
      aiConfig: user.aiConfig,
      classroomDefaults: user.classroomDefaults,
      photoURL: user.photoURL,
      role: user.role
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch user');
  }
}

async function updateMe(req, res) {
  try {
    const user = req && req.user;
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { displayName, institution, bio, aiConfig, classroomDefaults } = req.body || {};

    if (typeof displayName === 'string') {
      user.displayName = displayName.trim();
    }

    if (typeof institution === 'string') {
      user.institution = institution.trim();
    }

    if (typeof bio === 'string') {
      user.bio = bio.trim();
    }

    const nextAiConfig = normalizeAiConfigPayload(aiConfig);
    if (nextAiConfig) {
      user.aiConfig = {
        ...(user.aiConfig && typeof user.aiConfig === 'object' ? user.aiConfig.toObject?.() || user.aiConfig : {}),
        ...nextAiConfig,
        checks: {
          ...(user.aiConfig && user.aiConfig.checks ? user.aiConfig.checks.toObject?.() || user.aiConfig.checks : {}),
          ...(nextAiConfig.checks || {})
        }
      };
    }

    const nextDefaults = normalizeClassroomDefaultsPayload(classroomDefaults);
    if (nextDefaults) {
      user.classroomDefaults = {
        ...(user.classroomDefaults && typeof user.classroomDefaults === 'object' ? user.classroomDefaults.toObject?.() || user.classroomDefaults : {}),
        ...nextDefaults
      };
    }

    const saved = await user.save();

    return sendSuccess(res, {
      id: saved._id,
      email: saved.email,
      displayName: saved.displayName,
      institution: saved.institution,
      bio: saved.bio,
      aiConfig: saved.aiConfig,
      classroomDefaults: saved.classroomDefaults,
      photoURL: saved.photoURL,
      role: saved.role
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to update profile');
  }
}

async function uploadMyAvatar(req, res) {
  try {
    const user = req && req.user;
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const file = req && req.file;
    if (!file || !file.filename) {
      return sendError(res, 400, 'No file provided');
    }

    const urlPath = `/uploads/avatars/${encodeURIComponent(file.filename)}`;
    user.photoURL = urlPath;
    const saved = await user.save();

    return res.json({
      success: true,
      data: {
        photoURL: saved.photoURL
      }
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to upload avatar');
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

    const user = await User.findById(id).select('email displayName institution bio photoURL role');
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    return sendSuccess(res, {
      _id: user._id,
      email: user.email,
      displayName: user.displayName,
      institution: user.institution,
      bio: user.bio,
      photoURL: user.photoURL,
      role: user.role
    });
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
  updateMe,
  uploadMyAvatar,
  getUserById,
  getUserByFirebaseUid,
  deactivateUser
};
