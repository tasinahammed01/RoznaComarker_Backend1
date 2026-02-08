const mongoose = require('mongoose');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');

const { incrementUsage } = require('../middlewares/usage.middleware');

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

function buildJoinUrl(req, joinCode) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${process.env.FRONTEND_URL}/student/join-class?joinCode=${joinCode}`;
}

async function createClass(req, res) {
  try {
    const { name, description } = req.body || {};

    if (!isNonEmptyString(name)) {
      return sendError(res, 400, 'name is required');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const joinCode = uuidv4();
      const joinUrl = buildJoinUrl(req, joinCode);
      const qrCodeUrl = await QRCode.toDataURL(joinUrl);

      try {
        const createdClass = await Class.create({
          name: name.trim(),
          description: isNonEmptyString(description) ? description.trim() : undefined,
          teacher: teacherId,
          joinCode,
          qrCodeUrl
        });

        await incrementUsage(teacherId, { classes: 1 });

        return sendSuccess(res, createdClass);
      } catch (err) {
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.joinCode) {
          continue;
        }
        throw err;
      }
    }

    return sendError(res, 500, 'Failed to generate unique join code');
  } catch (err) {
    return sendError(res, 500, 'Failed to create class');
  }
}

async function updateClass(req, res) {
  try {
    const { id } = req.params;
    const { name, description } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    if (typeof name !== 'undefined') {
      if (!isNonEmptyString(name)) {
        return sendError(res, 400, 'name must be a non-empty string');
      }
      classDoc.name = name.trim();
    }

    if (typeof description !== 'undefined') {
      if (description === null) {
        classDoc.description = undefined;
      } else if (typeof description === 'string') {
        classDoc.description = description.trim();
      } else {
        return sendError(res, 400, 'description must be a string');
      }
    }

    const saved = await classDoc.save();
    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to update class');
  }
}

async function deleteClass(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    classDoc.isActive = false;
    const saved = await classDoc.save();

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to delete class');
  }
}

async function getMyClasses(req, res) {
  try {
    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classes = await Class.find({
      teacher: teacherId,
      isActive: true
    }).sort({ createdAt: -1 });

    return sendSuccess(res, classes);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch classes');
  }
}

async function joinByCode(req, res) {
  try {
    const { joinCode } = req.params;

    if (!isNonEmptyString(joinCode)) {
      return sendError(res, 400, 'joinCode is required');
    }

    const classDoc = await Class.findOne({
      joinCode: joinCode.trim(),
      isActive: true
    }).select('_id name description createdAt updatedAt');

    if (!classDoc) {
      return sendError(res, 404, 'Invalid join code');
    }

    return sendSuccess(res, classDoc);
  } catch (err) {
    return sendError(res, 500, 'Failed to verify join code');
  }
}

async function getClassStudents(req, res) {
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

    const memberships = await Membership.find({
      class: classDoc._id,
      status: 'active'
    })
      .sort({ joinedAt: -1 })
      .populate('student', '_id email displayName');

    const students = memberships
      .map((m) => {
        const student = m && m.student;
        if (!student || typeof student !== 'object') return null;

        const email = student.email || '';
        const name = student.displayName || email;
        const joinedAt = m.joinedAt ? new Date(m.joinedAt).toISOString() : null;

        return {
          id: String(student._id),
          name,
          email,
          joinedAt
        };
      })
      .filter(Boolean);

    return sendSuccess(res, students);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch class students');
  }
}

async function getClassSummary(req, res) {
  try {
    const { classId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const user = req.user;
    if (!user || !user._id || !user.role) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({ _id: classId, isActive: true }).populate(
      'teacher',
      '_id email displayName photoURL role'
    );

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const teacherId = classDoc.teacher && classDoc.teacher._id ? classDoc.teacher._id : classDoc.teacher;

    if (user.role === 'teacher') {
      if (String(teacherId) !== String(user._id)) {
        return sendError(res, 403, 'Forbidden');
      }
    } else {
      const membership = await Membership.findOne({
        class: classDoc._id,
        student: user._id,
        status: 'active'
      });

      if (!membership) {
        return sendError(res, 403, 'Forbidden');
      }
    }

    const studentsCount = await Membership.countDocuments({
      class: classDoc._id,
      status: 'active'
    });

    const assignmentsCount = await Assignment.countDocuments({
      class: classDoc._id,
      isActive: true
    });

    const submissionsCount = await Submission.countDocuments({
      class: classDoc._id
    });

    // Get the latest timestamp from class, assignments, and submissions
    const classUpdatedAt = classDoc.updatedAt || classDoc.createdAt;
    
    const latestAssignment = await Assignment.findOne({
      class: classDoc._id,
      isActive: true
    }).sort({ updatedAt: -1 }).select('updatedAt');

    const latestSubmission = await Submission.findOne({
      class: classDoc._id
    }).sort({ updatedAt: -1 }).select('updatedAt');

    const assignmentUpdatedAt = latestAssignment?.updatedAt || classUpdatedAt;
    const submissionUpdatedAt = latestSubmission?.updatedAt || classUpdatedAt;
    
    const lastEdited = new Date(Math.max(
      new Date(classUpdatedAt).getTime(),
      new Date(assignmentUpdatedAt).getTime(),
      new Date(submissionUpdatedAt).getTime()
    ));

    const teacher = classDoc.teacher;
    const teacherEmail = teacher && teacher.email ? teacher.email : '';
    const teacherName = (teacher && (teacher.displayName || teacher.email)) || '';

    return sendSuccess(res, {
      id: String(classDoc._id),
      name: classDoc.name,
      description: classDoc.description || '',
      joinCode: classDoc.joinCode,
      teacher: {
        id: teacher && teacher._id ? String(teacher._id) : String(teacherId),
        name: teacherName,
        email: teacherEmail
      },
      studentsCount,
      assignmentsCount,
      submissionsCount,
      lastEdited: lastEdited.toISOString()
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch class summary');
  }
}

module.exports = {
  createClass,
  updateClass,
  deleteClass,
  getMyClasses,
  joinByCode,
  getClassStudents,
  getClassSummary
};
