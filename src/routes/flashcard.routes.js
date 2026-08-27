const express = require('express');

const flashcardController = require('../controllers/flashcard.controller');
const flashcardReportController = require('../controllers/flashcardReport.controller');
const flashcardProgressController = require('../controllers/flashcardProgress.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { upload, setUploadType, handleUploadError, validateUploadedFileSignature } = require('../middlewares/upload.middleware');
const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { createUserConcurrencyGuard } = require('../middlewares/concurrency.middleware');
const { reserveAiFlashcardUsage } = require('../middlewares/usage.middleware');

const router = express.Router();

router.post('/generate',
  createSensitiveRateLimiter({ event: 'AI_GENERATION_RATE_LIMITED', reason: 'flashcard_ip' }),
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ event: 'AI_GENERATION_RATE_LIMITED', reason: 'flashcard_user' }),
  createUserConcurrencyGuard({ operation: 'flashcard_generation', maxConcurrent: 2 }),
  reserveAiFlashcardUsage(),
  flashcardController.generateFlashcards);
router.post('/:id/cards/:cardId/check-answer',
  createSensitiveRateLimiter({ windowMs: 60 * 1000, limit: 120, event: 'AI_GENERATION_RATE_LIMITED', reason: 'flashcard_grade_ip' }),
  verifyJwtToken,
  requireRole('student'),
  createUserRateLimiter({ windowMs: 60 * 1000, limit: 60, event: 'AI_GENERATION_RATE_LIMITED', reason: 'flashcard_grade_user' }),
  createUserConcurrencyGuard({ operation: 'flashcard_answer_check', maxConcurrent: 2 }),
  flashcardController.gradeAnswer);

router.post(
  '/upload/flashcard-image',
  createSensitiveRateLimiter({ event: 'UPLOAD_RATE_LIMITED', reason: 'flashcard_upload_ip' }),
  verifyJwtToken,
  createUserRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30, event: 'UPLOAD_RATE_LIMITED', reason: 'flashcard_upload_user' }),
  setUploadType('flashcards'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  flashcardController.uploadFlashcardImage
);

router.get('/',  verifyJwtToken, requireRole('teacher'), flashcardController.getAllSets);
router.post('/', verifyJwtToken, requireRole('teacher'), flashcardController.createSet);

router.get('/:id', verifyJwtToken, flashcardController.getSetById);
router.put('/:id', verifyJwtToken, requireRole('teacher'), flashcardController.updateSet);
router.delete('/:id', verifyJwtToken, requireRole('teacher'), flashcardController.deleteSet);

router.post('/:id/submissions', verifyJwtToken, flashcardController.submitStudySession);
router.get('/:id/report', verifyJwtToken, requireRole('teacher'), flashcardReportController.getReport);
router.post('/:id/assign', verifyJwtToken, requireRole('teacher'), flashcardController.assignSet);

/** PART 2 — share link management (teacher only) */
router.post('/:id/share',  verifyJwtToken, requireRole('teacher'), flashcardController.shareFlashcardSet);
router.delete('/:id/share', verifyJwtToken, requireRole('teacher'), flashcardController.revokeShare);

/** PART 3 — real-time progress tracking (student) */
router.patch('/:setId/progress', verifyJwtToken, requireRole('student'), flashcardProgressController.saveProgress);
router.get('/:setId/progress', verifyJwtToken, requireRole('student'), flashcardProgressController.getProgress);
router.delete('/:setId/progress', verifyJwtToken, requireRole('student'), flashcardProgressController.resetProgress);

module.exports = router;
