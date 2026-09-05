process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'stripe-test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.FRONTEND_URL = 'http://localhost:4200';

const request = require('supertest');

const stripeMock = {
  customers: { create: jest.fn() },
  subscriptions: { list: jest.fn(), retrieve: jest.fn() },
  prices: { retrieve: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() }
};

jest.mock('../src/services/stripe.service', () => ({
  getStripe: () => stripeMock,
  getFrontendUrl: () => 'http://localhost:4200'
}));

const app = require('../src/app');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const StripeEvent = require('../src/models/StripeEvent');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

const CHECKOUT_ATTEMPT_A = '00000000-0000-4000-8000-000000000001';
const CHECKOUT_ATTEMPT_B = '00000000-0000-4000-8000-000000000002';

function token(user) {
  return signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role });
}

async function createUser(role, suffix) {
  return User.create({ firebaseUid: `${role}-${suffix}`, email: `${role}-${suffix}@example.com`, role });
}

async function bindCustomer(user, customerId = 'cus_test') {
  user.stripeCustomerId = customerId;
  await user.save();
  return user;
}

function stripeSubscription(user, status = 'active') {
  return {
    id: 'sub_test', customer: 'cus_test', status,
    metadata: { userId: String(user._id), planSlug: 'starter_monthly' },
    items: { data: [{ price: { id: 'price_test_999', product: 'prod_test' }, current_period_start: 1786406400, current_period_end: 1789084800 }] },
    cancel_at_period_end: false, canceled_at: null
  };
}

