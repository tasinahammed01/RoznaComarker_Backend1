'use strict';
const { emailReadiness, smtpTransportOptions } = require('../src/services/emailReadiness.service');
const { checkEmailReadiness } = require('../scripts/checkGuestEmailReadiness');
const config = () => ({ SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
  SMTP_USER: 'resend', SMTP_PASS: 'synthetic-smtp-password', MAIL_FROM_EMAIL: 'sender@mail.example.com', MAIL_FROM_NAME: 'Rozna Co-Marker' });

test('Resend SMTP uses explicit credentials, configured sender and implicit TLS', () => {
  const env = config();
  expect(emailReadiness(env)).toEqual({ ready: true, code: 'EMAIL_CONFIG_READY', missing: [] });
  expect(smtpTransportOptions(env)).toMatchObject({ host: 'smtp.resend.com', port: 465, secure: true,
    requireTLS: true, auth: { user: 'resend', pass: env.SMTP_PASS }, logger: false, debug: false });
});
test.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM_EMAIL'])('missing %s fails with field names only', key => {
  const env = config(); delete env[key];
  expect(emailReadiness(env)).toEqual({ ready: false, code: 'EMAIL_PROVIDER_NOT_CONFIGURED', missing: [key] });
});
test.each(['not-an-address', 'sender@example.com\r\nBcc: private@example.com', 'Name <sender@example.com>', 'other,sender@example.com'])('invalid sender fails safely', from => {
  expect(emailReadiness({ ...config(), MAIL_FROM_EMAIL: from }).code).toBe('INVALID_FROM_ADDRESS');
});
test.each(['yes', '1', 'enabled'])('ambiguous SMTP_SECURE %s is rejected', secure => {
  expect(emailReadiness({ ...config(), SMTP_SECURE: secure })).toMatchObject({ ready: false, missing: ['VALID_SMTP_SECURE'] });
});
test.each(['true', 'TRUE', ' true '])('SMTP_SECURE parses %s consistently for readiness and transport', secure => {
  const env = { ...config(), SMTP_SECURE: secure };
  expect(emailReadiness(env).ready).toBe(true); expect(smtpTransportOptions(env).secure).toBe(true);
});
test('STARTTLS remains required on Resend port 587; contradictory port/TLS combinations are refused', () => {
  expect(smtpTransportOptions({ ...config(), SMTP_PORT: '587', SMTP_SECURE: 'false' }))
    .toMatchObject({ port: 587, secure: false, requireTLS: true });
  expect(emailReadiness({ ...config(), SMTP_SECURE: 'false' }).ready).toBe(false);
  expect(emailReadiness({ ...config(), SMTP_PORT: '587' }).ready).toBe(false);
});
test('example placeholder is never considered a configured password', () => {
  expect(emailReadiness({ ...config(), SMTP_PASS: 'YOUR_RESEND_API_KEY' }))
    .toMatchObject({ ready: false, missing: ['SMTP_PASS'] });
});
test('legacy SMTP defaults and email-as-username sender fallback remain available', () => {
  expect(smtpTransportOptions({ SMTP_USER: 'sender@example.com', SMTP_PASS: 'synthetic-password' }))
    .toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false });
});
test('readiness-only mode never creates a transport or prints sender/password', async () => {
  const createTransport = jest.fn(); const env = config();
  const result = await checkEmailReadiness({ env, createTransport });
  expect(result).toMatchObject({ ready: true, transportVerified: false, verifyRequested: false });
  expect(createTransport).not.toHaveBeenCalled();
  expect(JSON.stringify(result).includes(env.SMTP_PASS)).toBe(false);
  expect(JSON.stringify(result).includes(env.MAIL_FROM_EMAIL)).toBe(false);
});
test('verify mode uses the exact sending options, verifies auth and closes without sending', async () => {
  const transport = { verify: jest.fn().mockResolvedValue(true), close: jest.fn(), sendMail: jest.fn() };
  const createTransport = jest.fn(() => transport); const env = config();
  expect(await checkEmailReadiness({ env, verify: true, createTransport })).toMatchObject({ ready: true, transportVerified: true });
  expect(createTransport).toHaveBeenCalledWith(smtpTransportOptions(env));
  expect(transport.verify).toHaveBeenCalledTimes(1); expect(transport.sendMail).not.toHaveBeenCalled(); expect(transport.close).toHaveBeenCalledTimes(1);
});
test.each([
  ['EAUTH', 'SMTP_AUTH_FAILED'], ['ECONNREFUSED', 'SMTP_CONNECTION_FAILED'], ['ETIMEDOUT', 'TIMEOUT'],
  ['EENVELOPE', 'PROVIDER_REJECTED'], ['UNKNOWN', 'OTHER_SAFE_PROVIDER_FAILURE']
])('verify failure %s returns only safe diagnostic data', async (code, expected) => {
  const env = config(); const transport = { verify: jest.fn().mockRejectedValue(Object.assign(new Error(env.SMTP_PASS + ' ' + env.MAIL_FROM_EMAIL), { code })), close: jest.fn() };
  const result = await checkEmailReadiness({ env, verify: true, createTransport: () => transport });
  expect(result).toMatchObject({ ready: false, code: expected, transportVerified: false });
  expect(JSON.stringify(result).includes(env.SMTP_PASS)).toBe(false); expect(JSON.stringify(result).includes(env.MAIL_FROM_EMAIL)).toBe(false);
  expect(transport.close).toHaveBeenCalled();
});
test('whole-operation verification timeout bounds even a stalled provider', async () => {
  jest.useFakeTimers();
  const close = jest.fn();
  try {
    const pending = checkEmailReadiness({ env: config(), verify: true, createTransport: () => ({ verify: () => new Promise(() => {}), close }) });
    await jest.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ ready: false, code: 'TIMEOUT', transportVerified: false });
    expect(close).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
test('invalid config never attempts SMTP verification', async () => {
  const createTransport = jest.fn();
  const result = await checkEmailReadiness({ env: { ...config(), SMTP_PASS: '' }, verify: true, createTransport });
  expect(result.code).toBe('EMAIL_PROVIDER_NOT_CONFIGURED'); expect(createTransport).not.toHaveBeenCalled();
});
