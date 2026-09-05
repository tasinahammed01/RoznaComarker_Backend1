'use strict';

const service = require('../services/paypal/paypalPurchase.service');

function fail(res, error) {
  return res.status(error?.statusCode || 500).json({ success: false, code: error?.code || 'PAYPAL_PURCHASE_FAILED',
    message: error?.statusCode ? error.message : 'Payment processing failed. Please try again.' });
}

async function createOrder(req, res) {
  try { return res.json({ success: true, data: await service.createOrder({ user: req.user,
    packCode: req.body.packCode, attemptId: req.body.checkoutAttemptId }) }); }
  catch (error) { return fail(res, error); }
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

module.exports = { createOrder, capture, cancel, status };
