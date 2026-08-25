'use strict';

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../src/utils/logger');
const { EmailService } = require('../src/services/emailService');

describe('Resend transactional email service', () => {
  const env = { RESEND_API_KEY: 're_test_secret', RESEND_FROM_EMAIL: 'no-reply@roznahub.com', RESEND_FROM_NAME: 'CoMarker' };
  let send;
  let ResendClass;

  beforeEach(() => {
    jest.clearAllMocks();
    send = jest.fn().mockResolvedValue({ data: { id: 'email-id' }, error: null });
    ResendClass = jest.fn(() => ({ emails: { send } }));
  });

  test('initializes lazily with the configured key and fixed sender', async () => {
    const service = new EmailService({ env, ResendClass });
    const result = await service.sendVerificationEmail({ to: 'person@example.com', verificationLink: 'https://firebase.example/action?oobCode=sensitive' });
    expect(ResendClass).toHaveBeenCalledWith('re_test_secret');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: 'CoMarker <no-reply@roznahub.com>', to: ['person@example.com'], subject: 'Verify your CoMarker email' }));
    expect(result).toEqual({ success: true, provider: 'resend', messageId: 'email-id' });
  });

  test('missing configuration fails safely without constructing a client', async () => {
    const service = new EmailService({ env: {}, ResendClass });
    const result = await service.sendPasswordResetEmail({ to: 'person@example.com', resetLink: 'https://firebase.example/reset' });
    expect(result).toMatchObject({ success: false, provider: 'resend', code: 'EMAIL_CONFIG_MISSING' });
    expect(ResendClass).not.toHaveBeenCalled();
  });

  test.each([
    [{ error: { name: 'validation_error', statusCode: 400 } }, 400],
    [{ error: { name: 'rate_limit_exceeded', statusCode: 429 } }, 429],
    [{ error: { name: 'restricted_api_key', statusCode: 401 } }, 401],
  ])('normalizes provider error without leaking payload', async (providerResult, statusCode) => {
    send.mockResolvedValue(providerResult);
    const service = new EmailService({ env, ResendClass });
    const result = await service.sendPasswordResetEmail({ to: 'person@example.com', resetLink: 'https://firebase.example/reset?oobCode=sensitive' });
    expect(result).toMatchObject({ success: false, provider: 'resend', statusCode });
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('oobCode');
    expect(logged).not.toContain(env.RESEND_API_KEY);
  });

  test('verification and reset sends include lightweight HTML and plain text', async () => {
    const service = new EmailService({ env, ResendClass });
    await service.sendVerificationEmail({ to: 'person@example.com', verificationLink: 'https://firebase.example/verify' });
    await service.sendPasswordResetEmail({ to: 'person@example.com', resetLink: 'https://firebase.example/reset' });
    for (const call of send.mock.calls) {
      expect(call[0].html).toContain('<a href=');
      expect(call[0].text).toEqual(expect.any(String));
      expect(call[0]).not.toHaveProperty('attachments');
    }
  });
});
