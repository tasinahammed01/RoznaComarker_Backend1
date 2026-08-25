'use strict';
const { Resend } = require('resend');
const logger = require('../utils/logger');
const PROVIDER = 'resend';
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const escapeHtml = (value) => String(value || '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

class EmailService {
  constructor({ env = process.env, ResendClass = Resend } = {}) { this.env = env; this.ResendClass = ResendClass; this.client = null; }
  isConfigured() { return Boolean(clean(this.env.RESEND_API_KEY) && clean(this.env.RESEND_FROM_EMAIL)); }
  getClient() {
    if (!this.isConfigured()) { const error = new Error('Resend transactional email is not configured'); error.code = 'EMAIL_CONFIG_MISSING'; throw error; }
    if (!this.client) this.client = new this.ResendClass(clean(this.env.RESEND_API_KEY));
    return this.client;
  }
  fromAddress() { return `${clean(this.env.RESEND_FROM_NAME) || 'CoMarker'} <${clean(this.env.RESEND_FROM_EMAIL)}>`; }
  async sendEmail({ to, subject, html, text }) {
    try {
      if (!clean(to) || !clean(subject) || !clean(html) || !clean(text)) { const error = new Error('Transactional email fields are incomplete'); error.code = 'EMAIL_INVALID_REQUEST'; throw error; }
      const result = await this.getClient().emails.send({ from: this.fromAddress(), to: [clean(to)], subject: clean(subject), html, text });
      if (result?.error) { const error = new Error('Resend rejected transactional email'); error.code = 'EMAIL_PROVIDER_ERROR'; error.statusCode = Number(result.error.statusCode || result.error.status) || null; throw error; }
      const messageId = clean(result?.data?.id);
      if (!messageId) { const error = new Error('Resend returned an invalid response'); error.code = 'EMAIL_PROVIDER_INVALID_RESPONSE'; throw error; }
      logger.info({ event: 'transactional_email.sent', provider: PROVIDER, status: 'success' });
      return { success: true, provider: PROVIDER, messageId };
    } catch (error) {
      logger.error({ event: 'transactional_email.failed', provider: PROVIDER, code: error?.code || 'EMAIL_PROVIDER_FAILURE', statusCode: error?.statusCode || null });
      return { success: false, provider: PROVIDER, error: 'Email delivery failed', code: error?.code || 'EMAIL_PROVIDER_FAILURE', statusCode: error?.statusCode || null };
    }
  }
  async sendVerificationEmail(input, legacyLink) {
    const options = typeof input === 'object' && input !== null ? input : { to: input, verificationLink: legacyLink };
    const to = clean(options.to); const link = clean(options.verificationLink);
    if (!to || !link) return { success: false, provider: PROVIDER, code: 'EMAIL_INVALID_REQUEST' };
    const greeting = clean(options.displayName) ? `Hello ${escapeHtml(options.displayName)},` : 'Welcome to CoMarker.'; const safeLink = escapeHtml(link);
    return this.sendEmail({ to, subject: 'Verify your CoMarker email', text: `Welcome to CoMarker.\nPlease verify your email address to continue.\n\nVerify Email: ${link}\n\nIf you did not create this account, you can ignore this email.`, html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#243044;line-height:1.5;margin:0;padding:24px"><main style="max-width:560px;margin:auto"><h1 style="font-size:24px">Verify your email</h1><p>${greeting}</p><p>Please verify your email address to continue.</p><p><a href="${safeLink}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Verify Email</a></p><p>If the button does not work, copy this URL:</p><p style="word-break:break-all">${safeLink}</p><p><strong>Security note:</strong> If you did not create this account, you can ignore this email.</p></main></body></html>` });
  }
  async sendPasswordResetEmail(input, legacyLink) {
    const options = typeof input === 'object' && input !== null ? input : { to: input, resetLink: legacyLink };
    const to = clean(options.to); const link = clean(options.resetLink);
    if (!to || !link) return { success: false, provider: PROVIDER, code: 'EMAIL_INVALID_REQUEST' };
    const greeting = clean(options.displayName) ? `<p>Hello ${escapeHtml(options.displayName)},</p>` : ''; const safeLink = escapeHtml(link);
    return this.sendEmail({ to, subject: 'Reset your CoMarker password', text: `We received a request to reset your CoMarker password.\n\nReset Password: ${link}\n\nIf you did not request a password reset, you can ignore this email.`, html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#243044;line-height:1.5;margin:0;padding:24px"><main style="max-width:560px;margin:auto"><h1 style="font-size:24px">Reset your password</h1>${greeting}<p>We received a request to reset your CoMarker password.</p><p><a href="${safeLink}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Reset Password</a></p><p>If the button does not work, copy this URL:</p><p style="word-break:break-all">${safeLink}</p><p><strong>Security note:</strong> If you did not request a password reset, you can ignore this email.</p></main></body></html>` });
  }
  sendResetPasswordEmail(input, legacyLink) { return this.sendPasswordResetEmail(input, legacyLink); }
  async sendOTPEmail(to, otp) { const code = clean(otp); return this.sendEmail({ to, subject: 'Your CoMarker verification code', text: `Your CoMarker verification code is ${code}. Do not share this code.`, html: `<p>Your CoMarker verification code is:</p><p style="font-size:28px;font-weight:bold">${escapeHtml(code)}</p><p>Do not share this code.</p>` }); }
}
module.exports = new EmailService();
module.exports.EmailService = EmailService;
