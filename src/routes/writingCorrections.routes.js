const express = require('express');

const writingCorrectionsController = require('../controllers/writingCorrections.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const router = express.Router();

router.get('/legend', verifyJwtToken, writingCorrectionsController.getLegend);
router.post('/check', verifyJwtToken, writingCorrectionsController.check);

module.exports = router;
