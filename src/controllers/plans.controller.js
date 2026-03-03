const PricingPlans = require('../models/PricingPlans');

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
    const doc = await PricingPlans.findOne({}).lean();
    const plans = Array.isArray(doc?.plans) ? doc.plans : [];

    return sendSuccess(res, plans);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch plans');
  }
}

module.exports = {
  getActivePlans
};
