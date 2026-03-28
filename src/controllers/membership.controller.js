const mongoose = require('mongoose');

const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const User = require('../models/user.model');
const { createNotification } = require('../services/notification.service');
const { publishToUser } = require('../services/notificationRealtime.service');

const { ensureActivePlan, incrementUsage } = require('../middlewares/usage.middleware');

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

async function joinClassByCode(req, res) {
  try {
    const { joinCode } = req.body || {};

    if (!isNonEmptyString(joinCode)) {
      return sendError(res, 400, 'joinCode is required');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      joinCode: joinCode.trim(),
      isActive: true
    }).populate('teacher', '_id email displayName photoURL role');

    if (!classDoc) {
      return sendError(res, 404, 'Invalid join code');
    }

    const teacherId = classDoc.teacher && classDoc.teacher._id ? classDoc.teacher._id : classDoc.teacher;
    const teacher = await User.findById(teacherId);
    if (!teacher) {
      return sendError(res, 404, 'Teacher not found');
    }

    const planDoc = await ensureActivePlan(teacher);
    const studentLimit = planDoc && planDoc.limits ? planDoc.limits.students : null;
    const currentStudents = teacher.usage && typeof teacher.usage.students === 'number' ? teacher.usage.students : 0;

    if (typeof studentLimit === 'number' && currentStudents + 1 > studentLimit) {
      return sendError(res, 403, 'Limit exceeded: students');
    }

    const existing = await Membership.findOne({
      student: studentId,
      class: classDoc._id
    });

    if (existing && existing.status === 'active') {
      return sendError(res, 409, 'Already joined this class');
    }

    let membership;

    if (existing && existing.status === 'left') {
      existing.status = 'active';
      existing.joinedAt = new Date();
      membership = await existing.save();
    } else {
      membership = await Membership.create({
        student: studentId,
        class: classDoc._id
      });
    }

    await incrementUsage(teacher._id, { students: 1 });

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
      console.error('Failed to send notification:', notificationErr);
    }

    return sendSuccess(res, {
      membership,
      class: classDoc
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return sendError(res, 409, 'Already joined this class');
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
      return sendError(res, 400, 'Invalid class id');
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
      return sendError(res, 404, 'Membership not found');
    }

    if (membership.status === 'left') {
      return sendError(res, 400, 'Already left this class');
    }

    membership.status = 'left';
    const saved = await membership.save();

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
