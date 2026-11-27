'use strict';
// /api/similarity/webhooks: callbacks from the asynchronous similarity provider (Copyleaks). Mounted before the global 1 MB JSON parser: the
// exported result files can be larger, so these routes parse JSON up to SIMILARITY_WEBHOOK_BODY_LIMIT (default 10mb) themselves. No sign-in:
// every call must carry the shared secret header (and, for status events, the signed payload); otherwise, or while the feature, the provider
// or the webhook settings are off, the answer is 404. Copyleaks must reach these over public HTTPS (SIMILARITY_WEBHOOK_BASE_URL).
//   POST /copyleaks/:status/:scanId                       status events (completed, error, creditschecked, indexed)
//   POST /copyleaks/export/:scanId/results/:resultId      one exported result (match positions)
//   POST /copyleaks/export/:scanId/crawled                the crawled version (the text Copyleaks read)
//   POST /copyleaks/export/:scanId/completed              the export-completed event
const express = require('express');
const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');
const controller = require('../controllers/similarity.controller');

const router = express.Router();
router.use(controller.requireEnabled);
router.use(createSensitiveRateLimiter({ windowMs: 15 * 60 * 1000, limit: 600, reason: 'similarity_webhook_ip' }));
router.use(express.json({ limit: process.env.SIMILARITY_WEBHOOK_BODY_LIMIT || '10mb' }));

router.post('/copyleaks/export/:scanId/results/:resultId', controller.copyleaksExport('results'));
router.post('/copyleaks/export/:scanId/crawled', controller.copyleaksExport('crawled'));
router.post('/copyleaks/export/:scanId/completed', controller.copyleaksExport('completed'));
router.post('/copyleaks/:status/:scanId', controller.copyleaksStatus);
router.use((_req, res) => res.status(404).json(controller.NOT_FOUND));

module.exports = router;
