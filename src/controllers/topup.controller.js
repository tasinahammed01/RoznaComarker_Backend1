const TopupService = require('../services/topup.service');
const { configuredProviderName } = require('../services/payments/paymentProvider.service');
const { validatePaypalConfig, assertPaypalLiveEnabled, getPaypalRedirectUrls } = require('../config/paypal');

const fail = (res, error) => res.status(error?.statusCode || 500).json({ success: false,
  ...(error?.code ? { code: error.code } : {}), message: error?.statusCode ? error.message : "We couldn't start the payment. Please try again." });

async function packs(req, res) {
  try { const paymentProvider=configuredProviderName();if(paymentProvider!=='paypal')return res.status(503).json({success:false,code:'CREDIT_PURCHASES_UNAVAILABLE',message:'Credit purchases are temporarily unavailable.'});const packs=await TopupService.listPacks(req.user,{provider:'paypal'});
    if(packs.length){try{validatePaypalConfig(process.env,{purpose:'authentication'});assertPaypalLiveEnabled();getPaypalRedirectUrls('topup')}catch{return res.status(503).json({success:false,code:'CREDIT_PURCHASES_UNAVAILABLE',message:'Credit purchases are temporarily unavailable.'})}}
    return res.json({success:true,paymentProvider:'paypal',packs}); }
  catch (error) { return fail(res, error); }
}

module.exports = { packs };
