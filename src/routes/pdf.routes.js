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

module.exports = router;
