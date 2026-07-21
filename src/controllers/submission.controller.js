const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const File = require('../models/File');
const OcrUpload = require('../models/OcrUpload');
const SubmissionFeedback = require('../models/SubmissionFeedback');

const uploadService = require('../services/upload.service');
const { runOcrAndPersist, runOcrAndPersistForFiles } = require('../services/ocrPipeline.service');
const { normalizeOcrWordsFromStored } = require('../services/ocrCorrections.service');
const { buildSubmissionCorrectionStatistics } = require('../services/submissionCorrectionStatistics.service');
const { autoGenerateRubricDesignerForSubmission } = require('../services/autoRubricDesigner.service');
const canonicalCorrectionsPipeline = require('../services/canonicalCorrectionsPipeline.service');
const { buildCanonicalResultState } = require('../services/canonicalResultState.service');
const {
  normalizeOcrTranscript,
  getNormalizedSubmissionTranscript,
  buildCanonicalSubmissionTranscript,
  withNormalizedWordSeparators
} = require('../utils/ocrTranscriptNormalizer');

const { createNotification } = require('../services/notification.service');
const logger = require('../utils/logger');

const { bytesToMB, ensureActivePlan, incrementUsage } = require('../middlewares/usage.middleware');
const { getPublicApiUrl, buildPublicUploadUrl } = require('../utils/publicApiUrl');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function hasValidOcrPages(doc) {
  return Array.isArray(doc && doc.ocrPages) && doc.ocrPages.some((page) =>
    page && ((Array.isArray(page.words) && page.words.length > 0) ||
      (typeof page.text === 'string' && page.text.trim().length > 0))
  );
}

function hasValidLegacyOcrWords(doc) {
  const words = doc && doc.ocrData && typeof doc.ocrData === 'object' ? doc.ocrData.words : null;
  return Array.isArray(words) && words.length > 0;
}

