'use strict';

process.env.JWT_SECRET = 'phase4-test-secret-with-at-least-32-characters';

const jwt = require('jsonwebtoken');

const mockFindById = jest.fn();
const mockEnsureActivePlan = jest.fn();
jest.mock('../src/models/user.model', () => ({ findById: (...args) => mockFindById(...args) }));
jest.mock('../src/middlewares/usage.middleware', () => ({
  ensureActivePlan: (...args) => mockEnsureActivePlan(...args)
}));

const { signJwt } = require('../src/utils/jwt');
const { verifyJwtToken } = require('../src/middlewares/jwtAuth.middleware');
const { requireRole } = require('../src/middlewares/role.middleware');

const userId = '64b000000000000000000001';

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function authenticate(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = responseRecorder();
  const next = jest.fn();
  await verifyJwtToken(req, res, next);
  return { req, res, next };
}

describe('Phase 4 backend JWT boundary', () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockEnsureActivePlan.mockReset().mockResolvedValue(undefined);
    mockFindById.mockResolvedValue({
      _id: userId,
      firebaseUid: 'firebase-user',
      role: 'teacher',
      isActive: true
    });
  });

  test('accepts a valid constrained token with subject and unique token id', async () => {
    const token = signJwt({ _id: userId, firebaseUid: 'firebase-user', role: 'teacher' });
    const result = await authenticate(token);
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.req.jwt).toMatchObject({ id: userId, sub: userId, role: 'teacher' });
    expect(result.req.jwt.jti).toEqual(expect.any(String));
    expect(mockEnsureActivePlan).toHaveBeenCalledWith(result.req.user);
  });

  test.each([
    ['missing', null, 'AUTH_REQUIRED'],
    ['malformed', 'not-a-jwt', 'AUTH_INVALID'],
    ['wrong signature', jwt.sign({ id: userId }, 'different-secret', { algorithm: 'HS256', expiresIn: '1h' }), 'AUTH_INVALID'],
    ['expired', jwt.sign({ id: userId }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -1 }), 'AUTH_EXPIRED'],
    ['unexpected algorithm', jwt.sign({ id: userId }, process.env.JWT_SECRET, { algorithm: 'HS384', expiresIn: '1h' }), 'AUTH_INVALID']
  ])('rejects %s credentials with a stable response', async (_label, token, code) => {
    const { res, next } = await authenticate(token);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ success: false, code });
  });

  test('rejects deleted and disabled users using current database state', async () => {
    const token = signJwt({ _id: userId, firebaseUid: 'firebase-user', role: 'teacher' });
    mockFindById.mockResolvedValueOnce(null);
    expect((await authenticate(token)).res.body.code).toBe('AUTH_INVALID');
    mockFindById.mockResolvedValueOnce({ _id: userId, role: 'teacher', isActive: false });
    const disabled = await authenticate(token);
    expect(disabled.res.statusCode).toBe(403);
    expect(disabled.res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  test('stale token role cannot override current server role or subscription refresh', async () => {
    const token = signJwt({ _id: userId, firebaseUid: 'firebase-user', role: 'teacher' });
    mockFindById.mockResolvedValueOnce({ _id: userId, role: 'student', isActive: true });
    const result = await authenticate(token);
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(mockEnsureActivePlan).toHaveBeenCalledTimes(1);

    const roleNext = jest.fn();
    requireRole('teacher')(result.req, result.res, roleNext);
    expect(roleNext).not.toHaveBeenCalled();
    expect(result.res.statusCode).toBe(403);
  });
});
