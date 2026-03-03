const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const File = require('../models/File');
const OcrUpload = require('../models/OcrUpload');

const uploadService = require('../services/upload.service');
const { runOcrAndPersist, runOcrAndPersistForFiles } = require('../services/ocrPipeline.service');
const { normalizeOcrWordsFromStored, buildOcrCorrections } = require('../services/ocrCorrections.service');
const { autoGenerateRubricDesignerForSubmission } = require('../services/autoRubricDesigner.service');

const { createNotification } = require('../services/notification.service');

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

  const combinedCandidate =
    (doc.transcriptText && String(doc.transcriptText).trim())
      ? String(doc.transcriptText)
      : (doc.combinedOcrText && String(doc.combinedOcrText).trim())
        ? String(doc.combinedOcrText)
        : (doc.ocrText && String(doc.ocrText).trim())
          ? String(doc.ocrText)
          : '';

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

  if (Array.isArray(doc.fileUrls)) {
    doc.fileUrls = doc.fileUrls.map((u) => normalizePublicUploadsUrlForDev(req, u));
  }
  if (typeof doc.fileUrl === 'string') {
    doc.fileUrl = normalizePublicUploadsUrlForDev(req, doc.fileUrl);
  }

  return doc;
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
      existing.ocrText = undefined;
      existing.ocrError = undefined;
      existing.ocrData = undefined;
      existing.ocrUpdatedAt = new Date();

      const saved = await existing.save();

      await incrementUsage(studentId, { storageMB: uploadedMB });

      setImmediate(() => {
        const ids = Array.isArray(saved.files) && saved.files.length
          ? saved.files
          : (firstFile ? [firstFile._id] : []);

        const ocrPromise = ids.length
          ? runOcrAndPersistForFiles({ fileIds: ids, targetDoc: saved })
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
      ocrUpdatedAt: new Date()
    });

    await incrementUsage(studentId, { submissions: 1, storageMB: uploadedMB });

    setImmediate(() => {
      const ids = Array.isArray(created.files) && created.files.length
        ? created.files
        : (firstFile ? [firstFile._id] : []);

      const ocrPromise = ids.length
        ? runOcrAndPersistForFiles({ fileIds: ids, targetDoc: created })
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
