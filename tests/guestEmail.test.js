'use strict';
jest.mock('nodemailer', () => {
  const transport = { sendMail: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const nodemailer = require('nodemailer');
const logger = require('../src/utils/logger');
const email = require('../src/services/email.service');
const transport = nodemailer.transport;
beforeEach(() => {
  jest.clearAllMocks(); transport.sendMail.mockReset();
  process.env.SMTP_USER = 'sender@example.com'; process.env.SMTP_PASS = 'test-only-password';
  delete process.env.MAIL_FROM_EMAIL; delete process.env.MAIL_FROM_NAME; delete process.env.SMTP_PORT;
});

test('teacher submission email uses escaped guest identity and no private guest token', async () => {
  await expect(email.sendTeacherSubmissionEmail({ to: 'teacher@example.com',
    assignmentTitle: '<script>Essay</script>', studentName: '<b>Guest</b>' })).resolves.toEqual({ success: true });
  const message = transport.sendMail.mock.calls[0][0];
  expect(message.to).toBe('teacher@example.com');
  expect(message.html).toContain('&lt;b&gt;Guest&lt;/b&gt;');
  expect(message.html).not.toContain('<script>');
  expect(message.text).toContain('(Guest)');
  expect(message.text).not.toContain('/guest/results/');
});

test('guest email uses the existing transporter, escapes content and keeps the private-link note', async () => {
  const pending = email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: '<script>Title</script>\r\nInjected',
    returnUrl: 'https://school.example/guest/results/id#private-token' });
  await pending;
  const message = transport.sendMail.mock.calls[0][0];
  expect(message.to).toBe('guest@example.com');
  expect(message.subject).not.toMatch(/[\r\n]/);
  expect(message.html).toContain('&lt;script&gt;Title&lt;/script&gt;');
  expect(message.html).not.toContain('<script>');
  expect(message.text).toContain('Keep this link private');
});
test('provider exceptions return safe delivery failure without logging the recipient or return token', async () => {
  transport.sendMail.mockRejectedValueOnce(new Error('guest@example.com https://school.example/#private-token'));
  await expect(email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'Essay',
    returnUrl: 'https://school.example/#private-token' })).resolves.toEqual({ success: false, code: 'OTHER_SAFE_PROVIDER_FAILURE' });
  expect(logger.warn).toHaveBeenCalledWith({ event: 'guest_confirmation_email_failed', code: 'OTHER_SAFE_PROVIDER_FAILURE' });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-token');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('guest@example.com');
});

test.each([false, true])('guest email card preserves canonical links and text fallback (resultReady=%s)', async resultReady => {
  transport.sendMail.mockResolvedValueOnce({ accepted: ['guest@example.com'], rejected: [] });
  const returnUrl = 'https://school.example/guest/results/507f1f77bcf86cd799439011#private-token';
  const assignmentTitle = '<Essay> & "Writing"';
  await email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle, returnUrl, resultReady });
  const message = transport.sendMail.mock.calls[0][0];
  expect(message.html).toContain('role="presentation"');
  expect(message.html).toContain('max-width:640px');
  expect(message.html).toContain('max-width:480px');
  expect(message.html).toContain('RoznaHub');
  expect(message.html).toContain('Guest Submission');
  expect(message.html).toContain(resultReady ? 'Your Feedback Is Ready' : 'Assignment Submitted Successfully');
  expect(message.html).toContain('&lt;Essay&gt; &amp; &quot;Writing&quot;');
  expect(message.html).toContain(`href="${returnUrl}"`);
  expect(message.html).toContain('href="https://school.example/guest/results/507f1f77bcf86cd799439011"');
  expect(message.html.match(/private-token/g)?.length).toBe(1);
  expect(message.html).toContain('Recover Link');
  expect(message.html).toContain('mailto:support@roznahub.com');
  expect(message.html).not.toMatch(/<script|<form|<iframe|<img/i);
  const status = resultReady ? 'feedback is ready' : 'submission was received';
  expect(message.text).toBe(`Rozna Co-Marker\n\nYour ${status} for ${assignmentTitle}.\nUse this private link to access your feedback without logging in:\n${returnUrl}\nKeep this link private. Do not share it. It expires; request a new link from the assignment page if needed.`);
});

test('missing config fails safely before touching the transport', async () => {
  delete process.env.SMTP_PASS;
  expect(email.emailReadiness()).toEqual({ ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing: ['SMTP_PASS'] });
  await expect(email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'Essay', returnUrl: 'https://school.example/#secret' }))
    .resolves.toEqual({ success: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED' });
  expect(transport.sendMail).not.toHaveBeenCalled();
});

