'use strict';
const service = require('../services/paypal/paypalPlanPurchase.service');
const fail = (res, err) => res.status(err?.statusCode || 500).json({ success: false,
  code: err?.code || 'PAYPAL_PLAN_PURCHASE_FAILED', message: err?.statusCode ? err.message : 'Payment processing failed. Please try again.' });
async function create(req, res) { try { return res.json({ success: true, data: await service.createOrder({ user: req.user,
  planSlug: req.body.planCode, billingPeriod: req.body.billingPeriod, quoteId: req.body.quoteId, attemptId: req.body.checkoutAttemptId }) }); } catch (err) { return fail(res, err); } }
async function capture(req, res) { try { return res.json({ success: true, data: await service.captureOrder({ user: req.user,
  attemptId: req.body.checkoutAttemptId }) }); } catch (err) { return fail(res, err); } }
async function cancel(req, res) { try { return res.json({ success: true, data: await service.cancel({ user: req.user,
  attemptId: req.body.checkoutAttemptId }) }); } catch (err) { return fail(res, err); } }
async function status(req, res) { try { return res.json({ success: true, data: await service.get({ user: req.user,
  attemptId: req.params.attemptId }) }); } catch (err) { return fail(res, err); } }
module.exports = { create, capture, cancel, status };
