'use strict';

const { PayPalClient } = require('../services/paypal/paypalClient.service');
const PayPalSubscription = require('../services/paypal/paypalSubscription.service');
const PayPalManagement = require('../services/paypal/paypalSubscriptionManagement.service');
const logger = require('../utils/logger');

function client() { return new PayPalClient(); }
function sendError(res, error) {
  return res.status(error?.statusCode || 502).json({ success: false,
    code: error?.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED', message: error?.message || 'PayPal subscription request failed' });
}

function sendManagementError(res, error) {
  return res.status(error?.statusCode || 502).json({ success: false,
    code: error?.code || 'PAYPAL_SUBSCRIPTION_NOT_MANAGEABLE',
    message: error?.message || 'PayPal subscription management failed' });
}

async function create(req, res) {
  try {
    const attempt = await PayPalSubscription.createSubscription({ user: req.user, planKey: req.body.planCode,
      attemptId: req.body.checkoutAttemptId, client: client() });
    logger.info(`[PAYPAL] subscription created userId=${req.user._id} planKey=${attempt.planKey} subscriptionId=${attempt.providerSubscriptionId}`);
    return res.json({ success: true, data: { subscriptionId: attempt.providerSubscriptionId,
      approvalUrl: attempt.approvalUrl, status: attempt.status } });
  } catch (error) { return sendError(res, error); }
}

async function cancel(req, res) {
  try {
    const result = await PayPalManagement.cancelSubscription({ user: req.user, client: client() });
    return res.json({ success: true, data: { pending: !!result.pending,
      alreadyTerminal: !!result.alreadyTerminal, status: result.status,
      attemptId: result.attempt?.attemptId || null } });
  } catch (error) { return sendManagementError(res, error); }
}

async function changePlan(req, res) {
  try {
    const result = await PayPalManagement.changePlan({ user: req.user, targetPlanCode: req.body.targetPlanCode,
      changeAttemptId: req.body.changeAttemptId, client: client() });
    return res.json({ success: true, data: { attemptId: result.attempt.attemptId,
      status: result.attempt.status, targetPlanCode: result.attempt.targetPlanKey,
      requiresApproval: result.requiresApproval, approvalUrl: result.attempt.approvalUrl || null } });
  } catch (error) { return sendManagementError(res, error); }
}

async function changePlanCancelled(req, res) {
  try {
    const attempt = await PayPalManagement.markChangePlanCancelled({ user: req.user, changeAttemptId: req.body.changeAttemptId });
    return res.json({ success: true, data: { attemptId: attempt.attemptId, status: attempt.status } });
  } catch (error) { return sendManagementError(res, error); }
}

module.exports = { cancel, changePlan, changePlanCancelled, create };