test('readiness validates the actual SMTP configuration boundary without claiming delivery', () => {
  expect(email.emailReadiness()).toMatchObject({ ready: true, code: 'EMAIL_CONFIG_READY' });
  expect(email.emailReadiness({ SMTP_USER: 'sender@example.com', SMTP_PASS: 'test', MAIL_FROM_EMAIL: 'bad' }))
    .toMatchObject({ ready: false, code: 'INVALID_FROM_ADDRESS' });
  expect(email.emailReadiness({ SMTP_USER: 'sender@example.com', SMTP_PASS: 'test', SMTP_PORT: 'abc' }).ready).toBe(false);
});

test.each([
  [{ code: 'EAUTH', responseCode: 535 }, 'SMTP_AUTH_FAILED'],
  [{ code: 'ECONNECTION' }, 'SMTP_CONNECTION_FAILED'],
  [{ code: 'ETIMEDOUT' }, 'TIMEOUT'],
  [{ command: 'MAIL FROM', responseCode: 550 }, 'INVALID_FROM_ADDRESS'],
  [{ responseCode: 554 }, 'PROVIDER_REJECTED'],
  [{ code: 'TEMPLATE_FAILURE' }, 'TEMPLATE_FAILURE']
])('provider failure is classified without exposing arbitrary error details (%j)', async (fields, code) => {
  transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('recipient@example.com #secret SMTP_PASSWORD'), fields));
  await expect(email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'Essay', returnUrl: 'https://school.example/#secret' }))
    .resolves.toEqual({ success: false, code });
  expect(logger.warn).toHaveBeenCalledWith({ event: 'guest_confirmation_email_failed', code });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/recipient@|#secret|SMTP_PASSWORD/);
});

test('a resolved provider rejection is not reported as delivery success', async () => {
  transport.sendMail.mockResolvedValueOnce({ accepted: [], rejected: ['guest@example.com'] });
  await expect(email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'Essay', returnUrl: 'https://school.example/#secret' }))
    .resolves.toMatchObject({ success: false, code: 'PROVIDER_REJECTED' });
});

test('Resend sends through the existing Nodemailer transport with the configured sender and canonical URL unchanged', async () => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'resend',
    SMTP_PASS: 'synthetic-smtp-password', MAIL_FROM_EMAIL: 'sender@mail.example.com', MAIL_FROM_NAME: 'Rozna Co-Marker' });
  let mail; let smtp; let isolatedLogger;
  jest.isolateModules(() => {
    mail = require('../src/services/email.service'); smtp = require('nodemailer'); isolatedLogger = require('../src/utils/logger');
  });
  smtp.transport.sendMail.mockResolvedValue({ accepted: ['guest@example.com'], rejected: [] });
  const access = require('../src/services/guestAccess.service');
  const issue = jest.spyOn(access, 'issueToken');
  const link = 'https://school.example/guest/results/507f1f77bcf86cd799439011#canonical-private-fragment';
  try {
    await expect(mail.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: '<img src=x onerror=alert(1)>', returnUrl: link }))
      .resolves.toEqual({ success: true });
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.resend.com', port: 465, secure: true,
      requireTLS: true, auth: { user: 'resend', pass: 'synthetic-smtp-password' }, logger: false, debug: false }));
    const message = smtp.transport.sendMail.mock.calls.at(-1)[0];
    expect(message.from).toBe('"Rozna Co-Marker" <sender@mail.example.com>');
    expect(message.text).toContain(link); expect(message.html).toContain(`href="${link}"`);
    expect(message.html).not.toContain('<img'); expect(message.html).toContain('&lt;img');
    expect(message.text).toContain('without logging in'); expect(message.text).toContain('Do not share');
    expect(issue).not.toHaveBeenCalled();
    expect(isolatedLogger.info).toHaveBeenCalledWith({ event: 'guest_confirmation_email_sent', provider: 'smtp' });
    expect(JSON.stringify(isolatedLogger.info.mock.calls).includes('canonical-private-fragment')).toBe(false);
  } finally {
    issue.mockRestore();
    delete process.env.SMTP_HOST; delete process.env.SMTP_SECURE;
  }
});

test('class invitations still use the shared SMTP transport', async () => {
  transport.sendMail.mockResolvedValueOnce({ messageId: 'opaque-test-id' });
  await expect(email.sendInvitationEmail({ to: 'guest@example.com', className: 'Writing', classCode: 'code',
    joinUrl: 'https://school.example/join/code' })).resolves.toMatchObject({ success: true });
  expect(transport.sendMail).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith({ event: 'class_invitation_email_sent', provider: 'smtp' });
});

test('shared transport errors cannot leak provider credentials through invitation or verification paths', async () => {
  transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('synthetic-secret recipient@example.com'), { code: 'EAUTH' }));
  await expect(email.sendInvitationEmail({ to: 'guest@example.com', className: 'Writing', classCode: 'code', joinUrl: 'https://school.example/join/code' }))
    .resolves.toEqual({ success: false, error: 'SMTP_AUTH_FAILED' });
  expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/synthetic-secret|recipient@/);
});
