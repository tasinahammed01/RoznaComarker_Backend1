const express = require('express');
const worksheetController = require('../controllers/worksheet.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const multer = require('multer');

// Configure multer for in-memory file storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

const router = express.Router();

/* ── AI Generation (teacher only, no save) ─────────────────── */
router.post('/generate', verifyJwtToken, requireRole('teacher'), worksheetController.generateWorksheet);

/* ── File Upload & Generate (teacher only) ─────────────────── */
router.post('/upload-and-generate', verifyJwtToken, requireRole('teacher'), upload.single('file'), worksheetController.uploadAndGenerate);

/* ── CRUD (teacher) ─────────────────────────────────────────── */
router.get('/',    verifyJwtToken, requireRole('teacher'), worksheetController.getMyWorksheets);
router.post('/',   verifyJwtToken, requireRole('teacher'), worksheetController.createWorksheet);

/* ── Per-worksheet results (teacher) ────────────────────────── */
router.get('/:id/submissions', verifyJwtToken, requireRole('teacher'), worksheetController.getSubmissions);
router.get('/:id/report', verifyJwtToken, requireRole('teacher'), worksheetController.getWorksheetReport);

/* ── Student: submit ─────────────────────────────────────────── */
router.post('/:id/submit', verifyJwtToken, requireRole('student'), worksheetController.submitWorksheet);

/* ── Student: grade attempt (no persistence) ─────────────────── */
router.post('/:id/grade', verifyJwtToken, requireRole('student'), worksheetController.gradeWorksheetAttempt);

/* ── Student: fetch own submission ──────────────────────────── */
router.get('/:id/my-submission', verifyJwtToken, requireRole('student'), worksheetController.getMySubmission);
router.get('/:id/my-submission-by-assignment', verifyJwtToken, requireRole('student'), worksheetController.getMySubmissionByAssignment);

/* ── Student: draft autosave ─────────────────────────────────── */
router.get('/:id/draft', verifyJwtToken, requireRole('student'), worksheetController.getWorksheetDraft);
router.post('/:id/draft', verifyJwtToken, requireRole('student'), worksheetController.saveWorksheetDraft);
router.delete('/:id/draft', verifyJwtToken, requireRole('student'), worksheetController.deleteWorksheetDraft);

/* ── Assign worksheet to class (teacher) ────────────────────── */
router.post('/:id/assign', verifyJwtToken, requireRole('teacher'), worksheetController.assignWorksheet);

/* ── Regenerate AI theme for a worksheet (teacher only) ──────── */
router.post('/:id/regenerate-theme', verifyJwtToken, requireRole('teacher'), worksheetController.regenerateTheme);

/* ── Share worksheet (teacher only) ──────────────────────────── */
router.post('/:id/share', verifyJwtToken, requireRole('teacher'), worksheetController.shareWorksheet);
router.delete('/:id/share', verifyJwtToken, requireRole('teacher'), worksheetController.revokeShareWorksheet);

/* ── Single worksheet CRUD (teacher or enrolled student for GET) */
router.get('/:id',    verifyJwtToken, worksheetController.getWorksheetById);
router.put('/:id',    verifyJwtToken, requireRole('teacher'), worksheetController.updateWorksheet);
router.delete('/:id', verifyJwtToken, requireRole('teacher'), worksheetController.deleteWorksheet);

module.exports = router;
