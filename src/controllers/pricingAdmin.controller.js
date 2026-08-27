const Plan = require('../models/Plan');
const CreditPack = require('../models/CreditPack');

const fail = (res, status, message, code = 'PRICING_CONFIG_INVALID') => res.status(status).json({ success: false, code, message });
const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

async function getConfig(req, res) {
  const [plans, packs] = await Promise.all([
    Plan.find().sort({ displayOrder: 1, slug: 1 }).select('name slug price annualPrice currency features.essayAnalysesPerMonth isActive displayOrder popular stripe assessmentCreditNudges').lean(),
    CreditPack.find().sort({ displayOrder: 1, code: 1 }).lean()
  ]);
  return res.json({ success: true, plans, packs });
}

async function updatePlan(req, res) {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const plan = await Plan.findOne({ slug });
  if (!plan) return fail(res, 404, 'Plan not found', 'PLAN_NOT_FOUND');
  const body = req.body || {}; const soft = num(body.softThresholdPercent); const warning = num(body.warningThresholdPercent);
  if (!String(body.name || '').trim() || num(body.monthlyCredits) === null || body.monthlyCredits < 0 ||
    num(body.monthlyPrice) === null || body.monthlyPrice < 0 || (body.annualPrice !== null && body.annualPrice !== undefined && (num(body.annualPrice) === null || body.annualPrice < 0)) ||
    soft === null || warning === null || soft < 0 || warning > 100 || soft >= warning)
    return fail(res, 400, 'Enter valid prices, credits, and thresholds. The soft threshold must be below the warning threshold.');
  plan.name = String(body.name).trim(); plan.features.essayAnalysesPerMonth = body.monthlyCredits;
  plan.price = body.monthlyPrice; plan.annualPrice = body.annualPrice ?? null; plan.isActive = !!body.active;
  plan.displayOrder = Number(body.displayOrder || 0); plan.popular = !!body.recommended;
  plan.assessmentCreditNudges = { softThresholdPercent: soft, warningThresholdPercent: warning };
  plan.stripe.productId = String(body.stripeProductId || '').trim() || undefined;
  plan.stripe.monthlyPriceId = String(body.stripeMonthlyPriceId || '').trim() || undefined;
  plan.stripe.annualPriceId = String(body.stripeAnnualPriceId || '').trim() || undefined;
  await plan.save();
  return res.json({ success: true, plan });
}

async function updatePack(req, res) {
  const code = String(req.params.code || '').trim().toUpperCase(); const pack = await CreditPack.findOne({ code });
  if (!pack) return fail(res, 404, 'Credit pack not found', 'CREDIT_PACK_NOT_FOUND');
  const body = req.body || {}; const credits = num(body.credits); const price = num(body.price);
  const allowedPlans = Array.isArray(body.allowedPlans) ? [...new Set(body.allowedPlans.map((item) => String(item).trim().toLowerCase()).filter(Boolean))] : [];
  const validPlanCount = await Plan.countDocuments({ slug: { $in: allowedPlans } });
  if (!String(body.name || '').trim() || credits === null || !Number.isInteger(credits) || credits < 1 || price === null || price < 0 ||
    !String(body.currency || '').match(/^[A-Za-z]{3}$/) || !allowedPlans.length || validPlanCount !== allowedPlans.length)
    return fail(res, 400, 'Enter a valid pack name, credits, price, currency, and allowed plans.');
  pack.name = String(body.name).trim(); pack.credits = credits; pack.price = price; pack.currency = String(body.currency).toUpperCase();
  pack.active = !!body.active; pack.allowedPlans = allowedPlans; pack.displayOrder = Number(body.displayOrder || 0);
  pack.stripePriceId = String(body.stripePriceId || '').trim() || null; await pack.save();
  return res.json({ success: true, pack });
}

module.exports = { getConfig, updatePlan, updatePack };
