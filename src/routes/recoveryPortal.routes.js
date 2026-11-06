'use strict';
const router = require('express').Router();
const controller = require('../controllers/recoveryPortal.controller');
const { createSensitiveRateLimiter, createEmailRateLimiter } = require('../middlewares/rateLimit.middleware');

router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});
// The portal lists guest submissions: it is available exactly when guest submissions are.
router.use(require('../config/guestSubmission').requireGuestSubmissionEnabled);

const MINUTES_15 = 15 * 60 * 1000;
router.post('/request',
  createSensitiveRateLimiter({ limit: 20, windowMs: MINUTES_15, reason: 'recovery_request_ip' }),
  createEmailRateLimiter({ limit: require('../services/recoveryEmailQuota.service').config().requestsPerHour, windowMs: 60 * 60 * 1000, reason: 'recovery_request_email' }),
  controller.request);
router.post('/exchange', createSensitiveRateLimiter({ limit: 20, windowMs: MINUTES_15, reason: 'recovery_exchange' }), controller.exchange);
router.get('/assignments', createSensitiveRateLimiter({ limit: 120, windowMs: MINUTES_15, reason: 'recovery_list' }), controller.assignments);
router.delete('/session', createSensitiveRateLimiter({ limit: 30, windowMs: MINUTES_15, reason: 'recovery_end' }), controller.endSession);

module.exports = router;
