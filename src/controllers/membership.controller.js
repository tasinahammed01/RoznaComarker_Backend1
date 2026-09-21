const mongoose = require('mongoose');

const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const User = require('../models/user.model');
const { createNotification } = require('../services/notification.service');
const { publishToUser } = require('../services/notificationRealtime.service');

const { ensureActivePlan, getLimit } = require('../middlewares/usage.middleware');
const { reserveStudentSeat, releaseStudentSeats } = require('../services/studentQuota.service');
const logger = require('../utils/logger');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(code ? { code } : {})
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function joinClassByCode(req, res) {
  let reservedTeacherId = null;
  try {
    const { joinCode } = req.body || {};

    if (!isNonEmptyString(joinCode)) {
      return sendError(res, 400, 'joinCode is required');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const normalizedJoinCode = joinCode.trim();
    const classDoc = await Class.findOne({
      joinCode: { $in: [normalizedJoinCode, normalizedJoinCode.toUpperCase()] },
      isActive: true
    }).populate('teacher', '_id email displayName photoURL role');

    if (!classDoc) {
      return sendError(res, 404, 'Invalid join code', 'INVALID_JOIN_CODE');
    }
    if (classDoc.status === 'archived') {
      return sendError(res, 409, 'This class is archived and is no longer accepting new students.', 'CLASS_ARCHIVED');
    }

    const teacherId = classDoc.teacher && classDoc.teacher._id ? classDoc.teacher._id : classDoc.teacher;
    const teacher = await User.findById(teacherId);
    if (!teacher) {
      return sendError(res, 404, 'Teacher not found', 'TEACHER_NOT_FOUND');
    }

    const existing = await Membership.findOne({
      student: studentId,
      class: classDoc._id
    });

    if (existing && existing.status === 'active') {
      return sendError(res, 409, 'Already joined this class', 'ALREADY_JOINED');
    }

    const planDoc = await ensureActivePlan(teacher);
    const studentLimit = getLimit(planDoc, 'students');
    if (!(await reserveStudentSeat(teacher._id, studentLimit))) {
      return sendError(res, 403, 'Student limit reached for this account.', 'STUDENT_LIMIT_REACHED');
    }
    reservedTeacherId = teacher._id;

    let membership;

    if (existing && existing.status === 'left') {
      membership = await Membership.findOneAndUpdate(
        { _id: existing._id, status: 'left' },
        { $set: { status: 'active', joinedAt: new Date() } },
        { new: true }
      );
    }
    if (!membership) {
      membership = await Membership.create({
        student: studentId,
        class: classDoc._id
      });
    }

    const stillJoinable = await Class.exists({
      _id: classDoc._id,
      isActive: true,
      $or: [{ status: 'active' }, { status: { $exists: false } }]
    });
    if (!stillJoinable) {
      const reverted = await Membership.findOneAndUpdate(
        { _id: membership._id, status: 'active' },
        { $set: { status: 'left' } }
      );
      if (reverted) await releaseStudentSeats(teacher._id, 1);
      reservedTeacherId = null;
      return sendError(res, 409, 'This class is no longer accepting students.', 'CLASS_ARCHIVED');
    }
    reservedTeacherId = null;

    // Send real-time notification to teacher
    try {
      const student = await User.findById(studentId).select('_id email displayName');
      
      // Create notification for teacher
      await createNotification({
        recipientId: teacher._id,
        actorId: studentId,
        type: 'student_joined',
        title: 'New Student Joined',
        description: `${student?.displayName || student?.email} has joined your class "${classDoc.name}"`,
        data: {
          classId: classDoc._id,
          studentId: studentId,
          className: classDoc.name
        }
      });

      // Send real-time event to teacher's SSE stream
      publishToUser({
        userId: teacher._id,
        event: 'student_joined',
        payload: {
          classId: String(classDoc._id),
          studentId: String(studentId),
          studentName: student?.displayName || student?.email,
          className: classDoc.name,
          joinedAt: membership.joinedAt
        }
      });

    } catch (notificationErr) {
      // Log error but don't fail the join process
      logger.error(`Failed to send notification: ${notificationErr && notificationErr.message ? notificationErr.message : notificationErr}`);
    }

    return sendSuccess(res, {
      membership,
      class: classDoc
    });
  } catch (err) {
    if (reservedTeacherId) {
      await releaseStudentSeats(reservedTeacherId, 1).catch(() => undefined);
      reservedTeacherId = null;
    }
    if (err && err.code === 11000) {
      return sendError(res, 409, 'Already joined this class', 'ALREADY_JOINED');
    }

    return sendError(res, 500, 'Failed to join class');
  }
}

async function getMyClasses(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const memberships = await Membership.find({
      student: studentId,
      status: 'active'
    })
      .sort({ joinedAt: -1 })
      .populate({
        path: 'class',
        match: { isActive: true },
        populate: {
          path: 'teacher',
          select: '_id email displayName photoURL role'
        }
      });

    const filtered = memberships.filter((m) => m.class);

    return sendSuccess(res, filtered);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch classes');
  }
}

async function leaveClass(req, res) {
  try {
    const { classId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id', 'INVALID_CLASS_ID');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const membership = await Membership.findOne({
      student: studentId,
      class: classId
    });

    if (!membership) {
      return sendError(res, 404, 'Membership not found', 'MEMBERSHIP_NOT_FOUND');
    }

    if (membership.status === 'left') {
      return sendError(res, 409, 'Already left this class', 'ALREADY_LEFT');
    }

    const classDoc = await Class.findById(classId).select('teacher');
    if (!classDoc) return sendError(res, 404, 'Class not found', 'CLASS_NOT_FOUND');

    const saved = await Membership.findOneAndUpdate(
      { _id: membership._id, status: 'active' },
      { $set: { status: 'left' } },
      { new: true }
    );
    if (!saved) return sendError(res, 409, 'Already left this class', 'ALREADY_LEFT');
    await releaseStudentSeats(classDoc.teacher, 1);

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to leave class');
  }
}

module.exports = {
  joinClassByCode,
  getMyClasses,
  leaveClass
};
