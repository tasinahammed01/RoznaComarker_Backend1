const mongoose = require('mongoose');

const Plan = require('../models/Plan');
const User = require('../models/user.model');

const { ensureActivePlan, assignPlanToUser } = require('../middlewares/usage.middleware');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function getMySubscription(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const planDoc = await ensureActivePlan(user);

    return sendSuccess(res, {
      plan: planDoc,
      planStartedAt: user.planStartedAt || null,
      planExpiresAt: user.planExpiresAt || null,
      usage: user.usage || {
        classes: 0,
        assignments: 0,
        students: 0,
        submissions: 0,
        storageMB: 0
      }
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch subscription');
  }
}

async function setUserSubscription(req, res) {
  try {
    const { userId, planId, planName, startedAt } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return sendError(res, 400, 'Invalid userId');
    }

    const user = await User.findById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    let planDoc;

    if (mongoose.Types.ObjectId.isValid(planId)) {
      planDoc = await Plan.findById(planId);
    } else if (isNonEmptyString(planName)) {
      planDoc = await Plan.findOne({ name: planName.trim() });
    } else {
      return sendError(res, 400, 'planId or planName is required');
    }

    if (!planDoc) {
      return sendError(res, 404, 'Plan not found');
    }

    const parsedStartedAt = startedAt ? new Date(startedAt) : new Date();
    if (!(parsedStartedAt instanceof Date) || Number.isNaN(parsedStartedAt.getTime())) {
      return sendError(res, 400, 'Invalid startedAt');
    }

    await assignPlanToUser(user, planDoc, parsedStartedAt);

    const nextPlan = await Plan.findById(user.plan);

    return sendSuccess(res, {
      userId: user._id,
      plan: nextPlan,
      planStartedAt: user.planStartedAt || null,
      planExpiresAt: user.planExpiresAt || null,
      usage: user.usage
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to set subscription');
  }
}

module.exports = {
  getMySubscription,
  setUserSubscription
};
