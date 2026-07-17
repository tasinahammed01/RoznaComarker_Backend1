const path = require('path');

const File = require('../models/File');

const { bytesToMB, incrementUsage } = require('../middlewares/usage.middleware');
const { buildPublicUploadUrl } = require('../utils/publicApiUrl');

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function toPublicUrl(req, type, filename) {
  return buildPublicUploadUrl(req, type, filename);
}

function toStoredPath(type, filename) {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.posix.join(basePath, type, filename);
}

async function persistAndRespond(req, res, type) {
  try {
    const userId = req.user && req.user._id;
    const role = req.user && req.user.role;

    if (!userId || !role) {
      return sendError(res, 401, 'Unauthorized');
    }

    const file = req.file;
    if (!file) {
      return sendError(res, 400, 'No file provided');
    }

    const storedPath = toStoredPath(type, file.filename);
    const url = toPublicUrl(req, type, file.filename);

    await File.create({
      originalName: file.originalname,
      filename: file.filename,
      path: storedPath,
      url,
      uploadedBy: userId,
      role,
      type
    });

    const uploadedMB =
      typeof req.uploadSizeMB === 'number'
        ? req.uploadSizeMB
        : bytesToMB(file.size);

    await incrementUsage(userId, { storageMB: uploadedMB });

    return res.json({
      originalName: file.originalname,
      filename: file.filename,
      path: storedPath,
      url
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to upload file');
  }
}

async function uploadAssignmentFile(req, res) {
  return persistAndRespond(req, res, 'assignments');
}

async function uploadSubmissionFile(req, res) {
  return persistAndRespond(req, res, 'submissions');
}

async function uploadFeedbackFile(req, res) {
  return persistAndRespond(req, res, 'feedback');
}

module.exports = {
  uploadAssignmentFile,
  uploadSubmissionFile,
  uploadFeedbackFile
};
