const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const File = require('../models/File');
const Feedback = require('../models/Feedback');
const OcrUpload = require('../models/OcrUpload');
const Submission = require('../models/Submission');
const Upload = require('../models/Upload');

const logger = require('../utils/logger');
const uploadService = require('../services/upload.service');
const { ApiError } = require('../middlewares/error.middleware');

function isSafeStoredFilename(filename) {
  const value = String(filename || '');
  if (value !== path.basename(value)) return false;
  // Must align with ALLOWED_EXTENSIONS in upload.middleware.js.
  return /^[0-9a-fA-F-]{36}\.(pdf|jpg|jpeg|png|webp)$/.test(value);
}

function sendStoredFile(res, type, filename) {
  const absolute = uploadService.getAbsolutePathForStoredFile(type, filename);
  const contentTypes = {
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp'
  };
  return res.sendFile(absolute, {
    headers: {
      'Content-Type': contentTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename=\"${filename}\"`
    }
  });
}

async function teacherOwnsClass(teacherId, classId) {
  if (!classId) return false;
  return Boolean(await Class.exists({ _id: classId, teacher: teacherId }));
}

async function canAccessPrivateFile(user, file) {
  if (user.role === 'admin' || String(file.uploadedBy) === String(user._id)) {
    return true;
  }

  if (file.type === 'submissions') {
    const submission = await Submission.findOne({
      $or: [{ file: file._id }, { files: file._id }]
    }).select('student class').lean();
    if (submission) {
      if (user.role === 'student') return String(submission.student) === String(user._id);
      if (user.role === 'teacher') return teacherOwnsClass(user._id, submission.class);
    }

    const ocrUpload = await OcrUpload.findOne({ file: file._id }).select('student').lean();
    return Boolean(user.role === 'student' && ocrUpload && String(ocrUpload.student) === String(user._id));
  }

  if (file.type === 'feedback') {
    const feedback = await Feedback.findOne({ file: file._id }).select('teacher student').lean();
    if (!feedback) return false;
    if (user.role === 'teacher') return String(feedback.teacher) === String(user._id);
    if (user.role === 'student') return String(feedback.student) === String(user._id);
  }

  return false;
}

async function servePrivateFile(req, res, next) {
  try {
    const filename = req.params && req.params.filename;
    const type = req.params && req.params.type;
    if (!['assignments', 'submissions', 'feedback'].includes(String(type)) || !isSafeStoredFilename(filename)) {
      throw new ApiError(400, 'Invalid file request');
    }

    const file = await File.findOne({ type, filename });
    if (!file) throw new ApiError(404, 'File not found');
    if (!req.user) throw new ApiError(401, 'Unauthorized');
    if (!(await canAccessPrivateFile(req.user, file))) throw new ApiError(403, 'Forbidden');

    return sendStoredFile(res, type, filename);
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

async function serveOriginal(req, res, next) {
  try {
    const filename = req.params && req.params.filename;
    if (!isSafeStoredFilename(filename)) {
      throw new ApiError(400, 'Invalid filename');
    }

    const doc = await Upload.findOne({ originalFilename: filename });
    if (!doc || !doc.originalFilePath) {
      throw new ApiError(404, 'File not found');
    }

    const user = req.user;
    if (!user) {
      throw new ApiError(401, 'Unauthorized');
    }

    if (user.role === 'student') {
      if (String(doc.studentId) !== String(user._id)) {
        throw new ApiError(403, 'Forbidden');
      }
    } else if (user.role === 'teacher') {
      const assignment = await Assignment.findOne({ _id: doc.assignmentId, isActive: true });
      if (!assignment) {
        throw new ApiError(404, 'Assignment not found');
      }
      await uploadService.assertTeacherOwnsClassOrThrow(user._id, assignment.class);
    } else {
      throw new ApiError(403, 'Forbidden');
    }

    return sendStoredFile(res, 'original', filename);
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

async function serveProcessed(req, res, next) {
  try {
    const filename = req.params && req.params.filename;
    if (!isSafeStoredFilename(filename)) {
      throw new ApiError(400, 'Invalid filename');
    }

    const doc = await Upload.findOne({ processedFilename: filename });
    if (!doc || !doc.processedFilePath) {
      throw new ApiError(404, 'File not found');
    }

    const user = req.user;
    if (!user) {
      throw new ApiError(401, 'Unauthorized');
    }

    if (user.role === 'student') {
      if (String(doc.studentId) !== String(user._id)) {
        throw new ApiError(403, 'Forbidden');
      }
    } else if (user.role === 'teacher') {
      if (!doc.submissionId) {
        throw new ApiError(403, 'Forbidden');
      }
      const submission = await Submission.findById(doc.submissionId);
      if (!submission) {
        throw new ApiError(404, 'Submission not found');
      }
      await uploadService.assertTeacherOwnsClassOrThrow(user._id, submission.class);
    } else {
      throw new ApiError(403, 'Forbidden');
    }

    return sendStoredFile(res, 'processed', filename);
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

module.exports = {
  servePrivateFile,
  serveOriginal,
  serveProcessed
};
