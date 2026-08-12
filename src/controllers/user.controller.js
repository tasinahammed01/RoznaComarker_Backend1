const mongoose = require('mongoose');

const User = require('../models/user.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const { evaluationPolicyHash } = require('../services/teacherEvaluationPolicy.service');

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

function toUserLookupDto(user) {
  return {
    _id: user._id,
    email: user.email,
    displayName: user.displayName,
    institution: user.institution,
    bio: user.bio,
    photoURL: user.photoURL,
    role: user.role
  };
}

async function mayLookupUser(requester, target) {
  if (!requester || !target) return false;
  if (requester.role === 'admin' || String(requester._id) === String(target._id)) return true;
  if (requester.role !== 'teacher' || target.role !== 'student') return false;

  const classIds = await Class.find({ teacher: requester._id, isActive: true }).distinct('_id');
  if (!classIds.length) return false;
  return Boolean(await Membership.exists({
    student: target._id,
    class: { $in: classIds },
    status: 'active'
  }));
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
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ message: 'Not found' });
  }
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

    const previousPolicyHash = evaluationPolicyHash(user.aiConfig);
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
    const nextPolicyHash = evaluationPolicyHash(saved.aiConfig);
    if (nextAiConfig && previousPolicyHash !== nextPolicyHash && saved.role === 'teacher') {
      const classIds = (await Class.find({ teacher: saved._id }).select('_id').lean()).map((item) => item._id);
      const submissions = await Submission.find({ class: { $in: classIds } })
        .select('_id evaluationStatus evaluationPolicyHash').lean();
      const submissionIds = submissions.map((item) => item._id);
      const feedback = await SubmissionFeedback.find({ submissionId: { $in: submissionIds } })
        .select('submissionId overriddenByTeacher evaluationSourceHash evaluationPolicyHash').lean();
      const feedbackById = new Map(feedback.map((item) => [String(item.submissionId), item]));
      const staleIds = submissions.filter((submission) => {
        const savedFeedback = feedbackById.get(String(submission._id));
        if (savedFeedback?.overriddenByTeacher) return false;
        if (!['completed', 'partial', 'stale'].includes(String(submission.evaluationStatus))) return false;
        const storedHash = submission.evaluationPolicyHash || savedFeedback?.evaluationPolicyHash || null;
        return Boolean((storedHash || savedFeedback?.evaluationSourceHash) && storedHash
          && storedHash !== nextPolicyHash);
      }).map((submission) => submission._id);
      await Submission.updateMany({ _id: { $in: staleIds } }, {
        $set: { evaluationStatus: 'stale' }
      });
      await SubmissionFeedback.updateMany({
        submissionId: { $in: staleIds }, overriddenByTeacher: { $ne: true }
      }, {
        $set: { evaluationStatus: 'pending' }
      });
    }

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

const ALLOWED_ROLE_TRANSITIONS = {
  admin: ['teacher', 'student']
};

async function setMyRole(req, res) {
  try {
    const role = req && req.body && req.body.role;

    if (!isNonEmptyString(role)) {
      return sendError(res, 400, 'role is required');
    }

    const normalizedRole = role.trim();

    const user = req && req.user;

    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const userRole = user.role;
    if (!ALLOWED_ROLE_TRANSITIONS[userRole] || !ALLOWED_ROLE_TRANSITIONS[userRole].includes(normalizedRole)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to assign this role'
      });
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

    if (!(await mayLookupUser(req.user, user))) return sendError(res, 403, 'Forbidden');
    return sendSuccess(res, toUserLookupDto(user));
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

    const user = await User.findOne({ firebaseUid: firebaseUid.trim() })
      .select('email displayName institution bio photoURL role');
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    if (!(await mayLookupUser(req.user, user))) return sendError(res, 403, 'Forbidden');
    return sendSuccess(res, toUserLookupDto(user));
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
