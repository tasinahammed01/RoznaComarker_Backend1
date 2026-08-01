const express = require('express');

const writingCorrectionsController = require('../controllers/writingCorrections.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const router = express.Router();

router.get('/legend', verifyJwtToken, writingCorrectionsController.getLegend);
// The former direct LanguageTool check endpoint was not used by a supported UI flow.
// It is intentionally no longer externally reachable; assignment analysis uses the
// canonical AI-only submission pipeline.

module.exports = router;
