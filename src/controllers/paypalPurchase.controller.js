'use strict';

const service = require('../services/paypal/paypalPurchase.service');
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
async function capabilities(_req, res) {
  const config = getPaypalConfig();
  const paypalCheckout = isPaypalEnabled();
  const cardTopups = paypalCheckout;
  return res.json({ success: true, data: { provider: 'paypal', environment: config.environment,
    clientId: config.clientId, paypalCheckout,
    advancedCardPayments: isPaypalAdvancedCardEnabled(), cardTopups, cardSubscriptions: false,
    subscriptionCheckout: paypalCheckout, subscriptionHostedCardFunding: 'unknown', embeddedCardSubscriptions: false,
  } });
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

module.exports = { capabilities, createOrder, createCardOrder, capture, cancel, status };
