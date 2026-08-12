const fs = require('fs');

const Plan = require('../models/Plan');
const User = require('../models/user.model');
const logger = require('../utils/logger');
const { isSubscriptionEntitled } = require('../services/stripeSubscription.service');

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
  return Plan.findOne({ slug: 'free', isActive: true }).then((plan) =>
    plan || Plan.findOne({ name: 'Free', isActive: true })
  );
}

function toEmptyUsage() {
  return {
    classes: 0,
    assignments: 0,
    students: 0,
    submissions: 0,
    aiFlashcards: 0,
    aiWorksheets: 0,
    storageMB: 0
  };
}

async function assignPlanToUser(user, planDoc, startedAt) {
  const start = startedAt instanceof Date ? startedAt : new Date();

  user.plan = planDoc._id;
  user.planStartedAt = start;
  user.planExpiresAt =
    planDoc.slug !== 'free' && planDoc.durationDays && planDoc.durationDays > 0
      ? new Date(start.getTime() + planDoc.durationDays * 24 * 60 * 60 * 1000)
      : null;
  // Plan repair and upgrades must never erase already-consumed quota/storage.
  if (!user.usage) user.usage = toEmptyUsage();

  await user.save();
}

async function ensureActivePlan(user) {
  const freePlan = await getFreePlan();

  // Synchronized Stripe fields are authoritative for paid entitlements. This
  // also repairs a missing/stale plan ObjectId without trusting browser input.
  if (
    user.role === 'teacher' &&
    user.stripePriceId &&
    isSubscriptionEntitled(
      user.stripeSubscriptionStatus,
      user.stripeCurrentPeriodEnd
    )
  ) {
    const paidPlan = await Plan.findOne({
      isActive: true,
      'stripe.priceId': user.stripePriceId
    });
    if (paidPlan) {
      if (String(user.plan || '') !== String(paidPlan._id)) {
        user.plan = paidPlan._id;
        user.planStartedAt = user.stripeCurrentPeriodStart || user.planStartedAt || new Date();
        user.planExpiresAt = user.stripeCurrentPeriodEnd || null;
        await user.save();
      }
      return paidPlan;
    }
  }

  if (!freePlan) throw new Error('Free plan is not configured');

  // A definitive non-entitled Stripe state always resolves to Free, even if a
  // historical paid plan reference remains on the user.
  if (user.role === 'teacher' && user.stripeSubscriptionStatus) {
    if (String(user.plan || '') !== String(freePlan._id) || user.planExpiresAt) {
      await assignPlanToUser(user, freePlan, new Date());
    }
    return freePlan;
  }

  if (!user.plan) {
    await assignPlanToUser(user, freePlan, new Date());
    return freePlan;
  }

  let planDoc = await Plan.findById(user.plan);
  if (!planDoc || planDoc.isActive !== true) {
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
  const featureKeyByMetric = {
    classes: 'maxClasses',
    // The current Plan schema defines the writing allowance under the
    // canonical essayAnalysesPerMonth feature. Assignment creation uses the
    // existing assignments usage counter against that MongoDB-owned value.
    assignments: 'essayAnalysesPerMonth',
    students: 'maxStudents',
    submissions: 'essayAnalysesPerMonth',
    aiFlashcards: 'aiFlashcardsLimit',
    aiWorksheets: 'aiWorksheetsLimit',
    storageMB: 'storageMB'
  };
  const featureKey = featureKeyByMetric[metric];
  const featureValue = featureKey && planDoc?.features
    ? planDoc.features[featureKey]
    : undefined;
  if (typeof featureValue === 'number') return featureValue;

  // Keep the legacy shape as a compatibility fallback for existing test/dev data.
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

function enforceStorageLimitFromUploadedFiles() {
  return async function storageLimitMultiMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user) {
        try {
          const list = Array.isArray(req.files) ? req.files : [];
          for (const f of list) tryDeleteUploadedFile(f);
        } catch {
          // ignore
        }
        return sendError(res, 401, 'Unauthorized');
      }

      const planDoc = await ensureActivePlan(user);
      req.plan = planDoc;

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return next();

      const limit = getLimit(planDoc, 'storageMB');
      if (limit === null) {
        for (const f of files) tryDeleteUploadedFile(f);
        return sendError(res, 403, 'No active plan');
      }

      const totalMB = files.reduce((sum, f) => sum + bytesToMB(f && f.size), 0);
      const current = getUsage(user, 'storageMB');

      if (current + totalMB > limit) {
        for (const f of files) tryDeleteUploadedFile(f);
        return sendError(res, 403, 'Limit exceeded: storage');
      }

      req.uploadSizeMB = totalMB;
      return next();
    } catch {
      try {
        const list = Array.isArray(req.files) ? req.files : [];
        for (const f of list) tryDeleteUploadedFile(f);
      } catch {
        // ignore
      }
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

function reserveAiFeatureUsage({ metric, featureFlag, label }) {
  return async function aiFeatureUsageMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user) return sendError(res, 401, 'Unauthorized');

      const planDoc = await ensureActivePlan(user);
      req.plan = planDoc;
      if (planDoc?.features?.[featureFlag] !== true) {
        return sendError(res, 403, `${label} are not available on this plan`);
      }

      const limit = getLimit(planDoc, metric);
      let reserved = false;
      if (typeof limit === 'number') {
        if (limit <= 0) {
          logger.warn({ event: 'QUOTA_EXCEEDED', userId: String(user._id), role: user.role, operation: metric });
          return sendError(res, 403, `Limit exceeded: ${metric}`);
        }
        const result = await User.updateOne(
          {
            _id: user._id,
            $or: [
              { [`usage.${metric}`]: { $lt: limit } },
              { [`usage.${metric}`]: { $exists: false } }
            ]
          },
          { $inc: { [`usage.${metric}`]: 1 } }
        );
        if (!result.modifiedCount) {
          logger.warn({ event: 'QUOTA_EXCEEDED', userId: String(user._id), role: user.role, operation: metric });
          return sendError(res, 403, `Limit exceeded: ${metric}`);
        }
        reserved = true;
      } else {
        await incrementUsage(user._id, { [metric]: 1 });
        reserved = true;
      }

      res.once('finish', () => {
        if (reserved && res.statusCode >= 400) {
          User.updateOne(
            { _id: user._id, [`usage.${metric}`]: { $gt: 0 } },
            { $inc: { [`usage.${metric}`]: -1 } }
          ).catch(() => {});
        }
      });
      return next();
    } catch (err) {
      return sendError(res, 500, `Failed to validate ${label} entitlement`);
    }
  };
}

function reserveAiWorksheetUsage() {
  return reserveAiFeatureUsage({ metric: 'aiWorksheets', featureFlag: 'aiWorksheets', label: 'AI worksheets' });
}

function reserveAiFlashcardUsage() {
  return reserveAiFeatureUsage({ metric: 'aiFlashcards', featureFlag: 'aiFlashcards', label: 'AI flashcards' });
}

module.exports = {
  bytesToMB,
  getLimit,
  ensureActivePlan,
  assignPlanToUser,
  enforceUsageLimit,
  enforceStorageLimitFromUploadedFile,
  enforceStorageLimitFromUploadedFiles,
  reserveAiFlashcardUsage,
  reserveAiWorksheetUsage,
  incrementUsage,
  tryDeleteUploadedFile
};
