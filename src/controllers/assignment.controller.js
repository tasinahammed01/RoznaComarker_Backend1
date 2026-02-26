const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');

const { incrementUsage } = require('../middlewares/usage.middleware');
const logger = require('../utils/logger');

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

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function normalizeOptionalString(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeRubric(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (err) {
    return null;
  }
}

async function createAssignment(req, res) {
  try {
    const { title, instructions, rubric, deadline, classId, allowLateResubmission } = req.body || {};

    if (!isNonEmptyString(title)) {
      return sendError(res, 400, 'title is required');
    }

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const parsedDeadline = toValidDate(deadline);
    if (!parsedDeadline) {
      return sendError(res, 400, 'deadline is required');
    }

    if (typeof allowLateResubmission !== 'undefined' && typeof allowLateResubmission !== 'boolean') {
      return sendError(res, 400, 'allowLateResubmission must be a boolean');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: classId,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const normalizedInstructions = normalizeOptionalString(instructions);
    if (normalizedInstructions === null) {
      return sendError(res, 400, 'instructions must be a string');
    }

    const normalizedRubric = normalizeRubric(rubric);
    if (normalizedRubric === null) {
      return sendError(res, 400, 'rubric must be valid text or JSON');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const qrToken = uuidv4();

      try {
        const created = await Assignment.create({
          title: title.trim(),
          instructions: normalizedInstructions,
          rubric: normalizedRubric,
          deadline: parsedDeadline,
          class: classDoc._id,
          teacher: teacherId,
          qrToken,
          allowLateResubmission: typeof allowLateResubmission === 'boolean' ? allowLateResubmission : undefined
        });

        await incrementUsage(teacherId, { assignments: 1 });

        const populated = await Assignment.findById(created._id)
          .populate('class')
          .populate('teacher', '_id email displayName photoURL role');

        return sendSuccess(res, populated);
      } catch (err) {
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.qrToken) {
          continue;
        }
        throw err;
      }
    }

    return sendError(res, 500, 'Failed to generate unique qr token');
  } catch (err) {
    logger.error('Failed to create assignment');
    logger.error(err);
    return sendError(res, 500, 'Failed to create assignment');
  }
}

async function updateAssignment(req, res) {
  try {
    const { id } = req.params;
    const { title, instructions, rubric, deadline, allowLateResubmission } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    if (typeof title !== 'undefined') {
      if (!isNonEmptyString(title)) {
        return sendError(res, 400, 'title must be a non-empty string');
      }
      assignment.title = title.trim();
    }

    if (typeof instructions !== 'undefined') {
      const normalizedInstructions = normalizeOptionalString(instructions);
      if (normalizedInstructions === null) {
        return sendError(res, 400, 'instructions must be a string');
      }
      assignment.instructions = normalizedInstructions;
    }

    if (typeof rubric !== 'undefined') {
      const normalizedRubric = normalizeRubric(rubric);
      if (normalizedRubric === null) {
        return sendError(res, 400, 'rubric must be valid text or JSON');
      }
      assignment.rubric = normalizedRubric;
    }

    if (typeof deadline !== 'undefined') {
      const parsedDeadline = toValidDate(deadline);
      if (!parsedDeadline) {
        return sendError(res, 400, 'deadline must be a valid date');
      }
      assignment.deadline = parsedDeadline;
    }

    if (typeof allowLateResubmission !== 'undefined') {
      if (typeof allowLateResubmission !== 'boolean') {
        return sendError(res, 400, 'allowLateResubmission must be a boolean');
      }
      assignment.allowLateResubmission = allowLateResubmission;
    }

    const saved = await assignment.save();

    const populated = await Assignment.findById(saved._id)
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to update assignment');
  }
}

async function deleteAssignment(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    assignment.isActive = false;
    const saved = await assignment.save();

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to delete assignment');
  }
}

async function getClassAssignments(req, res) {
  try {
    const { classId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: classId,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const assignments = await Assignment.find({
      class: classId,
      teacher: teacherId
    })
      .sort({ createdAt: -1 })
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, assignments);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignments');
  }
}

async function getMyAssignments(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const memberships = await Membership.find({
      student: studentId,
      status: 'active'
    }).populate({
      path: 'class',
      match: { isActive: true },
      populate: {
        path: 'teacher',
        select: '_id email displayName photoURL role'
      }
    });

    const classIds = memberships.filter((m) => m.class).map((m) => m.class._id);

    if (classIds.length === 0) {
      return sendSuccess(res, []);
    }

    const assignments = await Assignment.find({
      class: { $in: classIds },
      isActive: true
    })
      .sort({ deadline: 1 })
      .populate({
        path: 'class',
        populate: { path: 'teacher', select: '_id email displayName photoURL role' }
      })
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, assignments);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignments');
  }
}

async function getAssignmentById(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      isActive: true
    })
      .populate({
        path: 'class',
        populate: { path: 'teacher', select: '_id email displayName photoURL role' }
      })
      .populate('teacher', '_id email displayName photoURL role');

    if (!assignment || !assignment.class || assignment.class.isActive === false) {
      return sendError(res, 404, 'Assignment not found');
    }

    const membership = await Membership.findOne({
      student: studentId,
      class: assignment.class._id,
      status: 'active'
    });

    if (!membership) {
      return sendError(res, 403, 'Forbidden');
    }

    return sendSuccess(res, assignment);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignment');
  }
}

module.exports = {
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getClassAssignments,
  getMyAssignments,
  getAssignmentById
};
