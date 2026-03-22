const Plan = require('../models/Plan');

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

async function getActivePlans(req, res) {
  try {
    const rawPlans = await Plan.find({ isActive: true })
      .sort({ price: 1, createdAt: 1 })
      .lean();

    const toSlug = (p) => {
      const name = typeof p?.name === 'string' ? p.name.trim().toLowerCase() : '';
      if (name === 'free') return 'free';
      if (name.includes('starter') && String(p?.billingType).toLowerCase() === 'monthly') return 'expert';
      if (String(p?.billingType).toLowerCase() === 'custom' || name === 'custom') return 'researcher';
      if (name.includes('starter') && String(p?.billingType).toLowerCase() === 'yearly') return 'researcher';
      return name.replace(/\s+/g, '-');
    };

    const mapped = rawPlans.map((p) => {
      const slug = toSlug(p);
      const limits = p && typeof p.limits === 'object' ? p.limits : {};

      const isPaid = typeof p.price === 'number' && p.price > 0;

      return {
        name: p.name,
        slug,
        price: typeof p.price === 'number' ? p.price : null,
        currency: 'USD',
        description: p.description ?? null,
        badgeText: p.badgeText ?? null,
        isPopular: !!p.isPopular,
        features: {
          classes: typeof limits.classes === 'number' ? limits.classes : null,
          maxStudentsPerClass: typeof limits.students === 'number' ? limits.students : null,
          essaysPerMonth: typeof limits.submissions === 'number' ? limits.submissions : null,
          storageMB: typeof limits.storageMB === 'number' ? limits.storageMB : null,
          storageGB: null,
          aiTokens: isPaid ? 'unlimited' : 'limited',
          priorityProcessing: isPaid,
          analyticsAccess: isPaid
        }
      };
    });

    const bySlug = new Map();
    for (const p of mapped) {
      if (!p || !p.slug) continue;
      if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
    }

    const ordered = ['free', 'expert', 'researcher']
      .map((slug) => bySlug.get(slug))
      .filter(Boolean);

    return sendSuccess(res, ordered);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch plans');
  }
}

module.exports = {
  getActivePlans
};
