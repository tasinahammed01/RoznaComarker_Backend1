const fs = require('fs');

const Plan = require('../models/Plan');
const User = require('../models/user.model');

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function bytesToMB(bytes) {
  const raw = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Number(raw.toFixed(2));
}

async function getFreePlan() {
  return Plan.findOne({ name: 'Free' });
}

function toEmptyUsage() {
  return {
    classes: 0,
    assignments: 0,
    students: 0,
    submissions: 0,
    storageMB: 0
  };
}

async function assignPlanToUser(user, planDoc, startedAt) {
  const start = startedAt instanceof Date ? startedAt : new Date();

  user.plan = planDoc._id;
  user.planStartedAt = start;
  user.planExpiresAt =
    planDoc.durationDays && planDoc.durationDays > 0
      ? new Date(start.getTime() + planDoc.durationDays * 24 * 60 * 60 * 1000)
      : null;
  user.usage = toEmptyUsage();

  await user.save();
}

async function ensureActivePlan(user) {
  const freePlan = await getFreePlan();
  if (!freePlan) {
    throw new Error('Free plan is not configured');
  }

  if (!user.plan) {
    await assignPlanToUser(user, freePlan, new Date());
    return freePlan;
  }

  let planDoc = await Plan.findById(user.plan);
  if (!planDoc) {
    await assignPlanToUser(user, freePlan, new Date());
    return freePlan;
  }

  const expiresAt = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
  if (expiresAt && new Date().getTime() > expiresAt.getTime()) {
    await assignPlanToUser(user, freePlan, new Date());
    planDoc = freePlan;
  }

  return planDoc;
}

function getLimit(planDoc, metric) {
  const limits = planDoc && planDoc.limits ? planDoc.limits : null;
  const value = limits ? limits[metric] : undefined;
  return typeof value === 'number' ? value : null;
}

function getUsage(user, metric) {
  const usage = user && user.usage ? user.usage : null;
  const value = usage ? usage[metric] : undefined;
  return typeof value === 'number' ? value : 0;
}

function tryDeleteUploadedFile(file) {
  try {
    if (file && file.path) {
      fs.unlink(file.path, () => {});
    }
  } catch (err) {
    // ignore
  }
}

function enforceUsageLimit(metric, amountOrGetter) {
  return async function usageLimitMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user) return sendError(res, 401, 'Unauthorized');

      const planDoc = await ensureActivePlan(user);
      req.plan = planDoc;

      const limit = getLimit(planDoc, metric);
      if (limit === null) return sendError(res, 403, 'No active plan');

      const amount = typeof amountOrGetter === 'function' ? amountOrGetter(req) : amountOrGetter;
      const normalizedAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 1;

      const current = getUsage(user, metric);

      if (current + normalizedAmount > limit) {
        return sendError(res, 403, `Limit exceeded: ${metric}`);
      }

      return next();
    } catch (err) {
      return sendError(res, 500, 'Failed to validate usage limits');
    }
  };
}

function enforceStorageLimitFromUploadedFile() {
  return async function storageLimitMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user) {
        tryDeleteUploadedFile(req.file);
        return sendError(res, 401, 'Unauthorized');
      }

      const planDoc = await ensureActivePlan(user);
      req.plan = planDoc;

      const file = req.file;
      if (!file) return next();

      const limit = getLimit(planDoc, 'storageMB');
      if (limit === null) {
        tryDeleteUploadedFile(file);
        return sendError(res, 403, 'No active plan');
      }

      const fileMB = bytesToMB(file.size);
      const current = getUsage(user, 'storageMB');

      if (current + fileMB > limit) {
        tryDeleteUploadedFile(file);
        return sendError(res, 403, 'Limit exceeded: storage');
      }

      req.uploadSizeMB = fileMB;
      return next();
    } catch (err) {
      tryDeleteUploadedFile(req.file);
      return sendError(res, 500, 'Failed to validate storage limits');
    }
  };
}

async function incrementUsage(userId, increments) {
  const inc = {};

  for (const [key, value] of Object.entries(increments || {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    inc[`usage.${key}`] = value;
  }

  const keys = Object.keys(inc);
  if (keys.length === 0) return;

  await User.updateOne({ _id: userId }, { $inc: inc });
}

module.exports = {
  bytesToMB,
  ensureActivePlan,
  assignPlanToUser,
  enforceUsageLimit,
  enforceStorageLimitFromUploadedFile,
  incrementUsage,
  tryDeleteUploadedFile
};
