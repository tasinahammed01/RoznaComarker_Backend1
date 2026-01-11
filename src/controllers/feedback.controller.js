const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const File = require('../models/File');

const { bytesToMB, incrementUsage } = require('../middlewares/usage.middleware');

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

function normalizeOptionalNumber(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'string' && !value.trim().length) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function normalizeAnnotations(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return normalizeAnnotations(parsed);
    } catch (err) {
      return { error: 'annotations must be valid JSON array' };
    }
  }

  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return { error: 'annotations must be an array' };
  }

  const normalized = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return { error: 'annotations must be an array of objects' };
    }

    const page = typeof item.page === 'number' ? item.page : Number(item.page);
    if (!Number.isFinite(page)) {
      return { error: 'annotations.page must be a number' };
    }

    const comment = normalizeOptionalString(item.comment);
    if (comment === null || typeof comment === 'undefined') {
      return { error: 'annotations.comment is required' };
    }

    const x = typeof item.x === 'number' ? item.x : Number(item.x);
    if (!Number.isFinite(x)) {
      return { error: 'annotations.x must be a number' };
    }

    const y = typeof item.y === 'number' ? item.y : Number(item.y);
    if (!Number.isFinite(y)) {
      return { error: 'annotations.y must be a number' };
    }

    normalized.push({
      page,
      comment,
      x,
      y
    });
  }

  return {
    value: normalized
  };
}