function hasUsableOcrData(doc) {
  return hasValidOcrPages(doc) || hasValidLegacyOcrWords(doc) ||
    ['ocrText', 'combinedOcrText', 'transcriptText'].some((key) =>
      typeof doc?.[key] === 'string' && doc[key].trim().length > 0
    );
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

    // This endpoint is used for ad-hoc OCR uploads.
    // Keep legacy behavior by using the first uploaded file.
    if (!req.file && Array.isArray(req.files) && req.files.length) {
      req.file = req.files[0];
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
  return getPublicApiUrl(req);
}

function normalizePublicUploadsUrlForDev(req, url) {
  if (!url) return url;
  if (process.env.NODE_ENV === 'production') return url;

  const raw = String(url);
  const marker = '/uploads/';
  const idx = raw.indexOf(marker);
  if (idx < 0) return raw;

  const pathPart = raw.slice(idx);

  // In dev the backend may be behind a proxy / have an internal host (e.g. 172.x)
  // while clients must use a public BASE_URL. Prefer BASE_URL when available.
  const base = getRequestBaseUrl(req);
  return `${base}${pathPart}`;
}

function normalizeSubmissionForClient(req, submission) {
  if (!submission) return submission;

  const doc = submission;

  const legacyFileId = doc.file;
  const legacyUrl = typeof doc.fileUrl === 'string' ? doc.fileUrl : '';

  const files = Array.isArray(doc.files) ? doc.files.filter(Boolean) : [];
  const fileUrls = Array.isArray(doc.fileUrls) ? doc.fileUrls.filter(Boolean) : [];

  if (!files.length && legacyFileId) {
    doc.files = [legacyFileId];
  }

  if (!fileUrls.length && legacyUrl) {
    doc.fileUrls = [legacyUrl];
  }

  if ((!doc.fileUrl || typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()) && Array.isArray(doc.fileUrls) && doc.fileUrls.length) {
    doc.fileUrl = String(doc.fileUrls[0] || '');
  }

  const combinedCandidate = getNormalizedSubmissionTranscript(doc);

  if (doc.transcriptText) doc.transcriptText = normalizeOcrTranscript(doc.transcriptText);
  if (doc.ocrText) doc.ocrText = normalizeOcrTranscript(doc.ocrText);
  if (doc.combinedOcrText) doc.combinedOcrText = normalizeOcrTranscript(doc.combinedOcrText);
  if (Array.isArray(doc.ocrPages)) {
    for (const page of doc.ocrPages) {
      if (!page) continue;
      if (typeof page.text === 'string') page.text = normalizeOcrTranscript(page.text);
      if (Array.isArray(page.words)) page.words = withNormalizedWordSeparators(page.words);
    }
  }

  if (!doc.combinedOcrText || !String(doc.combinedOcrText).trim()) {
    doc.combinedOcrText = combinedCandidate;
  }

  const hasPages = Array.isArray(doc.ocrPages) && doc.ocrPages.length;
  const legacyWords = doc.ocrData && typeof doc.ocrData === 'object' ? doc.ocrData.words : null;
  if (!hasPages && Array.isArray(legacyWords) && legacyWords.length) {
    doc.ocrPages = [
      {
        fileId: Array.isArray(doc.files) && doc.files.length ? doc.files[0] : undefined,
        pageNumber: 1,
        text: String(doc.ocrText || ''),
        words: legacyWords
      }
    ];
  }
  if (Array.isArray(doc.ocrPages)) {
    for (const page of doc.ocrPages) {
      if (page && Array.isArray(page.words)) page.words = withNormalizedWordSeparators(page.words);
    }
  }

  // Validate file existence before normalizing URLs
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  const uploadsRoot = path.join(__dirname, '..', '..', basePath);

  const extractFilename = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const withoutQuery = rawUrl.split('#')[0].split('?')[0];
    const last = withoutQuery.split('/').pop();
    if (!last) return null;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  };

  const normalizeFileDocUrlIfExists = (fileDoc) => {
    if (!fileDoc || typeof fileDoc !== 'object') return null;
    const rawUrl = typeof fileDoc.url === 'string' ? fileDoc.url : '';
    const filenameFromUrl = extractFilename(rawUrl);

    const filename = filenameFromUrl
      ? filenameFromUrl
      : (typeof fileDoc.filename === 'string' && fileDoc.filename.trim() ? fileDoc.filename.trim() : null);

    if (!filename) return null;
    const filePath = path.join(uploadsRoot, 'submissions', filename);
    if (!fs.existsSync(filePath)) return null;

    if (rawUrl) {
      fileDoc.url = normalizePublicUploadsUrlForDev(req, rawUrl);
    } else {
      fileDoc.url = toPublicUrl(req, 'submissions', filename);
    }

    return fileDoc;
  };

  if (Array.isArray(doc.fileUrls)) {
    doc.fileUrls = doc.fileUrls
      .filter((u) => {
        const filename = extractFilename(u);
        if (!filename) return false;
        const filePath = path.join(uploadsRoot, 'submissions', filename);
        return fs.existsSync(filePath);
      })
      .map((u) => normalizePublicUploadsUrlForDev(req, u));
  }

  if (Array.isArray(doc.files)) {
    doc.files = doc.files
      .map((f) => {
        if (!f || typeof f !== 'object') return f;
        return normalizeFileDocUrlIfExists(f) || null;
      })
      .filter(Boolean);
  }

  if (doc.file && typeof doc.file === 'object') {
    doc.file = normalizeFileDocUrlIfExists(doc.file) || doc.file;
  }

  if (typeof doc.fileUrl === 'string') {
    const filename = extractFilename(doc.fileUrl);
    if (filename) {
      const filePath = path.join(uploadsRoot, 'submissions', filename);
      if (fs.existsSync(filePath)) {
        doc.fileUrl = normalizePublicUploadsUrlForDev(req, doc.fileUrl);
      } else {
        doc.fileUrl = undefined;
      }
    } else {
      doc.fileUrl = undefined;
    }
  }

  return doc;
}

function toPublicUrl(req, type, filename) {
  return buildPublicUploadUrl(req, type, filename);
}

