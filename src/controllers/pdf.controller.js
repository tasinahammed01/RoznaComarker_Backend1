const mongoose = require('mongoose');

const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const WorksheetSubmission = require('../models/WorksheetSubmission');
const Worksheet = require('../models/Worksheet');
const FlashcardSet = require('../models/FlashcardSet');
const FlashcardSubmission = require('../models/FlashcardSubmission');
const Assignment = require('../models/assignment.model');
const Membership = require('../models/membership.model');
const User = require('../models/user.model');
const logger = require('../utils/logger');

const uploadService = require('../services/upload.service');
const { buildOcrCorrections } = require('../services/ocrCorrections.service');

const { ApiError } = require('../middlewares/error.middleware');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

function getRequestBaseUrl(req) {
  const raw = `${req.protocol}://${req.get('host')}`;
  return raw.replace(/\/+$/, '');
}

async function getSubmissionWithPermissionsOrThrow({ user, submissionId }) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    throw new ApiError(400, 'Invalid submission id');
  }

  const submission = await Submission.findById(submissionId)
    .populate('student', '_id email displayName photoURL role')
    .populate({
      path: 'assignment',
      populate: { path: 'teacher', select: '_id email displayName' }
    })
    .populate('class')
    .populate('file')
    .populate('files')
    .populate('feedback');

  if (!submission) {
    throw new ApiError(404, 'Submission not found');
  }

  if (!user) {
    throw new ApiError(401, 'Unauthorized');
  }

  if (user.role === 'student') {
    if (String(submission.student?._id || submission.student) !== String(user._id)) {
      throw new ApiError(403, 'Forbidden');
    }
  } else if (user.role === 'teacher') {
    await uploadService.assertTeacherOwnsClassOrThrow(user._id, submission.class);
  } else {
    throw new ApiError(403, 'Forbidden');
  }

  return submission;
}

