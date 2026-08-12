const express = require('express');
const router = express.Router();
const { searchUnsplashImages } = require('../controllers/unsplash.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');

// Search Unsplash images
// GET /api/unsplash/search?q=:keyword
router.get('/search',
  createSensitiveRateLimiter({ windowMs: 60 * 1000, limit: 60, event: 'UNSPLASH_RATE_LIMITED', reason: 'unsplash_ip' }),
  verifyJwtToken,
  requireRole('teacher'),
  createUserRateLimiter({ windowMs: 60 * 1000, limit: 30, event: 'UNSPLASH_RATE_LIMITED', reason: 'unsplash_user' }),
  searchUnsplashImages);

module.exports = router;
