const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const File = require('../models/File');
const OcrUpload = require('../models/OcrUpload');

const uploadService = require('../services/upload.service');
const { runOcrAndPersist } = require('../services/ocrPipeline.service');
const { normalizeOcrWordsFromStored, buildOcrCorrections } = require('../services/ocrCorrections.service');

const { bytesToMB, ensureActivePlan, incrementUsage } = require('../middlewares/usage.middleware');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

async function uploadHandwrittenForOcr(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const persisted = await persistUploadedFile(req, 'submissions');
    if (persisted.error) {
      return res.status(persisted.error.statusCode).json({
        success: false,
        message: persisted.error.message
      });
    }

    const doc = await OcrUpload.create({
      student: studentId,
      file: persisted.fileDoc._id,
      fileUrl: persisted.url,
      originalName: req.file && req.file.originalname ? String(req.file.originalname) : undefined,
      ocrStatus: 'pending',
      ocrUpdatedAt: new Date()
    });

    await runOcrAndPersist({ fileId: persisted.fileDoc._id, targetDoc: doc });

    return res.json({
      success: true,
      fileUrl: doc.fileUrl,
      submissionId: String(doc._id),
      ocrStatus: doc.ocrStatus,
      ocrText: doc.ocrText || '',
      ocrError: doc.ocrError || ''
    });
  } catch (err) {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Upload failed'
        : (err && err.message ? String(err.message) : 'Upload failed');

    return res.status(500).json({
      success: false,
      message
    });
  }
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function getRequestBaseUrl(req) {
  const raw = `${req.protocol}://${req.get('host')}`;
  return raw.replace(/\/+$/, '');
}

function normalizePublicUploadsUrlForDev(req, url) {
  if (!url) return url;
  if (process.env.NODE_ENV === 'production') return url;

  const raw = String(url);
  const marker = '/uploads/';
  const idx = raw.indexOf(marker);
  if (idx < 0) return raw;

  const pathPart = raw.slice(idx);
  return `${getRequestBaseUrl(req)}${pathPart}`;
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

      existing.ocrStatus = 'pending';
      existing.ocrText = undefined;
      existing.ocrError = undefined;
      existing.ocrData = undefined;
      existing.ocrUpdatedAt = new Date();

      const saved = await existing.save();

      await incrementUsage(studentId, { storageMB: uploadedMB });

      setImmediate(() => {
        runOcrAndPersist({ fileId: persisted.fileDoc._id, targetDoc: saved }).catch(() => {});
      });

      const populated = await Submission.findById(saved._id)
        .populate('student', '_id email displayName photoURL role')
        .populate({
          path: 'assignment',
          populate: { path: 'teacher', select: '_id email displayName' }
        })
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
      qrToken,
      ocrStatus: 'pending',
      ocrUpdatedAt: new Date()
    });

    await incrementUsage(studentId, { submissions: 1, storageMB: uploadedMB });

    setImmediate(() => {
      runOcrAndPersist({ fileId: persisted.fileDoc._id, targetDoc: created }).catch(() => {});
    });

    const populated = await Submission.findById(created._id)
      .populate('student', '_id email displayName photoURL role')
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: '_id email displayName' }
      })
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
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: '_id email displayName' }
      })
      .populate('class')
      .populate('file');

    for (const s of submissions) {
      if (s && typeof s.fileUrl === 'string') {
        s.fileUrl = normalizePublicUploadsUrlForDev(req, s.fileUrl);
      }
    }

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
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: '_id email displayName' }
      })
      .populate('class')
      .populate('file')
      .populate('student', '_id email displayName photoURL role');

    if (!submission) {
      return sendSuccess(res, null);
    }

    if (submission && typeof submission.fileUrl === 'string') {
      submission.fileUrl = normalizePublicUploadsUrlForDev(req, submission.fileUrl);
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
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: '_id email displayName' }
      })
      .populate('class')
      .populate('file');

    for (const s of submissions) {
      if (s && typeof s.fileUrl === 'string') {
        s.fileUrl = normalizePublicUploadsUrlForDev(req, s.fileUrl);
      }
    }

    return sendSuccess(res, submissions);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submissions');
  }
}

async function getOcrCorrections(req, res) {
  try {
    const submissionId = req.params && req.params.submissionId;
    const user = req.user;

    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    let doc = await Submission.findById(submissionId);
    let kind = 'submission';
    if (!doc) {
      doc = await OcrUpload.findById(submissionId);
      kind = 'ocr_upload';
    }

    if (!doc) {
      return sendSuccess(res, { corrections: [], ocr: [] });
    }

    if (user.role === 'student') {
      if (String(doc.student) !== String(user._id)) {
        return sendError(res, 403, 'Forbidden');
      }
    } else if (user.role === 'teacher') {
      if (kind !== 'submission') {
        return sendError(res, 403, 'Forbidden');
      }
      await uploadService.assertTeacherOwnsClassOrThrow(user._id, doc.class);
    } else {
      return sendError(res, 403, 'Forbidden');
    }

    const ocrDataWords = doc && doc.ocrData && typeof doc.ocrData === 'object' ? doc.ocrData.words : null;
    const needsOcr = !ocrDataWords || !Array.isArray(ocrDataWords) || ocrDataWords.length === 0;

    if (needsOcr) {
      if (!doc.file) {
        return sendSuccess(res, { corrections: [], ocr: [], ocrStatus: doc.ocrStatus || null, ocrError: doc.ocrError || null });
      }

      await runOcrAndPersist({ fileId: doc.file, targetDoc: doc });

      if (doc.ocrStatus === 'failed') {
        return sendSuccess(res, {
          corrections: [],
          ocr: [],
          ocrStatus: doc.ocrStatus || null,
          ocrError: doc.ocrError || null
        });
      }
    }

    const normalizedWords = normalizeOcrWordsFromStored(doc.ocrData && doc.ocrData.words);

    const built = await buildOcrCorrections({
      text: doc.ocrText || '',
      language: 'en-US',
      ocrWords: normalizedWords
    });

    return sendSuccess(res, {
      corrections: built.corrections,
      ocr: built.ocr,
      ocrStatus: doc.ocrStatus || null,
      ocrError: doc.ocrError || null
    });
  } catch (err) {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Failed to fetch OCR corrections'
        : (err && err.message ? String(err.message) : 'Failed to fetch OCR corrections');

    return sendError(res, 500, message);
  }
}

module.exports = {
  submitByAssignmentId,
  submitByQrToken,
  getSubmissionsByAssignment,
  getMySubmissions,
  getMySubmissionByAssignmentId,
  getOcrCorrections,
  uploadHandwrittenForOcr
};
