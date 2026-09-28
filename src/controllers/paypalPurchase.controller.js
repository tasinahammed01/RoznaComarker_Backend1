'use strict';

const service = require('../services/paypal/paypalPurchase.service');
const { PayPalClient } = require('../services/paypal/paypalClient.service');
const { getPaypalConfig, isPaypalAdvancedCardEnabled, isPaypalEnabled } = require('../config/paypal');

function fail(res, error) {
  return res.status(error?.statusCode || 500).json({ success: false, code: error?.code || 'PAYPAL_PURCHASE_FAILED',
    message: error?.statusCode ? error.message : 'Payment processing failed. Please try again.' });
}

async function createOrder(req, res) {
  try { return res.json({ success: true, data: await service.createOrder({ user: req.user,
    packCode: req.body.packCode, attemptId: req.body.checkoutAttemptId }) }); }
  catch (error) { return fail(res, error); }
}
async function createCardOrder(req, res) {
  try { return res.json({ success: true, data: await service.createOrder({ user: req.user,
    packCode: req.body.packCode, attemptId: req.body.checkoutAttemptId, fundingSource: 'card' }) }); }
  catch (error) { return fail(res, error); }
}
function capabilities(_req, res) {
  const config = getPaypalConfig();
  const paypalCheckout = isPaypalEnabled();
  const cardTopups = paypalCheckout;
  return res.json({ success: true, data: { provider: 'paypal', environment: config.environment,
    clientId: config.clientId, paypalCheckout,
    advancedCardPayments: isPaypalAdvancedCardEnabled(), embeddedCardFields: isPaypalAdvancedCardEnabled(),
    cardTopups, cardSubscriptions: false,
    subscriptionCheckout: paypalCheckout, subscriptionHostedCardFunding: 'unknown', embeddedCardSubscriptions: false,
  } });
}
async function cardClientToken(_req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isPaypalAdvancedCardEnabled()) {
    return res.status(409).json({ success: false, code: 'CARD_NOT_ELIGIBLE',
      message: 'Embedded card checkout is not available for this PayPal account.' });
  }
  try {
    const token = await new PayPalClient().generateClientToken();
    return res.json({ success: true, data: { browserToken: token.accessToken } });
  } catch {
    return res.status(503).json({ success: false, code: 'PAYPAL_CARD_FIELDS_UNAVAILABLE',
      message: 'PayPal card checkout is temporarily unavailable. Please use PayPal or try again.' });
  }
}
async function capture(req, res) {
  try { return res.json({ success: true, data: await service.captureOrder({ user: req.user,
    attemptId: req.body.checkoutAttemptId }) }); }
  catch (error) { return fail(res, error); }
}
async function cancel(req, res) {
  try { return res.json({ success: true, data: await service.cancelAttempt({ user: req.user,
    attemptId: req.body.checkoutAttemptId }) }); }
  catch (error) { return fail(res, error); }
}
async function status(req, res) {
  try { return res.json({ success: true, data: await service.getAttempt({ user: req.user,
    attemptId: req.params.attemptId }) }); }
  catch (error) { return fail(res, error); }
}

module.exports = { capabilities, cardClientToken, createOrder, createCardOrder, capture, cancel, status };
