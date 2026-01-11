const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const File = require('../models/File');

const { bytesToMB, ensureActivePlan, incrementUsage } = require('../middlewares/usage.middleware');

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

function getBaseUrl(req) {
  const fromEnv = (process.env.BASE_URL || '').trim();
  const raw = fromEnv.length ? fromEnv : `${req.protocol}://${req.get('host')}`;
  return raw.replace(/\/+$/, '');
}

function toPublicUrl(req, type, filename) {
  const base = getBaseUrl(req);
  return `${base}/uploads/${type}/${encodeURIComponent(filename)}`;
}

function toStoredPath(type, filename) {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.posix.join(basePath, type, filename);
}

async function persistUploadedFile(req, type) {
  const userId = req.user && req.user._id;
  const role = req.user && req.user.role;

  if (!userId || !role) {
    return { error: { statusCode: 401, message: 'Unauthorized' } };
  }

  const file = req.file;
  if (!file) {
    return { error: { statusCode: 400, message: 'No file provided' } };
  }

  const storedPath = toStoredPath(type, file.filename);
  const url = toPublicUrl(req, type, file.filename);

  const created = await File.create({
    originalName: file.originalname,
    filename: file.filename,
    path: storedPath,
    url,
    uploadedBy: userId,
    role,
    type
  });

  return {
    fileDoc: created,
    url
  };
}

function computeDeadlineStatus(assignment) {
  const now = new Date();
  const deadline = assignment && assignment.deadline ? new Date(assignment.deadline) : null;

  const isLate = Boolean(deadline && now.getTime() > deadline.getTime());
  const status = isLate ? 'late' : 'submitted';

  return {
    now,
    isLate,
    status
  };
}

async function assertStudentMembership(studentId, classId) {
  const membership = await Membership.findOne({
    student: studentId,
    class: classId,
    status: 'active'
  });

  return Boolean(membership);
}

async function upsertSubmission({ req, res, assignment, qrToken }) {
  const studentId = req.user && req.user._id;
  if (!studentId) {
    return sendError(res, 401, 'Unauthorized');
  }

  const classDoc = await Class.findOne({
    _id: assignment.class,
    isActive: true
  });

  if (!classDoc) {
    return sendError(res, 404, 'Class not found');
  }

  const isMember = await assertStudentMembership(studentId, classDoc._id);
  if (!isMember) {
    return sendError(res, 403, 'Not class member');
  }

  const existing = await Submission.findOne({
    student: studentId,
    assignment: assignment._id
  });

  if (!existing) {
    const planDoc = await ensureActivePlan(req.user);
    const limit = planDoc && planDoc.limits ? planDoc.limits.submissions : null;
    const current = req.user && req.user.usage && typeof req.user.usage.submissions === 'number'
      ? req.user.usage.submissions
      : 0;

    if (typeof limit === 'number' && current + 1 > limit) {
      return sendError(res, 403, 'Limit exceeded: submissions');
    }
  }

  const { now, isLate, status } = computeDeadlineStatus(assignment);

  if (existing) {
    if (isLate && assignment.allowLateResubmission !== true) {
      return sendError(res, 403, 'Deadline passed');
    }
  }

  const persisted = await persistUploadedFile(req, 'submissions');
  if (persisted.error) {
    return sendError(res, persisted.error.statusCode, persisted.error.message);
  }

  const uploadedMB =
    typeof req.uploadSizeMB === 'number'
      ? req.uploadSizeMB
      : bytesToMB(req.file && req.file.size);

  try {
    if (existing) {
      existing.file = persisted.fileDoc._id;
      existing.fileUrl = persisted.url;
      existing.status = status;
      existing.submittedAt = now;
      existing.isLate = isLate;
      existing.qrToken = qrToken;

      const saved = await existing.save();

      await incrementUsage(studentId, { storageMB: uploadedMB });

      const populated = await Submission.findById(saved._id)
        .populate('student', '_id email displayName photoURL role')
        .populate('assignment')
        .populate('class')
        .populate('file');

      return sendSuccess(res, populated);
    }

    const created = await Submission.create({
      student: studentId,
      assignment: assignment._id,
      class: classDoc._id,
      file: persisted.fileDoc._id,
      fileUrl: persisted.url,
      status,
      submittedAt: now,
      isLate,
      qrToken
    });

    await incrementUsage(studentId, { submissions: 1, storageMB: uploadedMB });

    const populated = await Submission.findById(created._id)
      .populate('student', '_id email displayName photoURL role')
      .populate('assignment')
      .populate('class')
      .populate('file');

    return sendSuccess(res, populated);
  } catch (err) {
    if (err && err.code === 11000) {
      return sendError(res, 409, 'Already submitted');
    }

    return sendError(res, 500, 'Failed to submit assignment');
  }
}

async function submitByAssignmentId(req, res) {
  try {
    const { assignmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const assignment = await Assignment.findOne({
      _id: assignmentId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    return upsertSubmission({
      req,
      res,
      assignment,
      qrToken: assignment.qrToken
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to submit assignment');
  }
}

async function submitByQrToken(req, res) {
  try {
    const { qrToken } = req.params;

    if (!qrToken || typeof qrToken !== 'string' || !qrToken.trim()) {
      return sendError(res, 400, 'Invalid QR');
    }

    const assignment = await Assignment.findOne({
      qrToken: qrToken.trim(),
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Invalid QR');
    }

    return upsertSubmission({
      req,
      res,
      assignment,
      qrToken: assignment.qrToken
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to submit assignment');
  }
}

async function getSubmissionsByAssignment(req, res) {
  try {
    const { assignmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: assignmentId,
      teacher: teacherId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    const classDoc = await Class.findOne({
      _id: assignment.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const submissions = await Submission.find({
      assignment: assignment._id,
      class: classDoc._id
    })
      .sort({ submittedAt: -1 })
      .populate('student', '_id email displayName photoURL role')
      .populate('assignment')
      .populate('class')
      .populate('file');

    return sendSuccess(res, submissions);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submissions');
  }
}

async function getMySubmissionByAssignmentId(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const submission = await Submission.findOne({
      student: studentId,
      assignment: assignmentId
    })
      .populate('assignment')
      .populate('class')
      .populate('file')
      .populate('student', '_id email displayName photoURL role');

    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    return sendSuccess(res, submission);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submission');
  }
}

async function getMySubmissions(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submissions = await Submission.find({
      student: studentId
    })
      .sort({ submittedAt: -1 })
      .populate('assignment')
      .populate('class')
      .populate('file');

    return sendSuccess(res, submissions);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submissions');
  }
}

module.exports = {
  submitByAssignmentId,
  submitByQrToken,
  getSubmissionsByAssignment,
  getMySubmissions,
  getMySubmissionByAssignmentId
};
