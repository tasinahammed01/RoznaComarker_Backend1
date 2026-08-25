'use strict';

const mockVerifyIdToken = jest.fn();
const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockEnsureActivePlan = jest.fn();

jest.mock('../src/config/firebase', () => ({
  auth: () => ({ verifyIdToken: (...args) => mockVerifyIdToken(...args) })
}));
jest.mock('../src/models/user.model', () => ({
  findOne: (...args) => mockFindOne(...args),
  create: (...args) => mockCreate(...args)
}));
jest.mock('../src/middlewares/usage.middleware', () => ({
  ensureActivePlan: (...args) => mockEnsureActivePlan(...args)
}));

const { verifyFirebaseIdentityToken, verifyFirebaseToken } = require('../src/middlewares/firebaseAuth.middleware');
const logger = require('../src/utils/logger');

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

describe('Phase 4 Firebase to backend identity boundary', () => {
  beforeEach(() => {
    mockVerifyIdToken.mockReset();
    mockFindOne.mockReset();
    mockCreate.mockReset();
    mockEnsureActivePlan.mockReset().mockResolvedValue(undefined);
  });

  test('verification-email identity boundary requires a valid revocation-checked token without MongoDB access', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'pending-uid', email: 'pending@example.test' });
    const req = { headers: { authorization: 'Bearer pending-token' }, body: { email: 'forged@example.test' } };
    const next = jest.fn();
    await verifyFirebaseIdentityToken(req, responseRecorder(), next);
    expect(mockVerifyIdToken).toHaveBeenCalledWith('pending-token', true);
    expect(req.firebase).toEqual({ uid: 'pending-uid', email: 'pending@example.test' });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('verification-email identity boundary rejects missing credentials', async () => {
    const res = responseRecorder();
    await verifyFirebaseIdentityToken({ headers: {}, body: {} }, res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test('uses only verified Firebase identity and checks revocation', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'verified-uid', email: 'Verified@Example.test', name: 'Verified User'
    });
    mockFindOne.mockResolvedValue(null);
    const created = { _id: 'mongo-user', firebaseUid: 'verified-uid', email: 'verified@example.test', role: null, isActive: true };
    mockCreate.mockResolvedValue(created);
    const req = {
      headers: { authorization: 'Bearer firebase-id-token' },
      body: { uid: 'forged-uid', email: 'attacker@example.test', intendedRole: 'student' }
    };
    const res = responseRecorder();
    const next = jest.fn();

    await verifyFirebaseToken(req, res, next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith('firebase-id-token', true);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      firebaseUid: 'verified-uid', email: 'verified@example.test', displayName: 'Verified User'
    }));
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('role');
    expect(mockCreate.mock.calls[0][0]).not.toMatchObject({ firebaseUid: 'forged-uid' });
    expect(req.user).toBe(created);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('maps existing accounts by verified Firebase UID, never browser email', async () => {
    const existing = { _id: 'mongo-user', firebaseUid: 'verified-uid', email: 'original@example.test', role: 'teacher', isActive: true };
    mockVerifyIdToken.mockResolvedValue({ uid: 'verified-uid', email: 'changed@example.test' });
    mockFindOne.mockResolvedValue(existing);
    const req = { headers: { authorization: 'Bearer valid-token' }, body: { email: 'victim@example.test' } };
    const next = jest.fn();
    await verifyFirebaseToken(req, responseRecorder(), next);
    expect(mockFindOne).toHaveBeenCalledWith({ firebaseUid: 'verified-uid' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(req.user).toBe(existing);
  });

  test('rejects an unverified password token before MongoDB lookup or creation', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'unverified-uid', email: 'unverified@example.test', email_verified: false,
      firebase: { sign_in_provider: 'password' }
    });
    const res = responseRecorder();
    await verifyFirebaseToken({ headers: { authorization: 'Bearer valid-token' }, body: {} }, res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, code: 'EMAIL_NOT_VERIFIED',
      message: 'Please verify your email before continuing.' });
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['password', true],
    ['google.com', true]
  ])('accepts a verified %s identity', async (provider, emailVerified) => {
    const created = { _id: `mongo-${provider}`, firebaseUid: `${provider}-uid`,
      email: `${provider}@example.test`, role: null, isActive: true };
    mockVerifyIdToken.mockResolvedValue({ uid: created.firebaseUid, email: created.email,
      email_verified: emailVerified, firebase: { sign_in_provider: provider } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue(created);
    const next = jest.fn();
    await verifyFirebaseToken({ headers: { authorization: 'Bearer valid-token' }, body: {} }, responseRecorder(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('ignores client attempts to fake verification state', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'unverified-uid', email: 'unverified@example.test',
      email_verified: false, firebase: { sign_in_provider: 'password' } });
    const res = responseRecorder();
    await verifyFirebaseToken({ headers: { authorization: 'Bearer valid-token' },
      body: { email_verified: true, provider: 'google.com' } }, res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('sanitizes disabled, invalid, and forged token failures', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('sensitive Firebase internals'));
    const res = responseRecorder();
    await verifyFirebaseToken(
      { headers: { authorization: 'Bearer forged-token' }, body: {} },
      res,
      jest.fn()
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid or expired token' });
    expect(JSON.stringify(res.body)).not.toContain('sensitive');
  });

  test.each([
    ['auth/invalid-id-token', 'The provided ID token is malformed.'],
    ['auth/id-token-expired', 'Firebase ID token has expired.'],
    ['auth/id-token-revoked', 'The Firebase ID token has been revoked.'],
    ['auth/argument-error', 'Firebase ID token has incorrect aud claim for another-project.']
  ])('logs safe Firebase verification diagnostics for %s', async (code, message) => {
    const rawToken = 'eyJhbGciOiJSUzI1NiJ9.sensitive-payload.sensitive-signature';
    mockVerifyIdToken.mockRejectedValue(Object.assign(new Error(`${message} ${rawToken}`), { code }));
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = responseRecorder();
      await verifyFirebaseToken(
        { headers: { authorization: `Bearer ${rawToken}` }, body: {} }, res, jest.fn()
      );
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ success: false, message: 'Invalid or expired token' });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        event: 'firebase.idTokenVerification.failed', authStage: 'verifyIdToken', code
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(rawToken);
    } finally {
      log.mockRestore();
    }
  });
});
