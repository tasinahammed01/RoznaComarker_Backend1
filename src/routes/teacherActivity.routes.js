'use strict';

const express = require('express');
const controller = require('../controllers/teacherActivity.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const router = express.Router();
router.get('/activity-summary', verifyJwtToken, requireRole('teacher'), controller.getActivitySummary);
router.post('/activity-summary/acknowledge', verifyJwtToken, requireRole('teacher'), controller.acknowledgeActivitySummary);
router.get('/milestones', verifyJwtToken, requireRole('teacher'), controller.getMilestones);
router.get('/weekly-summary', verifyJwtToken, requireRole('teacher'), controller.getWeeklySummary);

module.exports = router;
