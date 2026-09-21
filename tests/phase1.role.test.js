process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'phase1-role-test-secret';
jest.mock('../src/services/bonusReward.service', () => ({ grantConfiguredBonus: jest.fn().mockResolvedValue({ granted: true }) }));
const User = require('../src/models/user.model');
const { setMyRole } = require('../src/controllers/user.controller');
const { verifyJwt } = require('../src/utils/jwt');
const { grantConfiguredBonus } = require('../src/services/bonusReward.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); });
test('concurrent role finalizations have one winner, one bonus and persisted JWT role', async () => {
  const user = await User.create({ firebaseUid: 'role-race', email: 'role@example.test' });
  const snapshots = await Promise.all([User.findById(user._id), User.findById(user._id)]);
  const responses = [response(), response()];
  await Promise.all(snapshots.map((snapshot, i) => setMyRole({ user: snapshot, body: { role: 'teacher' } }, responses[i])));
  expect(responses.map(res => res.statusCode).sort()).toEqual([200, 409]);
  expect(responses.find(res => res.statusCode === 409).body.code).toBe('ROLE_ALREADY_FINALIZED');
  expect(grantConfiguredBonus).toHaveBeenCalledTimes(1);
  const persisted = await User.findById(user._id);
  expect(verifyJwt(responses.find(res => res.statusCode === 200).body.token).role).toBe(persisted.role);
});
test('admin role is rejected without changing the account', async () => {
  const user = await User.create({ firebaseUid: 'role-admin', email: 'admin@example.test' });
  const res = response(); await setMyRole({ user, body: { role: 'admin' } }, res);
  expect(res.statusCode).toBe(400); expect((await User.findById(user._id)).role).toBeNull();
});
