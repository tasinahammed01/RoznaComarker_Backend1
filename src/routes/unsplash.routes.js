const express = require('express');
const router = express.Router();
const { searchUnsplashImages } = require('../controllers/unsplash.controller');

// Search Unsplash images
// GET /api/unsplash/search?q=:keyword
router.get('/search', searchUnsplashImages);

module.exports = router;