function toStoredPath(type, filename) {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.posix.join(basePath, type, filename);
}

async function persistUploadedFile(req, type, providedFile) {
  const userId = req.user && req.user._id;
  const role = req.user && req.user.role;

  if (!userId || !role) {
    return { error: { statusCode: 401, message: 'Unauthorized' } };
  }

  const file = providedFile || req.file;
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

async function persistUploadedFiles(req, type) {
  const list = Array.isArray(req.files) ? req.files : [];
  if (!list.length) {
    // allow legacy single-file
    const single = req.file;
    if (!single) return { error: { statusCode: 400, message: 'No file provided' } };
    const one = await persistUploadedFile(req, type, single);
    if (one.error) return one;
    return { files: [one.fileDoc], urls: [one.url] };
  }

  const fileDocs = [];
  const urls = [];
  for (const f of list) {
    const persisted = await persistUploadedFile(req, type, f);
    if (persisted.error) {
      return persisted;
    }
    fileDocs.push(persisted.fileDoc);
    urls.push(persisted.url);
  }

  return { files: fileDocs, urls };
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

  const persistedMulti = await persistUploadedFiles(req, 'submissions');
  if (persistedMulti.error) {
    return sendError(res, persistedMulti.error.statusCode, persistedMulti.error.message);
  }

  const persistedFiles = Array.isArray(persistedMulti.files) ? persistedMulti.files : [];
  const persistedUrls = Array.isArray(persistedMulti.urls) ? persistedMulti.urls : [];

  const firstFile = persistedFiles.length ? persistedFiles[0] : null;
  const firstUrl = persistedUrls.length ? persistedUrls[0] : '';

  const uploadedMB =
    typeof req.uploadSizeMB === 'number'
      ? req.uploadSizeMB
      : bytesToMB(req.file && req.file.size);

  try {
    if (existing) {
      if (firstFile) {
        existing.file = firstFile._id;
      }
      if (firstUrl) {
        existing.fileUrl = firstUrl;
      }

      existing.files = persistedFiles.map((f) => f._id);
      existing.fileUrls = persistedUrls;
      existing.status = status;
      existing.submittedAt = now;
      existing.isLate = isLate;
      existing.qrToken = qrToken;

      existing.ocrStatus = 'pending';
      existing.ocrJobId = new mongoose.Types.ObjectId().toString();
      existing.ocrText = undefined;
      existing.rawOcrText = undefined;
      existing.rawCombinedOcrText = undefined;
      existing.ocrError = undefined;
      existing.ocrData = undefined;
      existing.ocrPages = [];
      existing.combinedOcrText = undefined;
      existing.transcriptText = undefined;
      existing.writingCorrections = [];
      existing.correctionStatistics = undefined;
      existing.correctionStatus = 'pending';
      existing.correctionSourceHash = undefined;
      existing.correctionVersion = undefined;
      existing.correctionTranscriptLayoutVersion = undefined;
      existing.correctionError = undefined;
      existing.correctionJobId = undefined;
      existing.semanticSourceKey = undefined;
      existing.semanticProvider = undefined;
      existing.semanticModel = undefined;
      existing.semanticPromptVersion = undefined;
      existing.semanticMetrics = undefined;
      existing.evaluationStatus = 'pending';
      existing.evaluationJobId = undefined;
      existing.evaluationSourceHash = undefined;
      existing.evaluationVersion = undefined;
      existing.evaluationRubricSourceHash = undefined;
      existing.evaluationError = undefined;
      existing.rawTranscriptText = undefined;
      existing.correctionStatistics = undefined;
      existing.ocrUpdatedAt = new Date();

      const saved = await existing.save();

      await incrementUsage(studentId, { storageMB: uploadedMB });

      setImmediate(() => {
        const ids = Array.isArray(saved.files) && saved.files.length
          ? saved.files
          : (firstFile ? [firstFile._id] : []);

        const ocrPromise = ids.length
          ? runOcrAndPersistForFiles({ fileIds: ids, targetDoc: saved, jobId: saved.ocrJobId })
          : Promise.resolve();

        ocrPromise
          .then(() => {
            // Auto-generate rubric after OCR completes
            autoGenerateRubricDesignerForSubmission({ submissionId: saved._id })
              .catch(() => {}); // Ignore errors, don't block upload
          })
          .catch(() => {});
      });

      const populated = await Submission.findById(saved._id)
        .populate('student', '_id email displayName photoURL role')
        .populate({
          path: 'assignment',
          populate: { path: 'teacher', select: '_id email displayName' }
        })
        .populate('class')
        .populate('file')
        .populate('files');

      // Notify teacher (fire-and-forget)
      setImmediate(async () => {
        try {
          const teacherId = populated?.assignment?.teacher?._id;
          const studentDisplay = populated?.student
            ? String(populated.student.displayName || populated.student.email || 'Student')
            : 'Student';
          const assignmentTitle = populated?.assignment
            ? String(populated.assignment.title || 'Assignment')
            : 'Assignment';

          if (teacherId) {
            await createNotification({
              recipientId: teacherId,
              actorId: studentId,
              type: 'assignment_submitted',
              title: 'Assignment submitted',
              description: `${studentDisplay} submitted ${assignmentTitle}`,
              data: {
                classId: String(populated?.class?._id || ''),
                assignmentId: String(populated?.assignment?._id || ''),
                submissionId: String(populated?._id || ''),
                studentId: String(populated?.student?._id || ''),
                route: {
                  path: '/teacher/my-classes/detail/student-submissions',
                  params: [String(populated?.student?._id || '')],
                  queryParams: {
                    classId: String(populated?.class?._id || ''),
                    assignmentId: String(populated?.assignment?._id || ''),
                    submissionId: String(populated?._id || '')
                  }
                }
              }
            });
          }
        } catch {
          // ignore
        }
      });

      return sendSuccess(res, populated);
    }

    const created = await Submission.create({
      student: studentId,
      assignment: assignment._id,
      class: classDoc._id,
      file: firstFile ? firstFile._id : undefined,
      fileUrl: firstUrl || undefined,
      files: persistedFiles.map((f) => f._id),
      fileUrls: persistedUrls,
      status,
      submittedAt: now,
      isLate,
      qrToken,
      ocrStatus: 'pending',
      ocrJobId: new mongoose.Types.ObjectId().toString(),
      ocrUpdatedAt: new Date()
    });

    await incrementUsage(studentId, { submissions: 1, storageMB: uploadedMB });

    setImmediate(() => {
      const ids = Array.isArray(created.files) && created.files.length
        ? created.files
        : (firstFile ? [firstFile._id] : []);

      const ocrPromise = ids.length
        ? runOcrAndPersistForFiles({ fileIds: ids, targetDoc: created, jobId: created.ocrJobId })
        : Promise.resolve();

      ocrPromise
        .then(() => {
          // Auto-generate rubric after OCR completes
          autoGenerateRubricDesignerForSubmission({ submissionId: created._id })
            .catch(() => {}); // Ignore errors, don't block upload
        })
        .catch(() => {});
    });

    const populated = await Submission.findById(created._id)
      .populate('student', '_id email displayName photoURL role')
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: '_id email displayName' }
      })
      .populate('class')
      .populate('file')
      .populate('files');

    // Notify teacher (fire-and-forget)
    setImmediate(async () => {
      try {
        const teacherId = populated?.assignment?.teacher?._id;
        const studentDisplay = populated?.student
          ? String(populated.student.displayName || populated.student.email || 'Student')
          : 'Student';
        const assignmentTitle = populated?.assignment
          ? String(populated.assignment.title || 'Assignment')
          : 'Assignment';

        if (teacherId) {
          await createNotification({
            recipientId: teacherId,
            actorId: studentId,
            type: 'assignment_submitted',
            title: 'Assignment submitted',
            description: `${studentDisplay} submitted ${assignmentTitle}`,
            data: {
              classId: String(populated?.class?._id || ''),
              assignmentId: String(populated?.assignment?._id || ''),
              submissionId: String(populated?._id || ''),
              studentId: String(populated?.student?._id || ''),
              route: {
                path: '/teacher/my-classes/detail/student-submissions',
                params: [String(populated?.student?._id || '')],
                queryParams: {
                  classId: String(populated?.class?._id || ''),
                  assignmentId: String(populated?.assignment?._id || ''),
                  submissionId: String(populated?._id || '')
                }
              }
            }
          });
        }
      } catch {
        // ignore
      }
    });

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
      .populate('file')
      .populate('files');

    for (const s of submissions) {
      normalizeSubmissionForClient(req, s);
      // Compute canonical correction statistics for consistency with Student view
      const correctionStatistics = await buildSubmissionCorrectionStatistics(s);
      s.correctionStatistics = correctionStatistics;
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
      .populate('files')
      .populate('student', '_id email displayName photoURL role');

    if (!submission) {
      return sendSuccess(res, null);
    }

    normalizeSubmissionForClient(req, submission);

    // Compute canonical correction statistics for consistency with Teacher view
    const correctionStatistics = await buildSubmissionCorrectionStatistics(submission);
    submission.correctionStatistics = correctionStatistics;

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
      .populate('file')
      .populate('files');

    for (const s of submissions) {
      normalizeSubmissionForClient(req, s);
      // Compute canonical correction statistics for consistency with Teacher view
      const correctionStatistics = await buildSubmissionCorrectionStatistics(s);
      s.correctionStatistics = correctionStatistics;
    }

    return sendSuccess(res, submissions);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submissions');
  }
}

