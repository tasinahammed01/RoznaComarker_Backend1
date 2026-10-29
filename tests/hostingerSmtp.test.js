'use strict';
jest.mock('nodemailer', () => ({ createTransport: jest.fn(), }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { emailReadiness, smtpTransportOptions } = require('../src/services/emailReadiness.service');
const config = () => ({ SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
  SMTP_USER: 'noreply@roznahub.com', SMTP_PASS: 'synthetic-test-password',
  MAIL_FROM_EMAIL: 'noreply@roznahub.com', MAIL_FROM_NAME: 'Rozna Co-Marker' });

test('Hostinger uses explicit mailbox authentication and bounded TLS transport', () => {
  expect(emailReadiness(config()).ready).toBe(true);
  expect(smtpTransportOptions(config())).toMatchObject({ host: 'smtp.hostinger.com', port: 465,
    secure: true, requireTLS: true, auth: { user: config().SMTP_USER, pass: config().SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, logger: false, debug: false });
  expect(smtpTransportOptions({ ...config(), SMTP_PORT: '587', SMTP_SECURE: 'false' }))
    .toMatchObject({ secure: false, requireTLS: true });
});
test.each(['SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM_EMAIL'])('Hostinger requires %s', key => {
  const env = config(); delete env[key];
  expect(emailReadiness(env)).toMatchObject({ ready: false, missing: [key] });
});
test.each([
  { SMTP_PORT: 'abc' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' }, { SMTP_PORT: '25' },
  { SMTP_SECURE: 'false' }, { SMTP_SECURE: 'yes' }, { SMTP_PORT: '587' },
  { SMTP_USER: 'resend' }, { MAIL_FROM_EMAIL: 'noreply@mail.roznahub.com' },
  { SMTP_PASS: 'YOUR_HOSTINGER_MAILBOX_PASSWORD' }, { SMTP_PASS: 'REPLACE_WITH_SECURE_HOSTINGER_MAILBOX_PASSWORD' }
])('rejects invalid or mixed Hostinger configuration (%j)', override => {
  const env = { ...config(), ...override };
  expect(emailReadiness(env).ready).toBe(false);
  expect(() => smtpTransportOptions(env)).toThrow('Email configuration unavailable');
});
test('concurrent guest and teacher mail reuse one transport and preserve private links without logs', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, config());
    let mail; let smtp; let logger;
    jest.isolateModules(() => { smtp = require('nodemailer'); logger = require('../src/utils/logger');
      mail = require('../src/services/email.service'); });
    const sendMail = jest.fn(async () => ({ accepted: ['synthetic@example.com'], rejected: [] }));
    smtp.createTransport.mockReturnValue({ sendMail });
    const link = 'https://school.example/guest/results/id#synthetic-private-token';
    const results = await Promise.all([
      mail.sendGuestSubmissionEmail({ to: 'synthetic@example.com', assignmentTitle: '<Essay>', returnUrl: link }),
      mail.sendGuestSubmissionEmail({ to: 'synthetic@example.com', assignmentTitle: '<Essay>', returnUrl: link, resultReady: true }),
      mail.sendTeacherSubmissionEmail({ to: 'teacher@example.com', assignmentTitle: '<Essay>', studentName: '<Guest>' })
    ]);
    expect(results.every(result => result.success)).toBe(true);
    expect(smtp.createTransport).toHaveBeenCalledTimes(1); expect(sendMail).toHaveBeenCalledTimes(3);
    for (const [message] of sendMail.mock.calls) expect(message.from).toBe('"Rozna Co-Marker" <noreply@roznahub.com>');
    expect(sendMail.mock.calls[0][0].text).toContain(link);
    expect(sendMail.mock.calls[0][0].html).toContain('&lt;Essay&gt;');
    sendMail.mockRejectedValueOnce(Object.assign(new Error('synthetic-private-token synthetic-test-password'), { responseCode: 451 }));
    expect(await mail.sendGuestSubmissionEmail({ to: 'synthetic@example.com', assignmentTitle: 'Essay', returnUrl: link }))
      .toEqual({ success: false, code: 'PROVIDER_REJECTED' });
    expect(sendMail).toHaveBeenCalledTimes(4); // No implicit send retry.
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toMatch(/synthetic-private-token|synthetic-test-password|synthetic@example/);
  } finally { process.env = saved; }
});
