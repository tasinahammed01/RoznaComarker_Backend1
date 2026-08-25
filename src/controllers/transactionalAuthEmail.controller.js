const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const RESET_MESSAGE = 'If an account supports password sign-in, reset instructions have been sent.';

function frontendUrl(path) {
  const configured = process.env.APP_FRONTEND_URL || process.env.FRONTEND_URL;
  if (!configured) throw Object.assign(new Error('Transactional email frontend URL is not configured'), { code: 'EMAIL_CONFIG_MISSING' });
  const base = new URL(configured);
  if (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && base.hostname === 'localhost')) {
    throw Object.assign(new Error('Transactional email frontend URL must use HTTPS'), { code: 'EMAIL_CONFIG_INVALID' });
  }
  base.pathname = path;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function actionSettings(path) {
  return { url: frontendUrl(path), handleCodeInApp: false };
}

function safeLog(event, emailType, error) {
  logger.error({
    event,
    emailType,
    firebaseCode: error && error.code,
    statusCode: error && (error.statusCode || error.code),
    environment: process.env.NODE_ENV || 'development'
  });
}

async function sendVerificationEmail(req, res) {
  try {
    const admin = require('../config/firebase');
    if (!emailService.isConfigured()) throw Object.assign(new Error('Email service unavailable'), { code: 'EMAIL_CONFIG_MISSING' });
    const record = await admin.auth().getUser(req.firebase.uid);
    if (!record.email) return res.status(400).json({ success: false, message: 'This account has no email address.' });
    if (record.emailVerified) return res.json({ success: true, message: 'Verification email request accepted.' });
    const link = await admin.auth().generateEmailVerificationLink(record.email, actionSettings('/verify-email'));
    const delivery = await emailService.sendVerificationEmail({
      to: record.email, verificationLink: link, displayName: record.displayName || ''
    });
    if (!delivery.success) throw Object.assign(new Error('Email delivery failed'), { code: 'EMAIL_DELIVERY_FAILED', statusCode: delivery.statusCode });
    return res.json({ success: true, message: 'Verification email request accepted.' });
  } catch (error) {
    safeLog('transactional_email.failed', 'verification', error);
    return res.status(503).json({ success: false, code: 'EMAIL_DELIVERY_UNAVAILABLE', message: 'Unable to send the verification email right now. Please try again later.' });
  }
}

async function requestPasswordReset(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.normalize('NFKC').trim().toLowerCase() : '';
  if (!email || email.length > 320 || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }
  try {
    const admin = require('../config/firebase');
    if (!emailService.isConfigured()) throw Object.assign(new Error('Email service unavailable'), { code: 'EMAIL_CONFIG_MISSING' });
    let record;
    try {
      record = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error && error.code === 'auth/user-not-found') return res.json({ success: true, message: RESET_MESSAGE });
      throw error;
    }
    const supportsPassword = (record.providerData || []).some((provider) => provider.providerId === 'password');
    if (!supportsPassword) return res.json({ success: true, message: RESET_MESSAGE });
    const link = await admin.auth().generatePasswordResetLink(record.email || email, actionSettings('/login'));
    const delivery = await emailService.sendPasswordResetEmail({
      to: record.email || email, resetLink: link, displayName: record.displayName || ''
    });
    if (!delivery.success) throw Object.assign(new Error('Email delivery failed'), { code: 'EMAIL_DELIVERY_FAILED', statusCode: delivery.statusCode });
    return res.json({ success: true, message: RESET_MESSAGE });
  } catch (error) {
    safeLog('transactional_email.failed', 'reset', error);
    return res.status(503).json({ success: false, code: 'EMAIL_DELIVERY_UNAVAILABLE', message: 'Unable to send reset instructions right now. Please try again later.' });
  }
}

module.exports = { RESET_MESSAGE, actionSettings, requestPasswordReset, sendVerificationEmail };
