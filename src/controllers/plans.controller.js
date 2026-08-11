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
    const rawPlans = await Plan.find({ isActive: true }).lean();
    const preferredOrder = new Map([
      ['free', 0],
      ['starter_monthly', 1],
      ['custom', 2]
    ]);

    const ordered = rawPlans
      .map((plan) => ({
        name: plan.name,
        slug: plan.slug,
        price: typeof plan.price === 'number' ? plan.price : null,
        currency: plan.currency || 'USD',
        billingInterval: plan.billingInterval ?? null,
        popular: !!plan.popular,
        features: {
          maxClasses: plan.features?.maxClasses ?? null,
          maxStudents: plan.features?.maxStudents ?? null,
          essayAnalysesPerMonth: plan.features?.essayAnalysesPerMonth ?? null,
          storageMB: plan.features?.storageMB ?? null,
          aiFlashcards: !!plan.features?.aiFlashcards,
          aiFlashcardsLimit: plan.features?.aiFlashcardsLimit ?? null,
          aiWorksheets: !!plan.features?.aiWorksheets,
          aiWorksheetsLimit: plan.features?.aiWorksheetsLimit ?? null,
          adaptiveLearning: !!plan.features?.adaptiveLearning,
          adaptiveLearningLimit: plan.features?.adaptiveLearningLimit ?? null,
          priorityAIProcessing: !!plan.features?.priorityAIProcessing,
          analyticsAccess: !!plan.features?.analyticsAccess,
          dedicatedSupport: !!plan.features?.dedicatedSupport
        },
        display: {
          title: plan.display?.title ?? plan.name,
          description: plan.display?.description ?? null,
          priceLabel: plan.display?.priceLabel ?? null,
          cta: plan.display?.cta ?? null
        }
      }))
      .sort((left, right) => {
        const leftOrder = preferredOrder.get(left.slug) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = preferredOrder.get(right.slug) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || String(left.slug).localeCompare(String(right.slug));
      });

    return sendSuccess(res, ordered);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch plans');
  }
}

module.exports = {
  getActivePlans
};