async function downloadSubmissionPdf(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'test') {
      throw new ApiError(501, 'PDF generation is not available in test environment');
    }

    // Lazy-load to avoid pulling PDF generation during test imports.
    // eslint-disable-next-line global-require
    const { generatePdf } = require('../modules/pdfGenerator');

    const submissionId = req.params && req.params.submissionId ? String(req.params.submissionId) : '';

    const submission = await getSubmissionWithPermissionsOrThrow({
      user: req.user,
      submissionId
    });

    // Feedback collection is the single source of truth.
    // Do not rely on `submission.feedback` being present/populated.
    const feedback = await Feedback.findOne({ submission: submission._id });

    const submissionFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id });

    const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
      ? String(submission.transcriptText)
      : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
        ? String(submission.combinedOcrText)
        : (submission.ocrText && String(submission.ocrText).trim())
          ? String(submission.ocrText)
          : '';

    const ocrWords = submission && submission.ocrData && typeof submission.ocrData === 'object' ? submission.ocrData.words : null;

    const built = await buildOcrCorrections({
      text: transcriptText,
      language: 'en-US',
      ocrWords
    });

    const issues = Array.isArray(built && built.corrections) ? built.corrections : [];

    const baseUrl = getRequestBaseUrl(req);

    const rawUrls = Array.isArray(submission.fileUrls) && submission.fileUrls.length
      ? submission.fileUrls
      : (submission.fileUrl && typeof submission.fileUrl === 'string' ? [submission.fileUrl] : []);

    const normalizedUrls = rawUrls
      .map((u) => (typeof u === 'string' ? u.trim() : ''))
      .filter(Boolean)
      .map((u) => (
        u.startsWith('http')
          ? u
          : `${baseUrl}${u.startsWith('/') ? '' : '/'}${u}`
      ));

    const fileIds = Array.isArray(submission.files) && submission.files.length
      ? submission.files.map((f) => (f && typeof f === 'object' && f._id ? String(f._id) : String(f))).filter(Boolean)
      : (submission.file ? [String(submission.file._id || submission.file)] : []);

    const ocrPages = Array.isArray(submission.ocrPages) ? submission.ocrPages : [];

    const images = normalizedUrls.map((url, idx) => {
      const fileId = fileIds[idx] || '';
      const pageText = fileId
        ? ocrPages
            .filter((p) => p && p.fileId && String(p.fileId) === fileId)
            .map((p) => (typeof p.text === 'string' ? p.text.trim() : ''))
            .filter(Boolean)
            .join('\n\n')
        : '';

      return {
        url,
        transcriptText: pageText || ''
      };
    });

    const imageUrl = images.length ? images[0].url : '';

    const studentEmail =
      submission.student && typeof submission.student === 'object'
        ? String(submission.student.email || submission.student.userEmail || '').trim()
        : '';

    const studentName =
      submission.student && typeof submission.student === 'object'
        ? String(submission.student.displayName || submission.student.email || '').trim()
        : '';

    const assignmentPublishDateRaw =
      submission.assignment && typeof submission.assignment === 'object'
        ? (submission.assignment.publishedAt || submission.assignment.createdAt)
        : null;

    const header = {
      studentName,
      studentEmail,
      submissionId: String(submission._id),
      date: assignmentPublishDateRaw ? new Date(assignmentPublishDateRaw).toLocaleString() : (submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '')
    };

    const tmpDir = path.join(os.tmpdir(), 'rozna-pdf');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `submission-feedback-${String(submission._id)}-${uuidv4()}.pdf`);

    const savedPath = await generatePdf({
      header,
      images,
      transcriptText,
      issues,
      feedback,
      submissionFeedback
    }, outputPath);

    const safeFilename = 'submission-feedback.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.download(savedPath, safeFilename, async (err) => {
      try {
        await fs.promises.unlink(savedPath);
      } catch {
        // ignore
      }
      if (err) {
        logger.error(`[PDF ERROR] Download failed submissionId=${String(submission._id)} message=${err && err.message ? err.message : String(err)}`);
        return next(new ApiError(500, 'Failed to download PDF'));
      }
      return undefined;
    });
  } catch (err) {
    try {
      const submissionId = req.params && req.params.submissionId ? String(req.params.submissionId) : '';
      logger.error(`[PDF ERROR] PDF generation failed submissionId=${submissionId} message=${err && err.message ? err.message : String(err)}`);
    } catch {
      // ignore
    }
    if (err instanceof ApiError) {
      return next(err);
    }
    return next(new ApiError(500, `PDF generation failed: ${err && err.message ? err.message : String(err)}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSHEET: individual student submission PDF
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWorksheetSubmissionPdf(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'test') {
      throw new ApiError(501, 'PDF generation is not available in test environment');
    }
    // eslint-disable-next-line global-require
    const { generateWorksheetSubmissionPdf } = require('../modules/worksheetPdfGenerator');

    const submissionId = req.params && req.params.submissionId ? String(req.params.submissionId) : '';
    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      throw new ApiError(400, 'Invalid submission id');
    }

    const submission = await WorksheetSubmission.findById(submissionId)
      .populate('studentId', '_id email displayName')
      .populate('worksheetId')
      .populate({
        path: 'assignmentId',
        populate: { path: 'class', select: '_id teacher' }
      });

    if (!submission) throw new ApiError(404, 'Submission not found');

    const user = req.user;
    if (!user) throw new ApiError(401, 'Unauthorized');

    if (user.role === 'student') {
      if (String(submission.studentId?._id || submission.studentId) !== String(user._id)) {
        throw new ApiError(403, 'Forbidden');
      }
    } else if (user.role === 'teacher') {
      const classId = submission.assignmentId?.class?._id || submission.assignmentId?.class;
      if (!classId) throw new ApiError(403, 'Forbidden');
      await uploadService.assertTeacherOwnsClassOrThrow(user._id, classId);
    } else {
      throw new ApiError(403, 'Forbidden');
    }

    const ws = submission.worksheetId;
    const student = submission.studentId;
    const studentName = (student && typeof student === 'object')
      ? String(student.displayName || student.email || '').trim()
      : '';
    const submittedAt = submission.submittedAt
      ? new Date(submission.submittedAt).toLocaleString()
      : '';

    const tmpDir    = path.join(os.tmpdir(), 'rozna-pdf');
    const outFile   = path.join(tmpDir, `worksheet-submission-${String(submission._id)}-${uuidv4()}.pdf`);
    const savedPath = await generateWorksheetSubmissionPdf({ 
      worksheet: ws, 
      submission, 
      studentName, 
      submittedAt,
      assignment: submission.assignmentId 
    }, outFile);

    const safeFilename = 'worksheet-submission.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.download(savedPath, safeFilename, async (err) => {
      try { await fs.promises.unlink(savedPath); } catch { /* ignore */ }
      if (err) return next(new ApiError(500, 'Failed to download PDF'));
      return undefined;
    });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(500, `PDF generation failed: ${err && err.message ? err.message : String(err)}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSHEET: full class submission report PDF (teacher only)
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWorksheetReportPdf(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'test') {
      throw new ApiError(501, 'PDF generation is not available in test environment');
    }
    // eslint-disable-next-line global-require
    const { generateWorksheetReportPdf } = require('../modules/worksheetPdfGenerator');

    const worksheetId = req.params && req.params.worksheetId ? String(req.params.worksheetId) : '';
    if (!mongoose.Types.ObjectId.isValid(worksheetId)) {
      throw new ApiError(400, 'Invalid worksheet id');
    }

    const user = req.user;
    if (!user) throw new ApiError(401, 'Unauthorized');
    if (user.role !== 'teacher') throw new ApiError(403, 'Forbidden');

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) throw new ApiError(404, 'Worksheet not found');
    if (String(worksheet.createdBy) !== String(user._id)) throw new ApiError(403, 'Forbidden');

    // Fetch all assignments for this worksheet
    const assignments = await Assignment.find({
      resourceType: 'worksheet',
      resourceId: worksheetId,
      isActive: true,
    }).lean();
    
    // Calculate total assigned students
    const assignmentIds = assignments.map(a => a._id);
    const totalAssigned = await Membership.countDocuments({
      class: { $in: assignments.map(a => a.class) },
      status: 'active',
    });
    
    // Get teacher info
    const teacher = await User.findById(worksheet.createdBy).select('displayName email').lean();
    
    // Get assignment info (use first assignment or most recent)
    const assignment = assignments.length > 0 ? assignments[0] : null;

    const submissions = await WorksheetSubmission.find({ worksheetId })
      .populate('studentId', '_id email displayName')
      .sort({ submittedAt: -1 });

    const tmpDir    = path.join(os.tmpdir(), 'rozna-pdf');
    const outFile   = path.join(tmpDir, `worksheet-report-${worksheetId}-${uuidv4()}.pdf`);
    const savedPath = await generateWorksheetReportPdf({ 
      worksheet, 
      submissions, 
      assignment,
      teacher,
      totalAssigned 
    }, outFile);

    const safeFilename = 'worksheet-report.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.download(savedPath, safeFilename, async (err) => {
      try { await fs.promises.unlink(savedPath); } catch { /* ignore */ }
      if (err) return next(new ApiError(500, 'Failed to download PDF'));
      return undefined;
    });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(500, `PDF generation failed: ${err && err.message ? err.message : String(err)}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FLASHCARD: submission report PDF (teacher only)
// ─────────────────────────────────────────────────────────────────────────────
async function downloadFlashcardReportPdf(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'test') {
      throw new ApiError(501, 'PDF generation is not available in test environment');
    }
    // eslint-disable-next-line global-require
    const { generateFlashcardReportPdf } = require('../modules/worksheetPdfGenerator');

    const setId = req.params && req.params.setId ? String(req.params.setId) : '';
    if (!mongoose.Types.ObjectId.isValid(setId)) {
      throw new ApiError(400, 'Invalid flashcard set id');
    }

    const user = req.user;
    if (!user) throw new ApiError(401, 'Unauthorized');
    if (user.role !== 'teacher') throw new ApiError(403, 'Forbidden');

    const set = await FlashcardSet.findOne({ _id: setId, ownerId: user._id });
    if (!set) throw new ApiError(404, 'Flashcard set not found');

    const assignmentId = req.query && req.query.assignmentId ? String(req.query.assignmentId).trim() : '';
    const submissionFilter = { flashcardSetId: setId };
    if (assignmentId && mongoose.Types.ObjectId.isValid(assignmentId)) {
      submissionFilter.assignmentId = assignmentId;
    }

    const submissions = await FlashcardSubmission.find(submissionFilter)
      .populate('userId', 'displayName email')
      .lean();

    const totalSubmissions = submissions.length;
    const averageScore = totalSubmissions > 0
      ? Math.round(submissions.reduce((sum, s) => sum + (s.score || 0), 0) / totalSubmissions)
      : 0;

    const sortedTimes = submissions.map((s) => s.timeTaken || 0).sort((a, b) => a - b);
    const mid = Math.floor(sortedTimes.length / 2);
    const medianTimeTaken = sortedTimes.length === 0
      ? 0
      : sortedTimes.length % 2 !== 0
        ? sortedTimes[mid]
        : Math.round((sortedTimes[mid - 1] + sortedTimes[mid]) / 2);

    const participants = submissions.map((s) => ({
      userName: s.userId && (s.userId.displayName || s.userId.email)
        ? s.userId.displayName || s.userId.email
        : 'Unknown',
      score:      s.score || 0,
      timeTaken:  s.timeTaken || 0,
      submittedAt: s.submittedAt,
      status: 'completed',
    }));

    const cards = (Array.isArray(set.cards) ? set.cards : []).map((card) => {
      const cardIdStr = String(card._id);
      const correctCount = submissions.filter((s) =>
        Array.isArray(s.results) &&
        s.results.some((r) => r.cardId && String(r.cardId) === cardIdStr && r.status === 'know')
      ).length;
      return {
        front: String(card.front || ''),
        correctPercentage: totalSubmissions > 0
          ? Math.round((correctCount / totalSubmissions) * 100)
          : 0,
      };
    });

    const tmpDir    = path.join(os.tmpdir(), 'rozna-pdf');
    const outFile   = path.join(tmpDir, `flashcard-report-${setId}-${uuidv4()}.pdf`);
    const savedPath = await generateFlashcardReportPdf({
      title: String(set.title || 'Flashcard Set'),
      totalSubmissions,
      averageScore,
      medianTimeTaken,
      participants,
      cards,
    }, outFile);

    const safeFilename = 'flashcard-report.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.download(savedPath, safeFilename, async (err) => {
      try { await fs.promises.unlink(savedPath); } catch { /* ignore */ }
      if (err) return next(new ApiError(500, 'Failed to download PDF'));
      return undefined;
    });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(500, `PDF generation failed: ${err && err.message ? err.message : String(err)}`));
  }
}

module.exports = {
  downloadSubmissionPdf,
  downloadWorksheetSubmissionPdf,
  downloadWorksheetReportPdf,
  downloadFlashcardReportPdf,
};
