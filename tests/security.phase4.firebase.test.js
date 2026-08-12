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

const { verifyFirebaseToken } = require('../src/middlewares/firebaseAuth.middleware');

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

  test('uses only verified Firebase identity and checks revocation', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'verified-uid', email: 'Verified@Example.test', name: 'Verified User'
    });
    mockFindOne.mockResolvedValue(null);
    const created = { _id: 'mongo-user', firebaseUid: 'verified-uid', email: 'verified@example.test', role: 'student', isActive: true };
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
      firebaseUid: 'verified-uid', email: 'verified@example.test'
    }));
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
});
