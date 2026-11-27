'use strict';
// /api/similarity: Similarity Reporting for the owning teacher. Behind SIMILARITY_ENABLED (default off): while off, EVERY route answers 404
// with the same body as the other switched-off feature routers, before sign-in is checked.
//   GET    /submissions/:submissionId                        the report (or the panel state before any check)
//   POST   /submissions/:submissionId/checks                 start a check, header Idempotency-Key, body { confirmPermission? }
//   POST   /submissions/:submissionId/checks/retry           try the external part again (does not use a check), header Idempotency-Key
//   PATCH  /submissions/:submissionId/sources/:sourceId      { excluded, revision, requestId }: exclude or restore one source
//   POST   /submissions/:submissionId/sources/restore-all    { revision, requestId }
//   GET    /submissions/:submissionId/pdf                    the teacher-only similarity PDF
// Anyone but the owning teacher gets 404. Students and guests have no similarity route at all.
const router = require('express').Router();
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const controller = require('../controllers/similarity.controller');

const MINUTES_15 = 15 * 60 * 1000;
const checkLimiter = createUserRateLimiter({ windowMs: MINUTES_15, limit: 10, event: 'AI_GENERATION_RATE_LIMITED', reason: 'similarity_check_user' });
const mutationLimiter = createUserRateLimiter({ windowMs: 60 * 1000, limit: 60, event: 'RATE_LIMITED', reason: 'similarity_exclude_user' });

router.use(controller.requireEnabled);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/submissions/:submissionId', verifyJwtToken, controller.hideFromNonTeachers, requireRole('teacher'), controller.getReport);
router.post('/submissions/:submissionId/checks/retry', verifyJwtToken, controller.hideFromNonTeachers, requireRole('teacher'), checkLimiter, controller.retry);
router.post('/submissions/:submissionId/checks', verifyJwtToken, controller.hideFromNonTeachers, requireRole('teacher'), checkLimiter, controller.startCheck);
router.post('/submissions/:submissionId/sources/restore-all', verifyJwtToken, controller.hideFromNonTeachers, requireRole('teacher'), mutationLimiter, controller.restoreAll);
router.patch('/submissions/:submissionId/sources/:sourceId', verifyJwtToken, controller.hideFromNonTeachers, requireRole('teacher'), mutationLimiter, controller.setExcluded);
router.use((_req, res) => res.status(404).json(controller.NOT_FOUND));

module.exports = router;
