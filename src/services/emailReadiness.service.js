'use strict';

// Return only fixed diagnostic codes and field names, never provider messages or values.
const value = (env, key) => String(env[key] || '').trim();
function secureValue(env) {
  const text = value(env, 'SMTP_SECURE').toLowerCase();
  return text === '' || text === 'false' ? false : text === 'true' ? true : null;
}
function emailReadiness(env = process.env) {
  const resend = value(env, 'SMTP_HOST').toLowerCase() === 'smtp.resend.com' || value(env, 'SMTP_USER') === 'resend';
  // Retain legacy SMTP defaults, but never infer a sender from Resend's fixed username.
  const required = resend ? ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM_EMAIL'] : ['SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter(key => !value(env, key));
  if (/^(?:YOUR_RESEND_API_KEY|YOUR_API_KEY|replace[_-].*)$/i.test(value(env, 'SMTP_PASS')) && !missing.includes('SMTP_PASS')) missing.push('SMTP_PASS');
  if (missing.length) return { ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing };
  const from = env.MAIL_FROM_EMAIL || env.SMTP_USER;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(from || '')
      || /[\r\n]/.test(env.MAIL_FROM_NAME || '')) {
    return { ready: false, code: 'INVALID_FROM_ADDRESS', missing: [] };
  }
  const portText = value(env, 'SMTP_PORT') || '587';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing: ['VALID_SMTP_PORT'] };
  }
  const secure = secureValue(env);
  if (secure === null || (resend && (([465, 2465].includes(port) && !secure)
      || ([25, 587, 2587].includes(port) && secure)))) {
    return { ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing: ['VALID_SMTP_SECURE'] };
  }
  if (resend && (value(env, 'SMTP_USER') !== 'resend' || value(env, 'SMTP_HOST').toLowerCase() !== 'smtp.resend.com'
      || ![25, 465, 587, 2465, 2587].includes(port))) {
    return { ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing: ['VALID_RESEND_SMTP_SETTINGS'] };
  }
  return { ready: true, code: 'EMAIL_CONFIG_READY', missing: [] };
}

// This object includes credentials. Pass it only to Nodemailer; never log/serialize it.
function smtpTransportOptions(env = process.env) {
  const readiness = emailReadiness(env);
  if (!readiness.ready) throw Object.assign(new Error('Email configuration unavailable'), { code: readiness.code });
  const resend = value(env, 'SMTP_HOST').toLowerCase() === 'smtp.resend.com';
  return { host: value(env, 'SMTP_HOST') || 'smtp.gmail.com', port: Number(value(env, 'SMTP_PORT') || 587),
    secure: secureValue(env), ...(resend ? { requireTLS: true } : {}),
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000,
    logger: false, debug: false };
}

function safeEmailFailure(error) {
  const code = String(error?.code || '');
  if (code === 'EMAIL_PROVIDER_NOT_CONFIGURED' || code === 'INVALID_FROM_ADDRESS' || code === 'TEMPLATE_FAILURE') return code;
  if (code === 'EAUTH' || Number(error?.responseCode) === 535) return 'SMTP_AUTH_FAILED';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return 'TIMEOUT';
  if (['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'ESOCKET', 'ETLS'].includes(code)) return 'SMTP_CONNECTION_FAILED';
  if (error?.command === 'MAIL FROM') return 'INVALID_FROM_ADDRESS';
  if (['EENVELOPE', 'EMESSAGE', 'PROVIDER_REJECTED'].includes(code) || Number(error?.responseCode) >= 400) return 'PROVIDER_REJECTED';
  return 'OTHER_SAFE_PROVIDER_FAILURE';
}
module.exports = { emailReadiness, safeEmailFailure, smtpTransportOptions };
