const mockAuth = {
  getUser: jest.fn(),
  getUserByEmail: jest.fn(),
  generateEmailVerificationLink: jest.fn(),
  generatePasswordResetLink: jest.fn()
};
const mockEmail = {
  isConfigured: jest.fn(() => true),
  sendVerificationEmail: jest.fn(),
  sendResetPasswordEmail: jest.fn()
};

jest.mock('../src/config/firebase', () => ({ auth: () => mockAuth }));
jest.mock('../src/services/emailService', () => mockEmail);
jest.mock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const logger = require('../src/utils/logger');
const controller = require('../src/controllers/transactionalAuthEmail.controller');

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

describe('Firebase action links delivered by SendGrid', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmail.isConfigured.mockReturnValue(true);
    process.env.APP_FRONTEND_URL = 'https://comarkers.roznahub.com';
    process.env.NODE_ENV = 'test';
  });

  test('verification uses authenticated Firebase record, trusted URL, and SendGrid', async () => {
    mockAuth.getUser.mockResolvedValue({ email: 'owner@example.com', emailVerified: false });
    mockAuth.generateEmailVerificationLink.mockResolvedValue('https://firebase.example/action?oobCode=secret');
    mockEmail.sendVerificationEmail.mockResolvedValue({ success: true });
    const res = response();
    await controller.sendVerificationEmail({ firebase: { uid: 'uid-1' }, body: { email: 'attacker@example.com', continueUrl: 'https://evil.example' } }, res);
    expect(mockAuth.getUser).toHaveBeenCalledWith('uid-1');
    expect(mockAuth.generateEmailVerificationLink).toHaveBeenCalledWith('owner@example.com', {
      url: 'https://comarkers.roznahub.com/verify-email', handleCodeInApp: false
    });
    expect(mockEmail.sendVerificationEmail).toHaveBeenCalledWith('owner@example.com', expect.stringContaining('firebase.example'));
    expect(res.statusCode).toBe(200);
  });

  test('password reset uses Firebase link and trusted login URL', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ email: 'person@example.com', providerData: [{ providerId: 'password' }] });
    mockAuth.generatePasswordResetLink.mockResolvedValue('https://firebase.example/reset?oobCode=secret');
    mockEmail.sendResetPasswordEmail.mockResolvedValue({ success: true });
    const res = response();
    await controller.requestPasswordReset({ body: { email: ' Person@Example.com ', continueUrl: 'https://evil.example' } }, res);
    expect(mockAuth.getUserByEmail).toHaveBeenCalledWith('person@example.com');
    expect(mockAuth.generatePasswordResetLink).toHaveBeenCalledWith('person@example.com', {
      url: 'https://comarkers.roznahub.com/login', handleCodeInApp: false
    });
    expect(res.body.message).toBe(controller.RESET_MESSAGE);
  });

  test.each([
    ['nonexistent', () => mockAuth.getUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' })],
    ['Google-only', () => mockAuth.getUserByEmail.mockResolvedValue({ email: 'person@example.com', providerData: [{ providerId: 'google.com' }] })]
  ])('%s account receives the same neutral response without sending', async (_name, arrange) => {
    arrange();
    const res = response();
    await controller.requestPasswordReset({ body: { email: 'person@example.com' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(controller.RESET_MESSAGE);
    expect(mockAuth.generatePasswordResetLink).not.toHaveBeenCalled();
    expect(mockEmail.sendResetPasswordEmail).not.toHaveBeenCalled();
  });

  test('delivery failure is generic and logs neither action link nor API key', async () => {
    process.env.SENDGRID_API_KEY = 'must-never-be-logged';
    mockAuth.getUser.mockResolvedValue({ email: 'owner@example.com', emailVerified: false });
    mockAuth.generateEmailVerificationLink.mockResolvedValue('https://firebase.example/action?oobCode=secret');
    mockEmail.sendVerificationEmail.mockResolvedValue({ success: false, statusCode: 401 });
    const res = response();
    await controller.sendVerificationEmail({ firebase: { uid: 'uid-1' }, body: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ code: 'EMAIL_DELIVERY_UNAVAILABLE' }));
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('oobCode');
    expect(logged).not.toContain(process.env.SENDGRID_API_KEY);
  });
});
