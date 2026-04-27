const express = require('express');

const pdfController = require('../controllers/pdf.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const router = express.Router();

router.get(
  '/download/:submissionId',
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  pdfController.downloadSubmissionPdf
);

router.get(
  '/download-worksheet/:submissionId',
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  pdfController.downloadWorksheetSubmissionPdf
);

router.get(
  '/worksheet-report/:worksheetId',
  verifyJwtToken,
  requireRole(['teacher']),
  param('worksheetId').isMongoId().withMessage('Invalid worksheet id'),
  handleValidationResult,
  pdfController.downloadWorksheetReportPdf
);

router.get(
  '/flashcard-report/:setId',
  verifyJwtToken,
  requireRole(['teacher']),
  param('setId').isMongoId().withMessage('Invalid flashcard set id'),
  handleValidationResult,
  pdfController.downloadFlashcardReportPdf
);

module.exports = router;
