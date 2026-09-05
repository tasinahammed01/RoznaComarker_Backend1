const request = require('supertest');

const Plan = require('../src/models/Plan');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

const activePlans = [
  {
    name: 'Custom',
    slug: 'custom',
    price: null,
    billingInterval: null,
    isActive: true,
    features: {
      maxClasses: null,
      maxStudents: null,
      essayAnalysesPerMonth: null,
      storageMB: null,
      aiFlashcards: true,
      aiFlashcardsLimit: null,
      aiWorksheets: true,
      aiWorksheetsLimit: null,
      adaptiveLearning: true,
      adaptiveLearningLimit: null,
      priorityAIProcessing: true,
      analyticsAccess: true,
      dedicatedSupport: true
    },
    display: {
      title: 'Custom',
      description: 'Advanced features for schools and organizations.',
      priceLabel: 'Custom',
      cta: 'Contact Us'
    },
    stripePriceId: 'must-not-be-public',
    internalBillingMetadata: { provider: 'private' }
  },
  {
    name: 'Free',
    slug: 'free',
    price: 0,
    billingInterval: 'month',
    isActive: true,
    features: {
      maxClasses: 5,
      maxStudents: 50,
      essayAnalysesPerMonth: 100,
      storageMB: 500,
      aiFlashcards: true,
      aiFlashcardsLimit: 10,
      aiWorksheets: true,
      aiWorksheetsLimit: 10,
      adaptiveLearning: true,
      adaptiveLearningLimit: 10,
      priorityAIProcessing: false,
      analyticsAccess: false
    },
    display: {
      title: 'Free',
      description: 'Perfect to try the workflow.',
      priceLabel: '$0',
      cta: 'Get Started'
    }
  },
  {
    name: 'Starter Monthly',
    slug: 'starter_monthly',
    price: 9.99,
    currency: 'USD',
    billingInterval: 'month',
    isActive: true,
    popular: true,
    features: {
      maxClasses: 20,
      maxStudents: 500,
      essayAnalysesPerMonth: 1000,
      storageMB: 2048,
      aiFlashcards: true,
      aiFlashcardsLimit: null,
      aiWorksheets: true,
      aiWorksheetsLimit: null,
      adaptiveLearning: true,
      adaptiveLearningLimit: null,
      priorityAIProcessing: true,
      analyticsAccess: true
    },
    display: {
      title: 'Starter Monthly',
      description: 'Best for active teachers.',
      priceLabel: '$9.99',
      cta: 'Upgrade Now'
    }
  }
];

describe('GET /api/plans', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);

  beforeEach(async () => {
    await clearDatabase();
    await Plan.collection.insertMany([
      ...activePlans,
      {
        name: 'Inactive',
        slug: 'inactive',
        price: 123,
        isActive: false,
        features: {},
        display: { title: 'Inactive', cta: 'Unavailable' }
      }
    ]);
  });

  test('returns only active plans in stable pricing order', async () => {
    const response = await request(app).get('/api/plans');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.map((plan) => plan.slug)).toEqual([
      'free',
      'starter_monthly',
      'custom'
    ]);
  });

  test.each([
    ['Free', 'free'],
    ['Starter Monthly', 'starter_monthly'],
    ['Custom', 'custom']
  ])('returns %s from the plans collection', async (name, slug) => {
    const response = await request(app).get('/api/plans');
    expect(response.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name, slug })])
    );
  });

  test('returns the canonical structured feature values', async () => {
    const response = await request(app).get('/api/plans');
    const starter = response.body.data.find((plan) => plan.slug === 'starter_monthly');

    expect(starter).toMatchObject({
      price: 9.99,
      popular: true,
      features: {
        maxClasses: 20,
        maxStudents: 500,
        essayAnalysesPerMonth: 1000,
        storageMB: 2048,
        aiFlashcards: true,
        aiWorksheets: true,
        adaptiveLearning: true
      }
    });
  });

  test('does not expose billing metadata, token accounting, or administrative fields', async () => {
    const response = await request(app).get('/api/plans');
    const serialized = JSON.stringify(response.body.data);

    expect(serialized).not.toContain('stripePriceId');
    expect(serialized).not.toContain('internalBillingMetadata');
    expect(serialized).not.toContain('aiTokens');
    expect(serialized).not.toContain('isActive');
    expect(serialized).not.toContain('_id');
  });

  test('does not mutate or create plan documents', async () => {
    const idsBefore = (await Plan.collection.find({}).toArray()).map((plan) => String(plan._id)).sort();
    await request(app).get('/api/plans');
    const idsAfter = (await Plan.collection.find({}).toArray()).map((plan) => String(plan._id)).sort();

    expect(idsAfter).toEqual(idsBefore);
    expect(idsAfter).toHaveLength(4);
  });

  test('marks PayPal plans purchasable from PayPal mapping without Stripe product or price IDs', async () => {
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousEnv = process.env.PAYPAL_ENV;
    const previousPlan = process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY;
    process.env.PAYMENT_PROVIDER = 'paypal'; process.env.PAYPAL_ENV = 'sandbox';
    process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY = 'P-ESSENTIAL-SANDBOX';
    try {
      const { _id, ...starterTemplate } = activePlans[2];
      await Plan.create({ ...starterTemplate, name: 'Essential', slug: 'essential', popular: false });
      const response = await request(app).get('/api/plans');
      const plan = response.body.data.find((entry) => entry.slug === 'essential');
      expect(plan).toMatchObject({ paymentProvider: 'paypal', purchasable: true });
    } finally {
      if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previousProvider;
      if (previousEnv === undefined) delete process.env.PAYPAL_ENV; else process.env.PAYPAL_ENV = previousEnv;
      if (previousPlan === undefined) delete process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY; else process.env.PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY = previousPlan;
    }
  });
});
