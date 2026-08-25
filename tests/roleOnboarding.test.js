process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const User = require('../src/models/user.model');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');

describe('one-time role onboarding', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await seedTestPlans(); });
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); await seedTestPlans(); });

  async function rolelessUser(suffix) {
    return User.create({ firebaseUid: `roleless-${suffix}`, email: `roleless-${suffix}@example.test` });
  }

  test.each(['teacher', 'student'])('allows a roleless user to select %s and returns a refreshed token', async (role) => {
    const user = await rolelessUser(role);
    expect(user.role).toBeNull();
    const token = signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: null });
    const response = await request(app).patch('/api/users/me/role')
      .set('Authorization', `Bearer ${token}`).send({ role });

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe(role);
    expect(jwt.verify(response.body.token, process.env.JWT_SECRET).role).toBe(role);
    expect((await User.findById(user._id)).role).toBe(role);
  });

  test('rejects unauthenticated, arbitrary, and privileged role selection', async () => {
    expect((await request(app).patch('/api/users/me/role').send({ role: 'teacher' })).status).toBe(401);
    const user = await rolelessUser('invalid');
    const token = signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: null });
    for (const role of ['admin', 'owner', '']) {
      const response = await request(app).patch('/api/users/me/role')
        .set('Authorization', `Bearer ${token}`).send({ role });
      expect(response.status).toBe(400);
    }
  });

  test.each(['teacher', 'student', 'admin'])('does not overwrite finalized %s roles', async (role) => {
    const user = await User.create({ firebaseUid: `final-${role}`, email: `final-${role}@example.test`, role });
    const token = signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role });
    const response = await request(app).patch('/api/users/me/role')
      .set('Authorization', `Bearer ${token}`).send({ role: role === 'student' ? 'teacher' : 'student' });
    expect(response.status).toBe(409);
    expect((await User.findById(user._id)).role).toBe(role);
  });
});
