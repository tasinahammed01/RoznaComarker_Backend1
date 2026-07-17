'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/adaptivePractice.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { handleValidationResult } = require('../middlewares/validation.middleware');
const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

const router = express.Router();
const validateSubmission = [
  verifyJwtToken,
  requireRole('student'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult
];

router.get('/teacher/submissions/:submissionId/progress', verifyJwtToken, requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'), handleValidationResult, controller.getTeacherProgress);
router.get('/teacher/sessions/:sessionId/activities/:activityId/attempts', verifyJwtToken, requireRole('teacher'),
  param('sessionId').isMongoId().withMessage('Invalid session id'),
  param('activityId').isString().trim().notEmpty().isLength({ max: 100 }),
  query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 25 }),
  handleValidationResult, controller.getTeacherAttempts);

router.get('/submissions/:submissionId', ...validateSubmission, controller.getSession);
router.post('/submissions/:submissionId/generate', createSensitiveRateLimiter(), ...validateSubmission, controller.generateSession);
router.post('/sessions/:sessionId/activities/:activityId/check', createSensitiveRateLimiter(), verifyJwtToken, requireRole('student'),
  param('sessionId').isMongoId().withMessage('Invalid session id'),
  param('activityId').isString().trim().notEmpty().isLength({ max: 100 }),
  body('response').isString().isLength({ min: 10, max: 5000 }),
  body('retry').optional().isBoolean(), handleValidationResult, controller.checkResponse);
router.get('/sessions/:sessionId/attempts', verifyJwtToken, requireRole('student'),
  param('sessionId').isMongoId().withMessage('Invalid session id'),
  query('activityId').isString().trim().notEmpty().isLength({ max: 100 }), handleValidationResult, controller.listAttempts);

module.exports = router;