async function getOcrCorrections(req, res) {
  let logContext = {};
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

    if (!doc) return sendError(res, 404, 'Submission not found');

    const requestedFileId = req.body && typeof req.body.fileId === 'string' ? String(req.body.fileId).trim() : '';
    logContext = {
      submissionId: String(submissionId),
      userId: String(user._id),
      role: user.role,
      fileId: requestedFileId || null,
      ocrStatus: doc.ocrStatus || null
    };

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

    const fileIds = Array.isArray(doc.files) && doc.files.length ? doc.files : (doc.file ? [doc.file] : []);
    if (requestedFileId && !fileIds.some((id) => String(id && id._id ? id._id : id) === requestedFileId)) {
      return sendError(res, 400, 'Invalid fileId for this submission');
    }

    if (doc.ocrStatus === 'pending' || doc.ocrStatus === 'processing') {
      return res.status(202).json({ success: true, data: {
        processing: true, ocrStatus: doc.ocrStatus || 'pending', corrections: [], ocr: [],
        processingActive: true, automaticPollingAllowed: true, manualRetryAllowed: false, terminal: false,
        ocrError: null, fileId: requestedFileId || null
      }});
    }
    if (doc.ocrStatus === 'failed') {
      return res.status(422).json({ success: false, message: 'OCR processing failed', data: {
        processing: false, ocrStatus: 'failed', ocrError: doc.ocrError || 'OCR could not process this upload.',
        fileId: requestedFileId || null
      }});
    }
    if (!hasUsableOcrData(doc)) {
      return res.status(409).json({ success: false, message: 'OCR data is not available', data: {
        processing: false, ocrStatus: doc.ocrStatus || null,
        ocrError: 'OCR completed without usable text. Please retry the upload.', fileId: requestedFileId || null
      }});
    }

    const hasRequestedFile = Boolean(requestedFileId);

    let pages = Array.isArray(doc.ocrPages) ? doc.ocrPages : [];
    let activePages = hasRequestedFile
      ? pages.filter((p) => p && p.fileId && String(p.fileId) === requestedFileId)
      : pages;

    if (hasRequestedFile && !activePages.length) {
      return res.status(409).json({ success: false, message: 'OCR data for the requested file is not available', data: {
        processing: false, ocrStatus: doc.ocrStatus || null,
        ocrError: 'The requested image has no persisted OCR page.', fileId: requestedFileId
      }});
    }

    const canonicalTranscript = buildCanonicalSubmissionTranscript(doc);
    const canonicalPages = hasRequestedFile
      ? canonicalTranscript.pages.filter((page) => page.fileId === requestedFileId)
      : canonicalTranscript.pages;
    const ocr = canonicalPages.map((p) => {
      const fileId = String(p.fileId || 'legacy');
      const words = normalizeOcrWordsFromStored(p.words || [], { fileId });
      const separators = new Map((p.words || []).map((word) => [word.id, word.separatorBefore || '']));
      return { pageNumber: Number(p.pageNumber || 1), fileId, width: null, height: null,
        words: words.map((w) => ({ id: w.id, fileId, text: w.text, bbox: w.bbox, separatorBefore: separators.get(w.id) || '' })), lines: [] };
    });
    const evaluationDoc = kind === 'submission' ? await SubmissionFeedback.findOne({ submissionId: doc._id }).lean() : null;
    const resultState = buildCanonicalResultState({ submission: doc, feedback: evaluationDoc });
    const hasCanonicalCorrections = resultState.correctionCurrent && Array.isArray(doc.writingCorrections);
    const allCorrections = hasCanonicalCorrections ? doc.writingCorrections : [];
    const corrections = hasRequestedFile ? allCorrections.filter((c) => String(c.fileId || '') === requestedFileId) : allCorrections;
    const statistics = resultState.statistics || (hasCanonicalCorrections ? require('../services/correctionCanonical.service').statistics(allCorrections) : null);
    const evaluationCurrent = resultState.evaluationCurrent;
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');

    return sendSuccess(res, {
      processing: false,
      corrections,
      ocr,
      ocrStatus: doc.ocrStatus || null,
      correctionStatus: resultState.correctionStatus,
      correctionStage: resultState.correctionStage,
      statisticsStatus: resultState.statisticsStatus,
      statisticsCompleteness: resultState.statisticsCompleteness,
      categoryAvailability: resultState.categoryAvailability,
      sourceCounts: resultState.sourceCounts,
      correctionErrorCode: resultState.correctionErrorCode,
      retryable: resultState.retryable,
      processingActive: resultState.processingActive,
      automaticPollingAllowed: resultState.automaticPollingAllowed,
      manualRetryAllowed: resultState.manualRetryAllowed,
      terminal: resultState.terminal,
      evaluationBlockedReason: resultState.evaluationBlockedReason,
      detailedFeedbackBlockedReason: resultState.detailedFeedbackBlockedReason,
      semanticStatus: resultState.semanticStatus,
      semanticAttempt: resultState.semanticAttempt,
      semanticMaxAttempts: resultState.semanticMaxAttempts,
      semanticNextRetryAt: resultState.semanticNextRetryAt,
      semanticErrorCode: resultState.semanticErrorCode,
      statistics,
      transcript: canonicalTranscript.text,
      transcriptPages: canonicalTranscript.pages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber,
        startChar: page.startChar, endChar: page.endChar, paragraphs: page.paragraphs || [] })),
      transcriptWordSpans: canonicalTranscript.wordSpans.map((span) => ({ wordId: span.wordId, fileId: span.fileId,
        page: span.page, start: span.start, end: span.end, separatorBefore: span.separatorBefore })),
      transcriptSeparators: canonicalTranscript.separators,
      transcriptSource: canonicalTranscript.source,
      transcriptComplete: canonicalTranscript.isComplete,
      transcriptLayoutVersion: canonicalTranscript.version,
      correctionCurrent: resultState.correctionCurrent,
      correctionSourceHash: resultState.correctionCurrent ? (doc.correctionSourceHash || null) : null,
      evaluationStatus: resultState.evaluationStatus,
      detailedFeedbackStatus: resultState.detailedFeedbackStatus,
      detailedFeedbackSourceHash: resultState.detailedFeedbackCurrent ? (evaluationDoc?.detailedFeedbackSourceHash || null) : null,
      detailedFeedbackVersion: resultState.detailedFeedbackCurrent ? (evaluationDoc?.detailedFeedbackVersion || null) : null,
      detailedFeedback: resultState.detailedFeedbackCurrent ? (evaluationDoc?.detailedFeedback || null) : null,
      overriddenByTeacher: Boolean(evaluationDoc?.overriddenByTeacher),
      evaluationSourceHash: evaluationCurrent ? (evaluationDoc?.evaluationSourceHash || doc.correctionSourceHash || null) : null,
      evaluation: evaluationCurrent ? { categoryScores: evaluationDoc.rubricScores || {}, overallScore: resultState.score, grade: resultState.grade,
        strengths: evaluationDoc.detailedFeedback?.strengths || [], areasForImprovement: evaluationDoc.detailedFeedback?.areasForImprovement || [],
        actionSteps: evaluationDoc.detailedFeedback?.actionSteps || [], source: evaluationDoc.evaluationSource || null } : null,
      ocrError: doc.ocrError || null,
      fileId: hasRequestedFile ? requestedFileId : null
    });
  } catch (err) {
    logger.error({ message: 'Failed to fetch OCR corrections', ...logContext, error: err?.message, stack: err?.stack });
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Failed to fetch OCR corrections'
        : (err && err.message ? String(err.message) : 'Failed to fetch OCR corrections');

    return sendError(res, 500, message);
  }
}

