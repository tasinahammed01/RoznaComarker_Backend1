const express = require('express');

const rubricController = require('../controllers/rubric.controller');

const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

const multer = require('multer');

const router = express.Router();

const rubricUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.get('/', verifyJwtToken, requireRole('teacher'), rubricController.listSavedRubrics);
router.post('/', verifyJwtToken, requireRole('teacher'), rubricController.createSavedRubric);
router.post(
  '/from-assignment/:assignmentId',
  verifyJwtToken,
  requireRole('teacher'),
  rubricController.createSavedRubricFromAssignment
);

router.post(
  '/parse-rubric-file',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  rubricUpload.single('file'),
  rubricController.parseRubricFile
);

router.get('/:id', verifyJwtToken, requireRole('teacher'), rubricController.getSavedRubric);
router.patch('/:id', verifyJwtToken, requireRole('teacher'), rubricController.updateSavedRubric);
router.post('/:id/duplicate', verifyJwtToken, requireRole('teacher'), rubricController.duplicateSavedRubric);
router.delete('/:id', verifyJwtToken, requireRole('teacher'), rubricController.archiveSavedRubric);

router.post(
  '/parse-template',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('teacher'),
  rubricUpload.single('file'),
  rubricController.parseRubricTemplate
);

module.exports = router;
