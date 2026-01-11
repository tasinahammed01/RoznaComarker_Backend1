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
    const teacher = await User.create({
      firebaseUid: 'teacher-1',
      email: 'teacher1@example.com',
      role: 'teacher'
    });

    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });

    const first = await request(app)
      .post('/api/classes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Class A' });

    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/classes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Class B' });

    expect(second.status).toBe(403);
    expect(second.body && second.body.message).toMatch(/Limit exceeded: classes/i);

    const teacherAfter = await User.findById(teacher._id);
    expect(teacherAfter.usage.classes).toBe(1);

    const classCount = await Class.countDocuments({ teacher: teacher._id });
    expect(classCount).toBe(1);
  });

  test('Expired paid plan auto-downgrades to Free on next request', async () => {
    const pro = await Plan.findOne({ name: 'Pro' });

    const teacher = await User.create({
      firebaseUid: 'teacher-expired',
      email: 'teacher-expired@example.com',
      role: 'teacher',
      plan: pro._id,
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
      .send({ userId: String(teacher._id), planName: 'Pro' });

    expect(res.status).toBe(200);
    expect(res.body && res.body.data && res.body.data.plan && res.body.data.plan.name).toBe('Pro');

    const updated = await User.findById(teacher._id).populate('plan');
    expect(updated.plan.name).toBe('Pro');
  });
});
