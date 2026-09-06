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
    return res.json({ success: true, data: { checkoutAttemptId: attempt.attemptId, subscriptionId: attempt.providerSubscriptionId,
      approvalUrl: attempt.approvalUrl, status: attempt.status } });
  } catch (error) { return sendError(res, error); }
}
async function reconcile(req, res) {
  try { return res.json({ success: true, data: await PayPalSubscription.reconcileCheckout({ user: req.user,
    attemptId: req.body.checkoutAttemptId, client: client() }) }); }
  catch (error) { return sendError(res, error); }
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

async function reconcileManagement(req, res) {
  try {
    const result = await PayPalManagement.reconcileManagement({ user: req.user, client: client() });
    return res.json({ success: true, data: result });
  } catch (error) { return sendManagementError(res, error); }
}

async function getChangePlanContext(req, res) {
  try {
    const { targetPlanCode, changeAttemptId } = req.body;
    if (!targetPlanCode || !changeAttemptId) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'targetPlanCode and changeAttemptId are required' });
    }
    const Plan = require('../models/Plan');
    const PaymentManagementAttempt = require('../models/PaymentManagementAttempt');
    const { getPayPalPlanId } = require('../services/paypal/paypalPlanMapping.service');
    const targetPlan = await Plan.findOne({ slug: targetPlanCode.toLowerCase(), isActive: true }).lean();
    if (!targetPlan) {
      return res.status(404).json({ success: false, code: 'PLAN_NOT_FOUND', message: 'Target plan not found' });
    }
    const attempt = await PaymentManagementAttempt.findOne({ provider: 'paypal', attemptId: changeAttemptId, userId: req.user._id });
    if (!attempt || attempt.operation !== 'CHANGE_PLAN') {
      return res.status(404).json({ success: false, code: 'ATTEMPT_NOT_FOUND', message: 'Plan change attempt not found' });
    }
    if (attempt.status === 'cancelled') {
      return res.status(409).json({ success: false, code: 'ATTEMPT_CANCELLED', message: 'Plan change attempt was cancelled' });
    }
    if (attempt.status === 'completed') {
      return res.status(409).json({ success: false, code: 'ATTEMPT_COMPLETED', message: 'Plan change already completed' });
    }
    const targetPayPalPlanId = await getPayPalPlanId({ planKey: targetPlan.slug, billingInterval: targetPlan.billingInterval === 'year' ? 'yearly' : 'monthly' });
    return res.json({
      success: true,
      data: {
        changeAttemptId,
        providerSubscriptionId: attempt.providerSubscriptionId,
        targetPayPalPlanId,
        targetPlanCode: targetPlan.slug,
        currency: 'USD',
        targetPlanName: targetPlan.name,
        targetPlanPrice: targetPlan.price,
        targetBillingInterval: targetPlan.billingInterval
      }
    });
  } catch (error) {
    return res.status(error?.statusCode || 502).json({ success: false, code: error?.code || 'CONTEXT_FETCH_FAILED', message: error?.message || 'Failed to fetch plan change context' });
  }
}

async function reconcilePlanChange(req, res) {
  try {
    const { changeAttemptId } = req.body;
    if (!changeAttemptId) {
      return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'changeAttemptId is required' });
    }
    const PaymentManagementAttempt = require('../models/PaymentManagementAttempt');
    const { syncSubscription } = require('../services/paypal/paypalSubscription.service');
    const { PayPalClient } = require('../services/paypal/paypalClient.service');
    const attempt = await PaymentManagementAttempt.findOne({ provider: 'paypal', attemptId: changeAttemptId, userId: req.user._id });
    if (!attempt || attempt.operation !== 'CHANGE_PLAN') {
      return res.status(404).json({ success: false, code: 'ATTEMPT_NOT_FOUND', message: 'Plan change attempt not found' });
    }
    if (attempt.status === 'cancelled') {
      return res.status(409).json({ success: false, code: 'ATTEMPT_CANCELLED', message: 'Plan change attempt was cancelled' });
    }
    if (attempt.status === 'completed') {
      return res.json({ success: true, data: { status: 'completed', targetPlanCode: attempt.targetPlanKey } });
    }
    const client = new PayPalClient();
    const subscription = await client.getSubscription(attempt.providerSubscriptionId);
    if (!subscription || String(subscription.id) !== attempt.providerSubscriptionId) {
      return res.status(502).json({ success: false, code: 'PAYPAL_SUBSCRIPTION_NOT_FOUND', message: 'Unable to confirm PayPal subscription' });
    }
    const syncResult = await syncSubscription(subscription);
    await PaymentManagementAttempt.findOneAndUpdate({ _id: attempt._id }, { $set: { status: 'completed', completedAt: new Date() } });
    return res.json({ success: true, data: { status: 'completed', targetPlanCode: attempt.targetPlanKey, providerStatus: subscription.status } });
  } catch (error) {
    return res.status(error?.statusCode || 502).json({ success: false, code: error?.code || 'RECONCILE_FAILED', message: error?.message || 'Failed to reconcile plan change' });
  }
}

module.exports = { cancel, changePlan, changePlanCancelled, create, getChangePlanContext, reconcile, reconcileManagement, reconcilePlanChange };
