const express = require('express');

const flashcardController = require('../controllers/flashcard.controller');
const flashcardReportController = require('../controllers/flashcardReport.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const router = express.Router();

router.post('/generate',     verifyJwtToken, requireRole('teacher'), flashcardController.generateFlashcards);
router.post('/grade-answer', verifyJwtToken, flashcardController.gradeAnswer);

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

module.exports = router;
