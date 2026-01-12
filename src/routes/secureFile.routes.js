const express = require('express');

const secureFileController = require('../controllers/secureFile.controller');

const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const router = express.Router();

router.get('/original/:filename', verifyJwtToken, secureFileController.serveOriginal);
router.get('/processed/:filename', verifyJwtToken, secureFileController.serveProcessed);

module.exports = router;
