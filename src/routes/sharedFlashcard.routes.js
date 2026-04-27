/**
 * sharedFlashcard.routes.js — PART 2 public share endpoints
 * GET  /api/shared/flashcards/:shareToken         — no auth
 * POST /api/shared/flashcards/:shareToken/submit  — auth required (any logged-in user)
 */
const express = require('express');
const { getSharedSet, submitSharedSession } = require('../controllers/sharedFlashcard.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const router = express.Router();

router.get('/flashcards/:shareToken', getSharedSet);
router.post('/flashcards/:shareToken/submit', verifyJwtToken, submitSharedSession);

module.exports = router;
