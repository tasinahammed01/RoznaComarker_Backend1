'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const { ensureActivePlan, getLimit } = require('../src/middlewares/usage.middleware');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');

describe('canonical teacher plan entitlement resolution', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    await Plan.updateOne(
      { slug: 'starter_monthly' },
      { $set: { 'stripe.priceId': 'price_starter_entitlement', 'stripe.productId': 'prod_starter_entitlement' } }
    );
  });

  function tokenFor(user) {
    return signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role });
  }

  async function createAssignmentFor(user, suffix = 'free') {
    const classDoc = await Class.create({
      name: `Entitlement class ${suffix}`,
      teacher: user._id,
      joinCode: `ENT${suffix}${String(user._id).slice(-4)}`.slice(0, 20),
      isActive: true
    });
    return request(app)
      .post('/api/assignments')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({
        title: `Writing ${suffix}`,
        writingType: 'essay',
        classId: String(classDoc._id),
        deadline: new Date(Date.now() + 86400000).toISOString()
      });
  }

  test('new and historical teachers without a plan lazily resolve and persist Free without losing usage', async () => {
    const teacher = await User.create({
      firebaseUid: 'entitlement-new-free',
      email: 'entitlement-new-free@example.test',
      role: 'teacher',
      usage: { assignments: 7, submissions: 8, storageMB: 9 }
    });
    const resolved = await ensureActivePlan(teacher);
    const repaired = await User.findById(teacher._id);

    expect(resolved.slug).toBe('free');
    expect(String(repaired.plan)).toBe(String(resolved._id));
    expect(repaired.usage.assignments).toBe(7);
    expect(repaired.usage.submissions).toBe(8);
    expect(repaired.usage.storageMB).toBe(9);
  });

  test('a new Free teacher can create an assignment and is denied at the MongoDB feature limit', async () => {
    const teacher = await User.create({
      firebaseUid: 'entitlement-free-assignment',
      email: 'entitlement-free-assignment@example.test',
      role: 'teacher'
    });
    const allowed = await createAssignmentFor(teacher, 'allowed');
    expect(allowed.status).toBe(200);

    const free = await Plan.findOne({ slug: 'free' });
    const configuredLimit = free.features.essayAnalysesPerMonth;
    expect(getLimit(free, 'assignments')).toBe(configuredLimit);
    await User.updateOne({ _id: teacher._id }, { $set: { 'usage.assignments': configuredLimit } });

    const denied = await createAssignmentFor(teacher, 'denied');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Limit exceeded: assignments');
  });

  test('active trusted Stripe mapping repairs Starter and matches /subscription/me and assignment middleware', async () => {
    const teacher = await User.create({
      firebaseUid: 'entitlement-starter',
      email: 'entitlement-starter@example.test',
      role: 'teacher',
      stripePriceId: 'price_starter_entitlement',
      stripeSubscriptionStatus: 'active',
      stripeCurrentPeriodStart: new Date(Date.now() - 86400000),
      stripeCurrentPeriodEnd: new Date(Date.now() + 86400000),
      usage: { assignments: 25, submissions: 8 }
    });

    const subscription = await request(app)
      .get('/api/subscription/me')
      .set('Authorization', `Bearer ${tokenFor(teacher)}`);
    expect(subscription.status).toBe(200);
    expect(subscription.body.data.plan.slug).toBe('starter_monthly');
    expect(subscription.body.data.usage.assignments).toBe(25);

    const assignment = await createAssignmentFor(teacher, 'starter');
    expect(assignment.status).toBe(200);
    const repaired = await User.findById(teacher._id).populate('plan');
    expect(repaired.plan.slug).toBe('starter_monthly');
  });

  test.each(['canceled', 'unpaid', 'incomplete'])('%s Stripe state resolves to Free', async (status) => {
    const starter = await Plan.findOne({ slug: 'starter_monthly' });
    const teacher = await User.create({
      firebaseUid: `entitlement-${status}`,
      email: `entitlement-${status}@example.test`,
      role: 'teacher',
      plan: starter._id,
      stripePriceId: 'price_starter_entitlement',
      stripeSubscriptionStatus: status,
      stripeCurrentPeriodEnd: new Date(Date.now() + 86400000)
    });
    expect((await ensureActivePlan(teacher)).slug).toBe('free');
  });

  test('past_due keeps paid entitlement only through the synchronized current period', async () => {
    const current = await User.create({
      firebaseUid: 'entitlement-past-due-current', email: 'past-current@example.test', role: 'teacher',
      stripePriceId: 'price_starter_entitlement', stripeSubscriptionStatus: 'past_due',
      stripeCurrentPeriodEnd: new Date(Date.now() + 86400000)
    });
    const expired = await User.create({
      firebaseUid: 'entitlement-past-due-expired', email: 'past-expired@example.test', role: 'teacher',
      stripePriceId: 'price_starter_entitlement', stripeSubscriptionStatus: 'past_due',
      stripeCurrentPeriodEnd: new Date(Date.now() - 86400000)
    });
    expect((await ensureActivePlan(current)).slug).toBe('starter_monthly');
    expect((await ensureActivePlan(expired)).slug).toBe('free');
  });

  test('missing active Free plan is a safe configuration failure and student assignment access remains forbidden', async () => {
    await Plan.deleteOne({ slug: 'free' });
    const teacher = await User.create({ firebaseUid: 'entitlement-no-free', email: 'no-free@example.test', role: 'teacher' });
    const response = await request(app).get('/api/subscription/me').set('Authorization', `Bearer ${tokenFor(teacher)}`);
    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Failed to initialize subscription');

    await clearDatabase();
    await seedTestPlans();
    const student = await User.create({ firebaseUid: 'entitlement-student', email: 'student@example.test', role: 'student' });
    const denied = await request(app).post('/api/assignments').set('Authorization', `Bearer ${tokenFor(student)}`).send({});
    expect(denied.status).toBe(403);
  });
});
