process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Class = require('../src/models/class.model');
const User = require('../src/models/user.model');
const Membership = require('../src/models/membership.model');
const CreditWallet = require('../src/models/CreditWallet');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

async function actor(role, suffix) {
  const user = await User.create({ firebaseUid: `${role}-${suffix}`, email: `${role}-${suffix}@test.local`, role });
  return { user, token: signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role }) };
}

async function ownedClass(teacher, suffix, extra = {}) {
  return Class.create({ name: `Class ${suffix}`, teacher: teacher._id, joinCode: `CODE${suffix}`.slice(0, 20), ...extra });
}

describe('archive classes', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await Class.init(); });
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); await seedTestPlans(); });

  test('model defaults new classes to active', async () => {
    const { user } = await actor('teacher', 'default');
    expect((await ownedClass(user, 'DEFAULT')).status).toBe('active');
  });

  test('legacy missing status is listed as active and can be archived', async () => {
    const { user, token } = await actor('teacher', 'legacy');
    const id = new mongoose.Types.ObjectId();
    await Class.collection.insertOne({ _id: id, name: 'Legacy', teacher: user._id, joinCode: 'LEGACY1', isActive: true, createdAt: new Date(), updatedAt: new Date() });
    const list = await request(app).get('/api/classes/mine?status=active').set('Authorization', `Bearer ${token}`);
    expect(list.body.data.map((item) => item.name)).toContain('Legacy');
    expect((await request(app).patch(`/api/classes/${id}/archive`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  test('archive and restore are idempotent and preserve related membership and credits', async () => {
    const { user: teacher, token } = await actor('teacher', 'owner');
    const { user: student } = await actor('student', 'member');
    const cls = await ownedClass(teacher, 'KEEP');
    await Membership.create({ class: cls._id, student: student._id });
    const cycleStart = new Date();
    const wallet = await CreditWallet.create({ userId: teacher._id, monthlyCredits: 10, monthlyCreditsUsed: 2, bonusCredits: 3, billingCycleStart: cycleStart, billingCycleEnd: new Date(Date.now() + 86400000), lastCreditReset: cycleStart });

    for (let i = 0; i < 2; i += 1) expect((await request(app).patch(`/api/classes/${cls._id}/archive`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await Class.findById(cls._id)).status).toBe('archived');
    expect(await Membership.countDocuments({ class: cls._id })).toBe(1);
    expect((await CreditWallet.findById(wallet._id)).monthlyCreditsUsed).toBe(2);
    for (let i = 0; i < 2; i += 1) expect((await request(app).patch(`/api/classes/${cls._id}/unarchive`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await Class.findById(cls._id)).status).toBe('active');
  });

  test('only the owning teacher can archive or restore', async () => {
    const owner = await actor('teacher', 'auth-owner');
    const other = await actor('teacher', 'auth-other');
    const student = await actor('student', 'auth-student');
    const cls = await ownedClass(owner.user, 'AUTH');
    expect((await request(app).patch(`/api/classes/${cls._id}/archive`).set('Authorization', `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).patch(`/api/classes/${cls._id}/archive`).set('Authorization', `Bearer ${student.token}`)).status).toBe(403);
  });

  test('active and archived list filters are disjoint', async () => {
    const { user, token } = await actor('teacher', 'filters');
    await ownedClass(user, 'ACTIVE');
    await ownedClass(user, 'ARCHIVED', { status: 'archived', archivedAt: new Date() });
    const active = await request(app).get('/api/classes/mine?status=active').set('Authorization', `Bearer ${token}`);
    const archived = await request(app).get('/api/classes/mine?status=archived').set('Authorization', `Bearer ${token}`);
    expect(active.body.data).toHaveLength(1);
    expect(archived.body.data).toHaveLength(1);
    expect(active.body.data[0]._id).not.toBe(archived.body.data[0]._id);
  });

  test('archived classes reject public resolution and authenticated joins with CLASS_ARCHIVED', async () => {
    const teacher = await actor('teacher', 'join-owner');
    const student = await actor('student', 'join-student');
    await ownedClass(teacher.user, 'JOIN', { status: 'archived', archivedAt: new Date() });
    const resolve = await request(app).get('/api/classes/join/CODEJOIN');
    const join = await request(app).post('/api/memberships/join').set('Authorization', `Bearer ${student.token}`).send({ joinCode: 'CODEJOIN' });
    expect(resolve.body.code).toBe('CLASS_ARCHIVED');
    expect(join.body.code).toBe('CLASS_ARCHIVED');
    expect(await Membership.countDocuments()).toBe(0);
  });

  test('archiving frees a creation slot and restore respects the active plan limit', async () => {
    const { user, token } = await actor('teacher', 'limit');
    const classes = [];
    for (let i = 0; i < 5; i += 1) classes.push(await ownedClass(user, `LIM${i}`));
    await request(app).patch(`/api/classes/${classes[0]._id}/archive`).set('Authorization', `Bearer ${token}`);
    const created = await request(app).post('/api/classes').set('Authorization', `Bearer ${token}`).send({ name: 'Replacement' });
    expect(created.status).toBe(200);
    const restore = await request(app).patch(`/api/classes/${classes[0]._id}/unarchive`).set('Authorization', `Bearer ${token}`);
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('ACTIVE_CLASS_LIMIT_REACHED');
  });

  test('archived class summary and student history remain accessible', async () => {
    const teacher = await actor('teacher', 'history-owner');
    const student = await actor('student', 'history-student');
    const cls = await ownedClass(teacher.user, 'HISTORY', { status: 'archived', archivedAt: new Date() });
    await Membership.create({ class: cls._id, student: student.user._id });
    const teacherSummary = await request(app).get(`/api/classes/${cls._id}/summary`).set('Authorization', `Bearer ${teacher.token}`);
    const studentSummary = await request(app).get(`/api/classes/${cls._id}/summary`).set('Authorization', `Bearer ${student.token}`);
    expect(teacherSummary.status).toBe(200);
    expect(studentSummary.status).toBe(200);
    expect(studentSummary.body.data.status).toBe('archived');
  });
});