async function persistUploadedFile(req, type) {
  const userId = req.user && req.user._id;
  const role = req.user && req.user.role;

  if (!userId || !role) {
    return { error: { statusCode: 401, message: 'Unauthorized' } };
  }

  const file = req.file;
  if (!file) {
    return { fileDoc: undefined, url: undefined };
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

async function populateFeedback(feedbackId) {
  return Feedback.findById(feedbackId)
    .populate('teacher', '_id email displayName photoURL role')
    .populate('student', '_id email displayName photoURL role')
    .populate('class')
    .populate('assignment')
    .populate('submission')
    .populate('file');
}

function validateScoreFields({ score, maxScore }) {
  if (typeof maxScore !== 'undefined' && maxScore !== null) {
    if (maxScore <= 0) {
      return 'maxScore must be greater than 0';
    }
  }

  if (typeof score !== 'undefined' && score !== null && typeof maxScore !== 'undefined' && maxScore !== null) {
    if (score > maxScore) {
      return 'score cannot be greater than maxScore';
    }
  }

  return null;
}

async function createFeedback(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    const classDoc = await Class.findOne({
      _id: submission.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'Not class teacher');
    }

    const assignment = await Assignment.findOne({
      _id: submission.assignment,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    if (String(assignment.class) !== String(submission.class)) {
      return sendError(res, 400, 'Submission does not belong to assignment class');
    }

    const existing = await Feedback.findOne({ submission: submission._id });
    if (existing) {
      return sendError(res, 409, 'Feedback already exists');
    }

    const textFeedback = normalizeOptionalString(req.body && req.body.textFeedback);
    if (textFeedback === null) {
      return sendError(res, 400, 'textFeedback must be a string');
    }

    const score = normalizeOptionalNumber(req.body && req.body.score);
    if (score === null) {
      return sendError(res, 400, 'score must be a number');
    }

    const maxScore = normalizeOptionalNumber(req.body && req.body.maxScore);
    if (maxScore === null) {
      return sendError(res, 400, 'maxScore must be a number');
    }

    const scoreError = validateScoreFields({ score, maxScore });
    if (scoreError) {
      return sendError(res, 400, scoreError);
    }

    const annotationsResult = normalizeAnnotations(req.body && req.body.annotations);
    if (annotationsResult && annotationsResult.error) {
      return sendError(res, 400, annotationsResult.error);
    }

    const persisted = await persistUploadedFile(req, 'feedback');
    if (persisted.error) {
      return sendError(res, persisted.error.statusCode, persisted.error.message);
    }

    if (persisted.fileDoc) {
      const uploadedMB =
        typeof req.uploadSizeMB === 'number'
          ? req.uploadSizeMB
          : bytesToMB(req.file && req.file.size);
      await incrementUsage(teacherId, { storageMB: uploadedMB });
    }

    try {
      const created = await Feedback.create({
        teacher: teacherId,
        student: submission.student,
        class: submission.class,
        assignment: submission.assignment,
        submission: submission._id,
        textFeedback,
        score,
        maxScore,
        annotations: annotationsResult ? annotationsResult.value : undefined,
        file: persisted.fileDoc ? persisted.fileDoc._id : undefined,
        fileUrl: persisted.url
      });

      await Submission.updateOne(
        { _id: submission._id, $or: [{ feedback: { $exists: false } }, { feedback: null }] },
        { $set: { feedback: created._id } }
      );

      const populated = await populateFeedback(created._id);
      return sendSuccess(res, populated);
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern && err.keyPattern.submission) {
        return sendError(res, 409, 'Feedback already exists');
      }

      return sendError(res, 500, 'Failed to create feedback');
    }
  } catch (err) {
    return sendError(res, 500, 'Failed to create feedback');
  }
}

async function updateFeedback(req, res) {
  try {
    const { feedbackId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(feedbackId)) {
      return sendError(res, 400, 'Invalid feedback id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const classDoc = await Class.findOne({
      _id: feedback.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'Not class teacher');
    }

    const textFeedback = normalizeOptionalString(req.body && req.body.textFeedback);
    if (textFeedback === null) {
      return sendError(res, 400, 'textFeedback must be a string');
    }

    const score = normalizeOptionalNumber(req.body && req.body.score);
    if (score === null) {
      return sendError(res, 400, 'score must be a number');
    }

    const maxScore = normalizeOptionalNumber(req.body && req.body.maxScore);
    if (maxScore === null) {
      return sendError(res, 400, 'maxScore must be a number');
    }

    const nextScore = typeof score === 'undefined' ? feedback.score : score;
    const nextMaxScore = typeof maxScore === 'undefined' ? feedback.maxScore : maxScore;

    const scoreError = validateScoreFields({ score: nextScore, maxScore: nextMaxScore });
    if (scoreError) {
      return sendError(res, 400, scoreError);
    }

    const annotationsResult = normalizeAnnotations(req.body && req.body.annotations);
    if (annotationsResult && annotationsResult.error) {
      return sendError(res, 400, annotationsResult.error);
    }

    const persisted = await persistUploadedFile(req, 'feedback');
    if (persisted.error) {
      return sendError(res, persisted.error.statusCode, persisted.error.message);
    }

    if (persisted.fileDoc) {
      const uploadedMB =
        typeof req.uploadSizeMB === 'number'
          ? req.uploadSizeMB
          : bytesToMB(req.file && req.file.size);
      await incrementUsage(teacherId, { storageMB: uploadedMB });
    }

    if (typeof textFeedback !== 'undefined') {
      feedback.textFeedback = textFeedback;
    }

    if (typeof score !== 'undefined') {
      feedback.score = score;
    }

    if (typeof maxScore !== 'undefined') {
      feedback.maxScore = maxScore;
    }

    if (typeof annotationsResult !== 'undefined') {
      feedback.annotations = annotationsResult ? annotationsResult.value : undefined;
    }

    if (persisted.fileDoc) {
      feedback.file = persisted.fileDoc._id;
      feedback.fileUrl = persisted.url;
    }

    await feedback.save();

    const populated = await populateFeedback(feedback._id);
    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to update feedback');
  }
}

async function getFeedbackBySubmissionForStudent(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    if (String(submission.student) !== String(studentId)) {
      return sendError(res, 403, 'No permission');
    }

    const feedback = await Feedback.findOne({ submission: submission._id });
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const populated = await populateFeedback(feedback._id);
    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

async function getFeedbackByIdForTeacher(req, res) {
  try {
    const { feedbackId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(feedbackId)) {
      return sendError(res, 400, 'Invalid feedback id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const classDoc = await Class.findOne({
      _id: feedback.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'No permission');
    }

    const populated = await populateFeedback(feedback._id);
    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

module.exports = {
  createFeedback,
  updateFeedback,
  getFeedbackBySubmissionForStudent,
  getFeedbackByIdForTeacher
};
