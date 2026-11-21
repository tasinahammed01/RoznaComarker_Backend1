const express = require('express');

const pdfController = require('../controllers/pdf.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const assignmentReportPdf = require('../controllers/assignmentReportPdf.controller');

const { param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');
const { refuseAudioSubmission } = require('../middlewares/essayOnly.middleware');

const router = express.Router();

router.get(
  '/download/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  refuseAudioSubmission,
  pdfController.downloadSubmissionPdf
);

router.get(
  '/download-worksheet/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  pdfController.downloadWorksheetSubmissionPdf
);

router.get(
  '/student-worksheet-result/:submissionId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole(['student']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  pdfController.downloadStudentWorksheetResultPdf
);

router.get(
  '/worksheet-report/:worksheetId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole(['teacher']),
  param('worksheetId').isMongoId().withMessage('Invalid worksheet id'),
  handleValidationResult,
  pdfController.downloadWorksheetReportPdf
);

router.get(
  '/flashcard-report/:setId',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole(['teacher']),
  param('setId').isMongoId().withMessage('Invalid flashcard set id'),
  handleValidationResult,
  pdfController.downloadFlashcardReportPdf
);

// Whole-assignment report PDF (teacher only; 404 to anyone else). Per-teacher rate limit and one running PDF per teacher.
router.get(
  '/assignment-report/:id',
  verifyJwtToken,
  requireRole(['teacher']),
  param('id').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  createUserRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000, event: 'API_RATE_LIMITED', reason: 'assignment_report_pdf' }),
  assignmentReportPdf.onePdfPerTeacher,
  assignmentReportPdf.downloadAssignmentReportPdf
);

module.exports = router;
