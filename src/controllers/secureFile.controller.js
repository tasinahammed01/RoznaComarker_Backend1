const path = require('path');

const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const Upload = require('../models/Upload');

const logger = require('../utils/logger');
const uploadService = require('../services/upload.service');
const { ApiError } = require('../middlewares/error.middleware');

function isSafeStoredFilename(filename) {
  const value = String(filename || '');
  if (value !== path.basename(value)) return false;
  return /^[0-9a-fA-F-]{36}\.(pdf|jpg|png)$/.test(value);
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

    const absolute = uploadService.getAbsolutePathForStoredFile('original', filename);

    return res.sendFile(absolute, {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename=\"${filename}\"`
      }
    });
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

    const absolute = uploadService.getAbsolutePathForStoredFile('processed', filename);

    return res.sendFile(absolute, {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename=\"${filename}\"`
      }
    });
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

module.exports = {
  serveOriginal,
  serveProcessed
};
