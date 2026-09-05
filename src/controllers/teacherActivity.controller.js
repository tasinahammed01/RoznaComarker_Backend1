'use strict';

const activity = require('../services/teacherActivity.service');

async function getActivitySummary(req, res) {
  try {
    const data = await activity.getSummary(req.user);
    res.set('Cache-Control', 'private, no-store');
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Failed to fetch teacher activity summary' });
  }
}

async function acknowledgeActivitySummary(req, res) {
  try {
    const viewedAt = await activity.acknowledge(req.user, req.body?.ackToken);
    if (!viewedAt) return res.status(400).json({ success: false, message: 'Invalid or expired activity acknowledgement' });
    return res.json({ success: true, data: { viewedAt: viewedAt.toISOString() } });
  } catch {
    return res.status(500).json({ success: false, message: 'Failed to acknowledge teacher activity summary' });
  }
}

async function getMilestones(req, res) {
  try {
    const data = await require('../services/professionalMilestone.service').milestoneSummary(req.user._id);
    res.set('Cache-Control', 'private, no-store'); return res.json({ success: true, data });
  } catch { return res.status(500).json({ success: false, message: 'Failed to fetch professional milestones' }); }
}

async function getWeeklySummary(req, res) {
  try {
    const data = await require('../services/weeklyTeacherSummary.service').getWeeklySummary(req.user, req.query?.end);
    res.set('Cache-Control', 'private, no-store'); return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({ success: false,
      message: error?.statusCode === 400 ? error.message : 'Failed to fetch weekly teacher summary' });
  }
}

module.exports = { getActivitySummary, acknowledgeActivitySummary, getMilestones, getWeeklySummary };
