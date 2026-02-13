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
    const plans = await Plan.find({ isActive: true }).lean();

    plans.sort((a, b) => {
      const ap = typeof a.price === 'number' && Number.isFinite(a.price) ? a.price : null;
      const bp = typeof b.price === 'number' && Number.isFinite(b.price) ? b.price : null;

      if (ap === null && bp === null) return 0;
      if (ap === null) return 1;
      if (bp === null) return -1;
      return ap - bp;
    });

    return sendSuccess(res, plans);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch plans');
  }
}

module.exports = {
  getActivePlans
};
