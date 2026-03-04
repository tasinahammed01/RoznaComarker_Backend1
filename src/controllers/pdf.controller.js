const mongoose = require('mongoose');

const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const SubmissionFeedback = require('../models/SubmissionFeedback');

const uploadService = require('../services/upload.service');
const { buildOcrCorrections } = require('../services/ocrCorrections.service');

const { ApiError } = require('../middlewares/error.middleware');

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

    // Lazy-load to avoid pulling puppeteer/pdf rendering during test imports.
    // eslint-disable-next-line global-require
    const { renderSubmissionPdf } = require('../modules/pdfGenerator');

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

    const assignmentTeacherEmail =
      submission.assignment && typeof submission.assignment === 'object'
        ? (
            (submission.assignment.teacher && typeof submission.assignment.teacher === 'object' && submission.assignment.teacher.email)
              ? String(submission.assignment.teacher.email)
              : ''
          )
        : '';

    const assignmentPublishDateRaw =
      submission.assignment && typeof submission.assignment === 'object'
        ? (submission.assignment.publishedAt || submission.assignment.createdAt)
        : null;

    const header = {
      studentName: assignmentTeacherEmail || ((submission.student && typeof submission.student === 'object')
        ? (submission.student.displayName || submission.student.email || '')
        : ''),
      submissionId: String(submission._id),
      date: assignmentPublishDateRaw ? new Date(assignmentPublishDateRaw).toLocaleString() : (submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '')
    };

    console.log('Generating PDF for submission', String(submission._id), 'teacher:', assignmentTeacherEmail);
    console.log('Embedding image for submission', String(submission._id), imageUrl);
    console.log('Adding dynamic feedback for submission', String(submission._id));

    const pdfBuffer = await renderSubmissionPdf({
      header,
      imageUrl,
      images,
      transcriptText,
      issues,
      feedback,
      submissionFeedback
    });

    const safeFilename = 'submission-feedback.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');

    res.status(200);
    return res.end(Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer));
  } catch (err) {
    try {
      const submissionId = req.params && req.params.submissionId ? String(req.params.submissionId) : '';
      console.error('PDF generation failed for submission', submissionId);
      console.error(err && err.stack ? err.stack : err);
    } catch {
      // ignore
    }
    return next(err);
  }
}

module.exports = {
  downloadSubmissionPdf
};
