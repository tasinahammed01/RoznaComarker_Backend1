const express = require('express');
const worksheetController = require('../controllers/worksheet.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const router = express.Router();

/* ── AI Generation (teacher only, no save) ─────────────────── */
router.post('/generate', verifyJwtToken, requireRole('teacher'), worksheetController.generateWorksheet);

/* ── CRUD (teacher) ─────────────────────────────────────────── */
router.get('/',    verifyJwtToken, requireRole('teacher'), worksheetController.getMyWorksheets);
router.post('/',   verifyJwtToken, requireRole('teacher'), worksheetController.createWorksheet);

/* ── Per-worksheet results (teacher) ────────────────────────── */
router.get('/:id/submissions', verifyJwtToken, requireRole('teacher'), worksheetController.getSubmissions);

/* ── Student: submit ─────────────────────────────────────────── */
router.post('/:id/submit', verifyJwtToken, requireRole('student'), worksheetController.submitWorksheet);

/* ── Student: fetch own submission ──────────────────────────── */
router.get('/:id/my-submission', verifyJwtToken, requireRole('student'), worksheetController.getMySubmission);
router.get('/:id/my-submission-by-assignment', verifyJwtToken, requireRole('student'), worksheetController.getMySubmissionByAssignment);

/* ── Assign worksheet to class (teacher) ────────────────────── */
router.post('/:id/assign', verifyJwtToken, requireRole('teacher'), worksheetController.assignWorksheet);

/* ── Single worksheet CRUD (teacher or enrolled student for GET) */
router.get('/:id',    verifyJwtToken, worksheetController.getWorksheetById);
router.put('/:id',    verifyJwtToken, requireRole('teacher'), worksheetController.updateWorksheet);
router.delete('/:id', verifyJwtToken, requireRole('teacher'), worksheetController.deleteWorksheet);

module.exports = router;
