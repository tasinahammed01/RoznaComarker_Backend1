jest.mock('../src/config/firebase', () => { throw new Error('secret initialization details'); });
const { verifyFirebaseToken } = require('../src/middlewares/firebaseAuth.middleware');
test('Firebase Admin initialization outage returns sanitized 503', async () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await verifyFirebaseToken({ headers: { authorization: 'Bearer token' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ success: false, code: 'AUTH_PROVIDER_UNAVAILABLE', message: 'Authentication provider is temporarily unavailable' });
});
