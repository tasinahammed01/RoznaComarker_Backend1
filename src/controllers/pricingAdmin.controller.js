'use strict';
const { packRejection } = require('../services/creditPackPolicy');
const logger = require('../utils/logger');
const Plan = require('../models/Plan');
const CreditPack = require('../models/CreditPack');
const {configuredProviderName}=require('../services/payments/paymentProvider.service');const {isPaypalEnabled}=require('../config/paypal');const pricingRealtime=require('../services/pricingRealtime.service');

const PLAN_FIELDS = new Set(['name','monthlyCredits','monthlyPrice','annualPrice','active','displayOrder','recommended','softThresholdPercent','warningThresholdPercent','stripeProductId','stripeMonthlyPriceId','stripeAnnualPriceId']);
const PACK_FIELDS = new Set(['name','credits','price','currency','active','allowedPlans','displayOrder','stripePriceId']);
const CANONICAL = new Set(['free','essential','essential_monthly','essential_annual','pro','pro_monthly','pro_annual']);
const fail = (res, status, message, code = 'PRICING_CONFIG_INVALID', field) => res.status(status).json({ success: false, code, message, ...(field ? { field } : {}) });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const nested = (value, key, fallback) => value && value[key] !== undefined && value[key] !== null ? value[key] : fallback;
const publishPricingUpdate=value=>{try{return pricingRealtime.publishPricingConfigUpdated(value)}catch{logger.error({event:'pricing_config_publish_failed'});return null}};

function planKind(slug) {
  if (slug === 'institution' || slug === 'custom') return 'institution';
  return CANONICAL.has(slug) ? 'canonical' : 'legacy';
}
function planDto(plan) {
  const slug = text(plan.slug).toLowerCase();
  return { name: text(plan.name) || 'Unnamed legacy plan', slug, monthlyPrice: finite(plan.price) ? plan.price : 0,
    annualPrice: finite(plan.annualPrice) ? plan.annualPrice : null, currency: text(plan.currency).toUpperCase() || 'USD',
    monthlyCredits: Number.isInteger(plan.features?.essayAnalysesPerMonth) ? plan.features.essayAnalysesPerMonth : 0,
    active: plan.isActive === true, recommended: (plan.popular ?? plan.isPopular) === true,
    displayOrder: Number.isInteger(plan.displayOrder) ? plan.displayOrder : 0,
    assessmentCreditNudges: { softThresholdPercent: nested(plan.assessmentCreditNudges,'softThresholdPercent',50), warningThresholdPercent: nested(plan.assessmentCreditNudges,'warningThresholdPercent',80) },
    stripe: { productId: text(plan.stripe?.productId), monthlyPriceId: text(plan.stripe?.monthlyPriceId || plan.stripe?.priceId), annualPriceId: text(plan.stripe?.annualPriceId) },
    kind: planKind(slug), editable: Boolean(slug) };
}
function packDto(pack) { return { name:text(pack.name),code:text(pack.code).toUpperCase(),credits:Number(pack.credits)||0,
  price:finite(pack.price)?pack.price:0,currency:text(pack.currency).toUpperCase()||'USD',active:pack.active===true,
  allowedPlans:Array.isArray(pack.allowedPlans)?pack.allowedPlans.map(value=>text(value).toLowerCase()).filter(Boolean):[],
  displayOrder:Number.isInteger(pack.displayOrder)?pack.displayOrder:0,stripePriceId:text(pack.stripePriceId) }; }