describe('Stripe billing integration', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    await Plan.updateOne({ slug: 'starter_monthly' }, { $set: { stripe: { priceId: 'price_test_999', productId: 'prod_test' } } });
    await Plan.create({ name: 'Custom', slug: 'custom', billingType: 'custom', isActive: true });
    jest.clearAllMocks();
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_test' });
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.prices.retrieve.mockResolvedValue({ id: 'price_test_999', product: 'prod_test', active: true, type: 'recurring', unit_amount: 999, currency: 'usd', recurring: { interval: 'month' } });
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: 'cs_test', client_secret: 'cs_secret_test' });
    stripeMock.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.test/session' });
    stripeMock.webhooks.constructEvent.mockImplementation((body, signature) => {
      if (signature !== 'valid') throw new Error('bad signature');
      return JSON.parse(body.toString('utf8'));
    });
  });

  test('student cannot create checkout and arbitrary billing inputs are rejected', async () => {
    expect((await request(app).post('/api/subscription/checkout-session').send({ planSlug: 'starter_monthly' })).status).toBe(401);
    const student = await createUser('student', 'checkout');
    expect((await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(student)}`).send({ planSlug: 'starter_monthly' })).status).toBe(403);
    const teacher = await createUser('teacher', 'unsafe');
    const unsafe = await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(teacher)}`).send({
      planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_A, priceId: 'price_attacker'
    });
    expect(unsafe.status).toBe(400);
    const invalidAttempt = await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(teacher)}`).send({
      planSlug: 'starter_monthly', checkoutAttemptId: 'not-a-uuid'
    });
    expect(invalidAttempt.status).toBe(400);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('free teacher creates trusted Starter session and customer is persisted/reused', async () => {
    const teacher = await createUser('teacher', 'free');
    const first = await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(teacher)}`).send({
      planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_A, userId: 'browser-supplied-attacker-id'
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ clientSecret: 'cs_secret_test' });
    const checkoutPayload = stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(checkoutPayload).toMatchObject({
      ui_mode: 'embedded_page',
      mode: 'subscription',
      customer: 'cus_test',
      line_items: [{ price: 'price_test_999', quantity: 1 }],
      return_url: 'http://localhost:4200/checkout/success?session_id={CHECKOUT_SESSION_ID}'
    });
    expect(checkoutPayload).not.toHaveProperty('success_url');
    expect(checkoutPayload).not.toHaveProperty('cancel_url');
    expect(checkoutPayload.ui_mode).not.toBe('embedded');
    expect(checkoutPayload.client_reference_id).toBe(String(teacher._id));
    const saved = await User.findById(teacher._id);
    expect(saved.stripeCustomerId).toBe('cus_test');
    await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(saved)}`).send({
      planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_B
    });
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);
    const keys = stripeMock.checkout.sessions.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(keys[0]).toBe(`rozna-checkout:${teacher._id}:starter_monthly:monthly:${CHECKOUT_ATTEMPT_A}`);
    expect(keys[1]).toBe(`rozna-checkout:${teacher._id}:starter_monthly:monthly:${CHECKOUT_ATTEMPT_B}`);
    expect(keys[1]).not.toBe(keys[0]);
    expect(stripeMock.checkout.sessions.create.mock.calls[1][0].customer).toBe('cus_test');
  });

  test('failed Embedded Checkout creation returns a stable code and retry reuses the persisted customer', async () => {
    const teacher = await createUser('teacher', 'checkout-retry');
    stripeMock.checkout.sessions.create
      .mockRejectedValueOnce(Object.assign(new Error('Received unknown parameter: success_url'), {
        type: 'StripeInvalidRequestError', code: 'parameter_unknown', param: 'success_url'
      }))
      .mockResolvedValueOnce({ id: 'cs_retry', client_secret: 'cs_secret_retry' });

    const checkout = () => request(app).post('/api/subscription/checkout-session')
      .set('Authorization', `Bearer ${token(teacher)}`)
      .send({ planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_A });

    const failed = await checkout();
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({
      success: false,
      code: 'STRIPE_CHECKOUT_SESSION_FAILED',
      message: 'Unable to initialize secure checkout'
    });
    expect((await User.findById(teacher._id)).stripeCustomerId).toBe('cus_test');

    const retried = await checkout();
    expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual({ clientSecret: 'cs_secret_retry' });
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(stripeMock.checkout.sessions.create.mock.calls[1][0].customer).toBe('cus_test');
    const retryKeys = stripeMock.checkout.sessions.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(retryKeys[1]).toBe(retryKeys[0]);
  });

  test('concurrent checkout requests use stable Stripe idempotency keys and one stored customer', async () => {
    const teacher = await createUser('teacher', 'concurrent');
    const makeRequest = () => request(app).post('/api/subscription/checkout-session')
      .set('Authorization', `Bearer ${token(teacher)}`).send({
        planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_A
      });
    const responses = await Promise.all([makeRequest(), makeRequest()]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const customerKeys = stripeMock.customers.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(new Set(customerKeys)).toEqual(new Set([`rozna-customer-${teacher._id}`]));
    const checkoutKeys = stripeMock.checkout.sessions.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(new Set(checkoutKeys)).toEqual(new Set([`rozna-checkout:${teacher._id}:starter_monthly:monthly:${CHECKOUT_ATTEMPT_A}`]));
    expect((await User.findById(teacher._id)).stripeCustomerId).toBe('cus_test');
  });

  test('unknown/custom plans and active duplicate subscription are rejected', async () => {
    const teacher = await createUser('teacher', 'reject');
    const auth = { Authorization: `Bearer ${token(teacher)}` };
    expect((await request(app).post('/api/subscription/checkout-session').set(auth).send({ planSlug: 'unknown', checkoutAttemptId: CHECKOUT_ATTEMPT_A })).status).toBe(404);
    expect((await request(app).post('/api/subscription/checkout-session').set(auth).send({ planSlug: 'free', checkoutAttemptId: CHECKOUT_ATTEMPT_A })).status).toBe(400);
    expect((await request(app).post('/api/subscription/checkout-session').set(auth).send({ planSlug: 'custom', checkoutAttemptId: CHECKOUT_ATTEMPT_A })).status).toBe(400);
    teacher.stripeSubscriptionStatus = 'active'; await teacher.save();
    const duplicate = await request(app).post('/api/subscription/checkout-session').set(auth).send({ planSlug: 'starter_monthly', checkoutAttemptId: CHECKOUT_ATTEMPT_A });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ALREADY_SUBSCRIBED');
  });

  test('portal is teacher-only and client return URL cannot override trusted URL', async () => {
    const student = await createUser('student', 'portal');
    expect((await request(app).post('/api/subscription/customer-portal').set('Authorization', `Bearer ${token(student)}`).send({})).status).toBe(403);
    const teacher = await createUser('teacher', 'portal'); teacher.stripeCustomerId = 'cus_test'; await teacher.save();
    const rejected = await request(app).post('/api/subscription/customer-portal').set('Authorization', `Bearer ${token(teacher)}`).send({ returnUrl: 'https://evil.example' });
    expect(rejected.status).toBe(400);
    const valid = await request(app).post('/api/subscription/customer-portal').set('Authorization', `Bearer ${token(teacher)}`).send({});
    expect(valid.status).toBe(200);
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_test', return_url: 'http://localhost:4200/teacher/dashboard' });
  });

  test('webhook requires valid signature, receives raw body, and normal APIs still parse JSON', async () => {
    expect((await request(app).post('/api/stripe/webhook').set('stripe-signature', 'invalid').set('Content-Type', 'application/json').send('{}')).status).toBe(400);
    const event = { id: 'evt_raw', type: 'checkout.session.completed', data: { object: {} } };
    const valid = await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(valid.status).toBe(200);
    expect(Buffer.isBuffer(stripeMock.webhooks.constructEvent.mock.calls.at(-1)[0])).toBe(true);
    const teacher = await createUser('teacher', 'json');
    const parsed = await request(app).post('/api/subscription/checkout-session').set('Authorization', `Bearer ${token(teacher)}`).send({ planSlug: 'unknown', checkoutAttemptId: CHECKOUT_ATTEMPT_A });
    expect(parsed.status).toBe(404);
  });

  test('subscription webhook activates existing plan and duplicate event is applied once', async () => {
    const teacher = await bindCustomer(await createUser('teacher', 'sync'));
    const planBefore = await Plan.findOne({ slug: 'starter_monthly' }).lean();
    const object = stripeSubscription(teacher);
    const event = { id: 'evt_sync', type: 'customer.subscription.created', data: { object } };
    const send = () => request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect((await send()).status).toBe(200);
    expect((await send()).body.duplicate).toBe(true);
    const saved = await User.findById(teacher._id).populate('plan');
    expect(saved.plan.slug).toBe('starter_monthly');
    expect(saved.stripeSubscriptionStatus).toBe('active');
    expect(await StripeEvent.countDocuments({ stripeEventId: 'evt_sync' })).toBe(1);
    const planAfter = await Plan.findOne({ slug: 'starter_monthly' }).lean();
    expect(planAfter.features).toEqual(planBefore.features);
    expect(String(saved.plan._id)).toBe(String(planBefore._id));
  });

  test('checkout completion associates the teacher and synchronizes the Stripe subscription', async () => {
    const teacher = await bindCustomer(await createUser('teacher', 'checkout-webhook'));
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription(teacher));
    const event = { id: 'evt_checkout', type: 'checkout.session.completed', data: { object: {
      id: 'cs_test', client_reference_id: String(teacher._id), customer: 'cus_test', subscription: 'sub_test', metadata: { userId: String(teacher._id) }
    } } };
    const response = await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(response.status).toBe(200);
    const saved = await User.findById(teacher._id).populate('plan');
    expect(saved.stripeCustomerId).toBe('cus_test');
    expect(saved.stripeSubscriptionId).toBe('sub_test');
    expect(saved.plan.slug).toBe('starter_monthly');
  });

  test.each([['invoice.paid', 'paid'], ['invoice.payment_failed', 'open']])('%s records invoice state without deleting user data', async (eventType, invoiceStatus) => {
    const teacher = await bindCustomer(await createUser('teacher', eventType.replace('.', '-')));
    const subscription = stripeSubscription(teacher, eventType === 'invoice.paid' ? 'active' : 'past_due');
    stripeMock.subscriptions.retrieve.mockResolvedValue(subscription);
    const event = { id: `evt_${eventType}`, type: eventType, data: { object: {
      id: `in_${eventType}`, status: invoiceStatus, customer: 'cus_test', subscription: 'sub_test'
    } } };
    const response = await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(response.status).toBe(200);
    const saved = await User.findById(teacher._id);
    expect(saved).toBeTruthy();
    expect(saved.stripeLatestInvoiceStatus).toBe(invoiceStatus);
  });

  test('past_due preserves Starter only through the current paid period and records a billing issue', async () => {
    const teacher = await bindCustomer(await createUser('teacher', 'past-due-grace'));
    const event = { id: 'evt_past_due_grace', type: 'customer.subscription.updated', data: { object: stripeSubscription(teacher, 'past_due') } };
    await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    const saved = await User.findById(teacher._id).populate('plan');
    expect(saved.plan.slug).toBe('starter_monthly');
    expect(saved.stripeSubscriptionStatus).toBe('past_due');
  });

  test.each(['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'])('status %s does not grant Starter and never deletes user', async (status) => {
    const teacher = await bindCustomer(await createUser('teacher', status));
    const event = { id: `evt_${status}`, type: status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', data: { object: stripeSubscription(teacher, status) } };
    await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    const saved = await User.findById(teacher._id).populate('plan');
    expect(saved).toBeTruthy();
    expect(saved.plan.slug).toBe('free');
  });

  test('malicious checkout metadata cannot attach an attacker customer to another teacher', async () => {
    const victim = await bindCustomer(await createUser('teacher', 'victim'), 'cus_victim');
    const event = { id: 'evt_identity_attack', type: 'checkout.session.completed', data: { object: {
      id: 'cs_attack', client_reference_id: String(victim._id), customer: 'cus_attacker', subscription: 'sub_attacker',
      metadata: { userId: String(victim._id), planSlug: 'starter_monthly' }
    } } };
    const response = await request(app).post('/api/stripe/webhook').set('stripe-signature', 'valid').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(response.status).toBe(200);
    const saved = await User.findById(victim._id);
    expect(saved.stripeCustomerId).toBe('cus_victim');
    expect(saved.stripeSubscriptionId).toBeFalsy();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});
