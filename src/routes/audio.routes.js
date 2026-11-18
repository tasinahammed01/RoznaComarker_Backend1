'use strict';
// /api/audio: audio upload and speech-to-text. Behind AUDIO_STT_ENABLED (default off). While off, EVERY route here answers 404 with the same
// body as the other switched-off feature routers ({ success: false, code: 'NOT_FOUND' }), before sign-in is checked, so the feature cannot be
// discovered.
//   GET /config   { enabled, maxFileBytes, maxDurationSeconds, minDurationSeconds, dailyMinutesPerTeacher, monthlyMinutesPerTeacher }
//   GET /submissions/:submissionId/media      playback (Range): the student who owns it and the owning teacher; 404 for anyone else
//   GET /submissions/:submissionId/download   the owning teacher only; 404 for anyone else (no role check, which would say 403)
// Upload and status routes are in speaking.routes.js. Every route states its own sign-in and role
// (tests/helpers/studentRouteScan.js reads the role from each route).
const router = require('express').Router();
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { audioSttEnabled, publicConfig } = require('../services/audio/policy');
const media = require('../controllers/audioMedia.controller');

router.use((req, res, next) => (audioSttEnabled() ? next() : res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' })));
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
// Teacher-only for now: students get the limits when their upload route exists (a later stage).
router.get('/config', verifyJwtToken, requireRole('teacher'), (req, res) => res.json({ success: true, data: publicConfig(process.env, { role: req.user.role }) }));
router.get('/submissions/:submissionId/media', verifyJwtToken, media.media);
router.get('/submissions/:submissionId/download', verifyJwtToken, media.download);
router.use((_req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' }));

module.exports = router;
