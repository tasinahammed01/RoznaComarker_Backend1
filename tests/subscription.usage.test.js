process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const request = require('supertest');

const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');

const app = require('../src/app');

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('Subscription & usage limits', () => {
  beforeAll(async () => {
    await connectInMemoryMongo();
    await Plan.seedDefaults();
  });

  afterAll(async () => {
    await disconnectInMemoryMongo();
  });

  beforeEach(async () => {
    await clearDatabase();
    await Plan.seedDefaults();
  });

  test('Free plan blocks creating more than 1 class', async () => {
    const free = await Plan.findOne({ name: 'Free' });
    const freeLimit = free && free.limits ? free.limits.classes : null;
    const limit = typeof freeLimit === 'number' ? freeLimit : 1;

    const teacher = await User.create({
      firebaseUid: 'teacher-1',
      email: 'teacher1@example.com',
      role: 'teacher'
    });

    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });

    for (let i = 0; i < limit; i += 1) {
      const res = await request(app)
        .post('/api/classes')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Class ${i + 1}` });
      expect(res.status).toBe(200);
    }

    const overflow = await request(app)
      .post('/api/classes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Overflow Class' });

    expect(overflow.status).toBe(403);
    expect(overflow.body && overflow.body.message).toMatch(/Limit exceeded: classes/i);

    const teacherAfter = await User.findById(teacher._id);
    expect(teacherAfter.usage.classes).toBe(limit);

    const classCount = await Class.countDocuments({ teacher: teacher._id });
    expect(classCount).toBe(limit);
  });

  test('Expired paid plan auto-downgrades to Free on next request', async () => {
    const paid = await Plan.findOne({ name: 'Starter Monthly' });
    expect(paid).toBeTruthy();

    const teacher = await User.create({
      firebaseUid: 'teacher-expired',
      email: 'teacher-expired@example.com',
      role: 'teacher',
      plan: paid._id,
      planStartedAt: new Date('2020-01-01T00:00:00.000Z'),
      planExpiresAt: new Date('2020-02-01T00:00:00.000Z')
    });

    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });

    const res = await request(app)
      .get('/api/classes/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    const updated = await User.findById(teacher._id).populate('plan');
    expect(updated.plan.name).toBe('Free');
  });

  test('Admin can set user plan via /api/subscription/set', async () => {
    const admin = await User.create({
      firebaseUid: 'admin-1',
      email: 'admin1@example.com',
      role: 'admin'
    });

    const teacher = await User.create({
      firebaseUid: 'teacher-2',
      email: 'teacher2@example.com',
      role: 'teacher'
    });

    const token = signTestJwt({ id: admin._id, firebaseUid: admin.firebaseUid, role: admin.role });

    const res = await request(app)
      .post('/api/subscription/set')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: String(teacher._id), planName: 'Starter Monthly' });

    expect(res.status).toBe(200);
    expect(res.body && res.body.data && res.body.data.plan && res.body.data.plan.name).toBe('Starter Monthly');

    const updated = await User.findById(teacher._id).populate('plan');
    expect(updated.plan.name).toBe('Starter Monthly');
  });
});