async function regenerateCanonicalCorrections(req, res) {
  try {
    const submission = await Submission.findById(req.params.submissionId);
    if (!submission) return sendError(res, 404, 'Submission not found');
    
    // Role-based authorization
    if (req.user.role === 'teacher') {
      await uploadService.assertTeacherOwnsClassOrThrow(req.user._id, submission.class);
    } else if (req.user.role === 'student') {
      if (String(submission.student) !== String(req.user._id)) {
        return sendError(res, 403, 'Forbidden');
      }
    } else {
      return sendError(res, 403, 'Forbidden');
    }
    
    if (submission.correctionStatus === 'processing') return res.status(409).json({ success: false, message: 'Correction generation is already processing', data: {
      correctionStatus: 'processing', processingActive: true, automaticPollingAllowed: true, manualRetryAllowed: false, terminal: false
    }});
    const assignment = await Assignment.findById(submission.assignment).lean();
    const accepted = await Submission.updateOne({ _id: submission._id, correctionStatus: { $ne: 'processing' } }, { $set: {
      correctionStatus: 'processing', correctionError: null, semanticStatus: 'pending', semanticAttempt: 0,
      semanticNextRetryAt: null, semanticErrorCode: null
    }});
    if (!accepted.modifiedCount) return res.status(409).json({ success: false, message: 'Correction generation is already processing', data: {
      correctionStatus: 'processing', processingActive: true, automaticPollingAllowed: true, manualRetryAllowed: false, terminal: false
    }});
    submission.correctionStatus = 'processing';
    setImmediate(() => canonicalCorrectionsPipeline.generateAndPersist(submission, { force: true, assignment: assignment ? {
      title: assignment.title || '', description: assignment.description || assignment.instructions || '',
      rubric: assignment.rubric || assignment.rubrics || null
    } : {} }).catch((error) => logger.error({ message: 'Authorized correction regeneration failed', submissionId: String(submission._id), error: error?.message || error })));
    return res.status(202).json({ success: true, data: { correctionStatus: 'processing', processingActive: true,
      automaticPollingAllowed: true, manualRetryAllowed: false, terminal: false } });
  } catch (err) { return sendError(res, err?.statusCode || 500, err?.message || 'Failed to regenerate corrections'); }
}

module.exports = {
  submitByAssignmentId,
  submitByQrToken,
  getSubmissionsByAssignment,
  getMySubmissions,
  getMySubmissionByAssignmentId,
  getOcrCorrections,
  regenerateCanonicalCorrections,
  uploadHandwrittenForOcr,
  hasValidOcrPages,
  hasValidLegacyOcrWords,
  hasUsableOcrData
};