async function getConfig(req, res) {
  const [plans, packs] = await Promise.all([Plan.find().sort({ displayOrder: 1, slug: 1 }).lean(), CreditPack.find().sort({ displayOrder: 1, code: 1 }).lean()]);
  const activePaymentProvider=configuredProviderName();return res.json({ success: true, plans: plans.map(planDto), packs: packs.map(packDto), provider:{activePaymentProvider,paypalEnabled:isPaypalEnabled(),stripeEnabled:false} });
}
function validateExact(body, fields, res) { const unsupported=Object.keys(body).filter(key=>!fields.has(key));if(unsupported.length){fail(res,400,`Unsupported field: ${unsupported[0]}.`,'PRICING_FIELD_UNSUPPORTED',unsupported[0]);return false}return true; }
function validatePlan(body,res){
  if(!validateExact(body,PLAN_FIELDS,res))return false;
  if(!text(body.name)){fail(res,400,'Display name is required.','PLAN_NAME_REQUIRED','name');return false}
  if(!Number.isInteger(body.monthlyCredits)||body.monthlyCredits<0){fail(res,400,'Monthly Assessment Credits must be a non-negative integer.','PLAN_CREDITS_INVALID','monthlyCredits');return false}
  if(!finite(body.monthlyPrice)||body.monthlyPrice<0){fail(res,400,'Monthly price must be zero or greater.','PLAN_MONTHLY_PRICE_INVALID','monthlyPrice');return false}
  if(body.annualPrice!==null&&(!finite(body.annualPrice)||body.annualPrice<0)){fail(res,400,'Annual price must be zero or greater.','PLAN_ANNUAL_PRICE_INVALID','annualPrice');return false}
  if(!Number.isInteger(body.displayOrder)||body.displayOrder<0){fail(res,400,'Display order must be a non-negative integer.','PLAN_DISPLAY_ORDER_INVALID','displayOrder');return false}
  if(typeof body.active!=='boolean'){fail(res,400,'Active must be a boolean.','PLAN_ACTIVE_INVALID','active');return false}
  if(typeof body.recommended!=='boolean'){fail(res,400,'Recommended must be a boolean.','PLAN_RECOMMENDED_INVALID','recommended');return false}
  if(!finite(body.softThresholdPercent)||body.softThresholdPercent<0||body.softThresholdPercent>99){fail(res,400,'Soft threshold must be between 0 and 99.','PLAN_SOFT_THRESHOLD_INVALID','softThresholdPercent');return false}
  if(!finite(body.warningThresholdPercent)||body.warningThresholdPercent<1||body.warningThresholdPercent>100){fail(res,400,'Warning threshold must be between 1 and 100.','PLAN_WARNING_THRESHOLD_INVALID','warningThresholdPercent');return false}
  if(body.softThresholdPercent>=body.warningThresholdPercent){fail(res,400,'Soft threshold must be lower than warning threshold.','PLAN_THRESHOLD_ORDER_INVALID','softThresholdPercent');return false}
  for(const field of ['stripeProductId','stripeMonthlyPriceId','stripeAnnualPriceId'])if(body[field]!==undefined&&typeof body[field]!=='string'){fail(res,400,`${field} must be a string.`,'PLAN_STRIPE_FIELD_INVALID',field);return false}
  return true;
}
async function updatePlan(req,res){const slug=text(req.params.slug).toLowerCase(),plan=await Plan.findOne({slug});if(!plan)return fail(res,404,'Plan not found.','PLAN_NOT_FOUND');const body=req.body||{};if(!validatePlan(body,res))return;
  plan.name=text(body.name);plan.features=plan.features||{};plan.features.essayAnalysesPerMonth=body.monthlyCredits;plan.price=body.monthlyPrice;plan.annualPrice=body.annualPrice;
  plan.isActive=body.active;plan.displayOrder=body.displayOrder;plan.popular=body.recommended;plan.assessmentCreditNudges={softThresholdPercent:body.softThresholdPercent,warningThresholdPercent:body.warningThresholdPercent};
  plan.stripe=plan.stripe||{};if(body.stripeProductId!==undefined)plan.stripe.productId=text(body.stripeProductId)||undefined;if(body.stripeMonthlyPriceId!==undefined)plan.stripe.monthlyPriceId=text(body.stripeMonthlyPriceId)||undefined;if(body.stripeAnnualPriceId!==undefined)plan.stripe.annualPriceId=text(body.stripeAnnualPriceId)||undefined;
  await plan.save();publishPricingUpdate({entity:'plan',key:slug});return res.json({success:true,plan:planDto(plan.toObject())});}
async function savePack(req,res,create=false){const code=text(create?req.body?.code:req.params.code).toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(code))return fail(res,400,'Pack code is invalid.','PACK_CODE_INVALID','code');const body={...(req.body||{})};if(create)delete body.code;const pack=create?new CreditPack({code}):await CreditPack.findOne({code});if(!pack)return fail(res,404,'Credit pack not found.','CREDIT_PACK_NOT_FOUND');if(!validateExact(body,PACK_FIELDS,res))return;
 const allowedPlans=Array.isArray(body.allowedPlans)?[...new Set(body.allowedPlans.map(value=>text(value).toLowerCase()).filter(Boolean))]:[];const validPlanCount=await Plan.countDocuments({slug:{$in:allowedPlans}});
 if(!text(body.name))return fail(res,400,'Credit pack name is required.','PACK_NAME_REQUIRED','name');if(!Number.isInteger(body.credits)||body.credits<1)return fail(res,400,'Assessment Credits must be a positive integer.','PACK_CREDITS_INVALID','credits');if(!finite(body.price)||body.price<0)return fail(res,400,'Price must be zero or greater.','PACK_PRICE_INVALID','price');if(!/^[A-Z]{3}$/.test(text(body.currency).toUpperCase()))return fail(res,400,'Currency must be a three-letter code.','PACK_CURRENCY_INVALID','currency');if(!Number.isInteger(body.displayOrder)||body.displayOrder<0)return fail(res,400,'Display order must be a non-negative integer.','PACK_DISPLAY_ORDER_INVALID','displayOrder');if(typeof body.active!=='boolean')return fail(res,400,'Active must be a boolean.','PACK_ACTIVE_INVALID','active');if(!allowedPlans.length||validPlanCount!==allowedPlans.length)return fail(res,400,'Select only valid allowed plans.','PACK_ALLOWED_PLANS_INVALID','allowedPlans');if(body.stripePriceId!==undefined&&typeof body.stripePriceId!=='string')return fail(res,400,'Stripe one-time Price ID must be a string.','PACK_STRIPE_PRICE_INVALID','stripePriceId');
 pack.name=text(body.name);pack.credits=body.credits;pack.price=body.price;pack.currency=text(body.currency).toUpperCase();pack.active=body.active;pack.allowedPlans=allowedPlans;pack.displayOrder=body.displayOrder;if(body.stripePriceId!==undefined)pack.stripePriceId=text(body.stripePriceId)||null;if(pack.active){const rejection=packRejection(pack);if(rejection)return fail(res,400,`Active credit pack is not purchasable: ${rejection}.`,'PACK_NOT_PURCHASABLE');}try{await pack.save()}catch(error){if(error?.code===11000)return fail(res,409,'The pack code or payment price reference already exists.','PACK_DUPLICATE');throw error}if(create)res.status(201);publishPricingUpdate({entity:'credit_pack',key:code});return res.json({success:true,pack:packDto(pack.toObject())});}
async function createPack(req,res){return savePack(req,res,true)}
async function updatePack(req,res){return savePack(req,res,false)}

module.exports={getConfig,updatePlan,updatePack,createPack,planDto,packDto,validatePlan,planKind};
