'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'paypal-orders-test-secret';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
process.env.PAYPAL_WEBHOOK_ID = 'WH-SAFE';
process.env.FRONTEND_URL = 'http://localhost:4200';

const paypalMock = { createOrder: jest.fn(), captureOrder: jest.fn(), getOrder: jest.fn(), getCapture: jest.fn(),
  verifyWebhookSignature: jest.fn() };
jest.mock('../src/services/paypal/paypalClient.service', () => ({
  PayPalClient: jest.fn(() => paypalMock), PayPalApiError: class PayPalApiError extends Error {}
}));

const request = require('supertest');
const app = require('../src/app');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const CreditPack = require('../src/models/CreditPack');
const CreditWallet = require('../src/models/CreditWallet');
const CreditTransaction = require('../src/models/CreditTransaction');
const PaymentPurchaseAttempt = require('../src/models/PaymentPurchaseAttempt');
const PaymentProviderEvent = require('../src/models/PaymentProviderEvent');
const TopupService = require('../src/services/topup.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const ATTEMPT = '00000000-0000-4000-8000-000000000041';
const ATTEMPT_B = '00000000-0000-4000-8000-000000000042';
const ORDER = '5O190127TN364715T';
const CAPTURE = '8MC585209K746392H';
let teacher; let otherTeacher; let pack;
const auth = (user = teacher) => ({ Authorization: `Bearer ${signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: 'teacher' })}` });

function createdOrder(id = ORDER) {
  return { id, status: 'CREATED', links: [{ rel: 'payer-action', method: 'GET', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
}
function completedOrder({ amount = '4.99', currency = 'USD', status = 'COMPLETED', captureStatus = 'COMPLETED',
  referenceId = ATTEMPT, customId = `paypal-topup:${ATTEMPT}`, captureId = CAPTURE } = {}) {
  return { id: ORDER, status, purchase_units: [{ reference_id: referenceId, custom_id: customId,
    amount: { value: amount, currency_code: currency }, payments: { captures: [{ id: captureId, status: captureStatus,
      amount: { value: amount, currency_code: currency }, update_time: '2026-08-31T00:00:00Z' }] } }] };
}
function webhookHeaders() { return { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tx-orders', 'paypal-transmission-sig': 'sig-orders', 'paypal-transmission-time': '2026-08-31T00:00:00Z' }; }
function paymentEvent(id, type, captureId = CAPTURE) { return { id, event_type: type, resource: { id: captureId,
  supplementary_data: { related_ids: { order_id: ORDER } } } }; }
async function create(body = { packCode: 'TOPUP_SMALL', checkoutAttemptId: ATTEMPT }, user = teacher) {
  return request(app).post('/api/credits/paypal/create-order').set(auth(user)).send(body);
}
async function capture(body = { checkoutAttemptId: ATTEMPT }, user = teacher) {
  return request(app).post('/api/credits/paypal/capture').set(auth(user)).send(body);
}
async function sendWebhook(event) {
  return request(app).post('/api/webhooks/paypal').set(webhookHeaders()).set('Content-Type', 'application/json').send(event);
}

describe('PayPal Orders Assessment Credit purchases', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await PaymentPurchaseAttempt.init(); });
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase(); jest.clearAllMocks();
    await Plan.create({ name: 'Free', slug: 'free', price: 0, isActive: true, features: { essayAnalysesPerMonth: 25 } });
    const plan = await Plan.create({ name: 'Essential', slug: 'essential', isActive: true, features: { essayAnalysesPerMonth: 100 } });
    teacher = await User.create({ firebaseUid: `orders-${Date.now()}`, email: `orders-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
    otherTeacher = await User.create({ firebaseUid: `orders-other-${Date.now()}`, email: `orders-other-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
    pack = await CreditPack.create({ name: 'Small', code: 'TOPUP_SMALL', credits: 10, price: 4.99, currency: 'USD',
      stripePriceId: 'price_small', allowedPlans: ['essential'], active: true });
    paypalMock.createOrder.mockResolvedValue(createdOrder());
    paypalMock.captureOrder.mockResolvedValue(completedOrder());
    paypalMock.getOrder.mockResolvedValue(completedOrder());
    paypalMock.getCapture.mockResolvedValue({ id: CAPTURE, status: 'REFUNDED', amount: { value: '4.99', currency_code: 'USD' },
      seller_receivable_breakdown: { total_refunded_amount: { value: '4.99', currency_code: 'USD' } } });
    paypalMock.verifyWebhookSignature.mockResolvedValue({ verification_status: 'SUCCESS' });
  });

  test('active backend pack is resolved and exact trusted Order shape is sent', async () => {
    const res = await create(); expect(res.status).toBe(200);
    expect(paypalMock.createOrder).toHaveBeenCalledWith({ intent: 'CAPTURE', purchase_units: [{ reference_id: ATTEMPT,
      custom_id: `paypal-topup:${ATTEMPT}`, description: '10 Assessment Credits (TOPUP_SMALL)',
      amount: { currency_code: 'USD', value: '4.99' } }], payment_source: { paypal: { experience_context: {
      return_url: `http://localhost:4200/teacher/dashboard?topup=paypal-confirming&attempt=${ATTEMPT}`,
      cancel_url: `http://localhost:4200/teacher/dashboard?topup=paypal-cancelled&attempt=${ATTEMPT}`,
      user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING'
    } } } }, `topup-create:${ATTEMPT}`);
    expect(res.body.data).toEqual(expect.objectContaining({ attemptId: ATTEMPT, orderId: ORDER, amount: '4.99', currency: 'USD' }));
  });

  test.each([
    [{ packCode: 'UNKNOWN', checkoutAttemptId: ATTEMPT }, 404],
    [{ packCode: 'TOPUP_SMALL', checkoutAttemptId: ATTEMPT, price: '0.01' }, 400],
    [{ packCode: 'TOPUP_SMALL', checkoutAttemptId: ATTEMPT, credits: 999 }, 400],
    [{ packCode: 'TOPUP_SMALL', checkoutAttemptId: 'not-a-uuid' }, 400]
  ])('rejects unknown packs and all untrusted purchase fields', async (body, status) => {
    expect((await create(body)).status).toBe(status); expect(paypalMock.createOrder).not.toHaveBeenCalled();
  });

  test('inactive pack is unavailable', async () => {
    pack.active = false; await pack.save(); expect((await create()).status).toBe(404);
  });

  test('same attempt returns the same Order and stable create request ID', async () => {
    const first = await create(); const second = await create();
    expect(first.body.data.orderId).toBe(ORDER); expect(second.body.data.orderId).toBe(ORDER);
    expect(paypalMock.createOrder).toHaveBeenCalledTimes(1); expect(await PaymentPurchaseAttempt.countDocuments()).toBe(1);
  });

  test('simultaneous creates atomically produce one provider Order', async () => {
    let release; paypalMock.createOrder.mockImplementation(() => new Promise((resolve) => { release = () => resolve(createdOrder()); }));
    const a = create().then((value) => value); const b = create().then((value) => value);
    for (let i = 0; i < 50 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    release(); const responses = await Promise.all([a, b]);
    expect(responses.map((item) => item.status).every((status) => [200, 409].includes(status))).toBe(true);
    expect(paypalMock.createOrder).toHaveBeenCalledTimes(1); expect(await PaymentPurchaseAttempt.countDocuments()).toBe(1);
  });

  test.each([
    ['http://www.paypal.com/checkoutnow?token=x'], ['https://evil.example/checkout'], ['not-a-url']
  ])('rejects an unsafe approval URL', async (url) => {
    paypalMock.createOrder.mockResolvedValue({ id: ORDER, links: [{ rel: 'payer-action', method: 'GET', href: url }] });
    const res = await create(); expect(res.status).toBe(502); expect(res.body.code).toBe('PAYPAL_ORDER_APPROVAL_INVALID');
  });

  test('create persistence failure safely replays with the same provider request ID after lease expiry', async () => {
    const spy = jest.spyOn(PaymentPurchaseAttempt, 'findOneAndUpdate').mockRejectedValueOnce(new Error('local save failed'));
    expect((await create()).status).toBe(500); spy.mockRestore();
    await PaymentPurchaseAttempt.updateOne({ attemptId: ATTEMPT }, { $set: { processingLeaseExpiresAt: new Date(0) } });
    expect((await create()).status).toBe(200);
    expect(paypalMock.createOrder.mock.calls.map((call) => call[1])).toEqual([`topup-create:${ATTEMPT}`, `topup-create:${ATTEMPT}`]);
  });

  test('capture uses only the stored Order and stable capture request ID', async () => {
    await create(); const res = await capture(); expect(res.status).toBe(200);
    expect(paypalMock.captureOrder).toHaveBeenCalledWith(ORDER, `topup-capture:${ATTEMPT}`);
    expect(res.body.data).toMatchObject({ status: 'credited', credited: true });
  });

  test('arbitrary Order IDs and foreign user attempts are impossible', async () => {
    await create(); expect((await capture({ checkoutAttemptId: ATTEMPT, orderId: 'FOREIGN' })).status).toBe(400);
    expect((await capture({ checkoutAttemptId: ATTEMPT }, otherTeacher)).status).toBe(404);
    expect(paypalMock.captureOrder).not.toHaveBeenCalled();
  });

  test.each([
    [completedOrder({ amount: '5.00' }), 'PAYPAL_CAPTURE_CORRELATION_MISMATCH'],
    [completedOrder({ currency: 'EUR' }), 'PAYPAL_CAPTURE_CORRELATION_MISMATCH'],
    [completedOrder({ status: 'APPROVED' }), 'PAYPAL_CAPTURE_NOT_COMPLETED'],
    [completedOrder({ captureStatus: 'PENDING' }), 'PAYPAL_CAPTURE_NOT_COMPLETED'],
    [completedOrder({ referenceId: ATTEMPT_B }), 'PAYPAL_CAPTURE_CORRELATION_MISMATCH']
  ])('non-authoritative or mismatched captures grant no credits', async (providerOrder, code) => {
    await create(); paypalMock.captureOrder.mockResolvedValue(providerOrder);
    const res = await capture(); expect(res.status).toBe(409); expect(res.body.code).toBe(code);
    expect(await CreditTransaction.countDocuments({ type: 'TOPUP_PURCHASE_COMPLETED' })).toBe(0);
    expect((await CreditWallet.findOne({ userId: teacher._id }))?.purchasedCredits || 0).toBe(0);
  });

  test('duplicate capture response grants purchased credits exactly once', async () => {
    await create(); expect((await capture()).status).toBe(200); expect((await capture()).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:capture:${CAPTURE}` })).toBe(1);
  });

  test('synchronous capture and completion webhook race grants exactly once', async () => {
    await create();
    const [captureResponse, webhookResponse] = await Promise.all([
      capture(), sendWebhook(paymentEvent('WH-CAPTURE-RACE', 'PAYMENT.CAPTURE.COMPLETED'))
    ]);
    expect([200, 409]).toContain(captureResponse.status); expect(webhookResponse.status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:capture:${CAPTURE}` })).toBe(1);
  });

  test('crash after durable ledger creation but before wallet increment recovers once', async () => {
    await create();
    const original = CreditWallet.findOneAndUpdate.bind(CreditWallet);
    const spy = jest.spyOn(CreditWallet, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated process exit before wallet update'));
    const input = { userId: teacher._id, pack, idempotencyKey: 'paypal-topup:capture:CRASH-BEFORE',
      reason: 'PayPal Assessment Credit purchase', metadata: { provider: 'paypal', creditsPurchased: 10 } };
    await expect(TopupService.grantProviderPurchasedCredits(input)).rejects.toThrow('simulated process exit');
    spy.mockImplementation(original); spy.mockRestore();
    expect(await CreditTransaction.findOne({ idempotencyKey: input.idempotencyKey })).toMatchObject({ status: 'pending' });
    await TopupService.grantProviderPurchasedCredits(input);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: input.idempotencyKey })).toBe(1);
  });

  test('crash after wallet increment but before ledger finalization recovers without a second increment', async () => {
    await create();
    const spy = jest.spyOn(CreditTransaction, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated process exit after wallet update'));
    const input = { userId: teacher._id, pack, idempotencyKey: 'paypal-topup:capture:CRASH-AFTER',
      reason: 'PayPal Assessment Credit purchase', metadata: { provider: 'paypal', creditsPurchased: 10 } };
    await expect(TopupService.grantProviderPurchasedCredits(input)).rejects.toThrow('simulated process exit');
    spy.mockRestore();
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditWallet.findOne({ userId: teacher._id }).select('+pendingPurchaseOperation')).toMatchObject({
      pendingPurchaseOperation: { idempotencyKey: input.idempotencyKey, state: 'applied' }
    });
    await TopupService.grantProviderPurchasedCredits(input);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.findOne({ idempotencyKey: input.idempotencyKey })).toMatchObject({ status: 'committed' });
  });

  test('many top-ups keep CreditWallet shape bounded and history in CreditTransaction', async () => {
    await create();
    for (let index = 0; index < 30; index += 1) {
      await TopupService.grantProviderPurchasedCredits({ userId: teacher._id, pack,
        idempotencyKey: `paypal-topup:capture:BOUNDED-${index}`, reason: 'PayPal Assessment Credit purchase',
        metadata: { provider: 'paypal', creditsPurchased: 10 } });
    }
    const raw = await CreditWallet.collection.findOne({ userId: teacher._id });
    expect(raw.purchasedCredits).toBe(300);
    expect(raw).not.toHaveProperty('appliedPurchaseKeys'); expect(raw).not.toHaveProperty('reversedPurchaseKeys');
    expect(raw).not.toHaveProperty('pendingPurchaseOperation');
    expect(await CreditTransaction.countDocuments({ idempotencyKey: /^paypal-topup:capture:BOUNDED-/u })).toBe(30);
  });

  test('wallet grant followed by attempt-response persistence failure recovers without a second grant', async () => {
    await create(); const original = PaymentPurchaseAttempt.findOneAndUpdate.bind(PaymentPurchaseAttempt);
    let calls = 0; const spy = jest.spyOn(PaymentPurchaseAttempt, 'findOneAndUpdate').mockImplementation((...args) => {
      calls += 1; if (calls === 2) return Promise.reject(new Error('response save failed')); return original(...args);
    });
    expect((await capture()).status).toBe(500); spy.mockRestore();
    expect((await capture()).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:capture:${CAPTURE}` })).toBe(1);
  });

  test('capture timeout fetches authoritative completed Order and recovers', async () => {
    await create(); paypalMock.captureOrder.mockRejectedValue(new Error('timeout'));
    expect((await capture()).status).toBe(200); expect(paypalMock.getOrder).toHaveBeenCalledWith(ORDER);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
  });

  test('cancelled buyer flow marks the attempt and grants nothing', async () => {
    await create(); const res = await request(app).post('/api/credits/paypal/cancel').set(auth()).send({ checkoutAttemptId: ATTEMPT });
    expect(res.body.data.status).toBe('cancelled'); expect((await capture()).status).toBe(409);
    expect(await CreditTransaction.countDocuments()).toBe(0);
  });

  test('owner-only status contains safe fields and no payer data', async () => {
    await create(); const res = await request(app).get(`/api/credits/paypal/purchase/${ATTEMPT}`).set(auth());
    expect(res.status).toBe(200); expect(res.body.data).toMatchObject({ packCode: 'TOPUP_SMALL', credits: 10, amount: '4.99' });
    expect(JSON.stringify(res.body)).not.toMatch(/payer|sandbox-secret/iu);
    expect((await request(app).get(`/api/credits/paypal/purchase/${ATTEMPT}`).set(auth(otherTeacher))).status).toBe(404);
  });

  test('verified capture webhook recovers and duplicate webhook grants once', async () => {
    await create(); const first = await sendWebhook(paymentEvent('WH-CAPTURE', 'PAYMENT.CAPTURE.COMPLETED'));
    const duplicate = await sendWebhook(paymentEvent('WH-CAPTURE', 'PAYMENT.CAPTURE.COMPLETED'));
    expect(first.status).toBe(200); expect(duplicate.body.duplicate).toBe(true);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:capture:${CAPTURE}` })).toBe(1);
  });

  test('full refund removes only purchased inventory', async () => {
    await create(); await capture(); await CreditWallet.updateOne({ userId: teacher._id }, { $set: { monthlyCreditsUsed: 1, bonusCredits: 3 } });
    const res = await sendWebhook(paymentEvent('WH-REFUND', 'PAYMENT.CAPTURE.REFUNDED')); expect(res.status).toBe(200);
    expect(await CreditWallet.findOne({ userId: teacher._id })).toMatchObject({ purchasedCredits: 0, monthlyCreditsUsed: 1, bonusCredits: 3 });
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:4.99` })).toMatchObject({ status: 'refunded', amount: -10 });
  });

  test('refund after credits were consumed is review_required without debt', async () => {
    await create(); await capture(); await CreditWallet.updateOne({ userId: teacher._id }, { $set: { purchasedCredits: 4 } });
    expect((await sendWebhook(paymentEvent('WH-USED', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(4);
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:4.99` })).toMatchObject({ status: 'review_required', amount: 0 });
  });

  test('partial refund is conservatively review_required and does not invent fractional credits', async () => {
    await create(); await capture(); paypalMock.getCapture.mockResolvedValue({ id: CAPTURE, status: 'PARTIALLY_REFUNDED',
      amount: { value: '4.99', currency_code: 'USD' }, seller_receivable_breakdown: {
        total_refunded_amount: { value: '1.00', currency_code: 'USD' } } });
    expect((await sendWebhook(paymentEvent('WH-PARTIAL', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:1.00` })).toMatchObject({ status: 'review_required', amount: 0 });
  });

  test('repeated partial refund events do not mutate the wallet', async () => {
    await create(); await capture(); paypalMock.getCapture.mockResolvedValue({ id: CAPTURE, status: 'PARTIALLY_REFUNDED',
      amount: { value: '4.99', currency_code: 'USD' }, seller_receivable_breakdown: {
        total_refunded_amount: { value: '1.00', currency_code: 'USD' } } });
    expect((await sendWebhook(paymentEvent('WH-PARTIAL-A', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await sendWebhook(paymentEvent('WH-PARTIAL-B', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:1.00` })).toBe(1);
  });

  test('cumulative partial refund followed by full refund reverses the pack exactly once', async () => {
    await create(); await capture();
    paypalMock.getCapture.mockResolvedValueOnce({ id: CAPTURE, status: 'PARTIALLY_REFUNDED',
      amount: { value: '4.99', currency_code: 'USD' }, seller_receivable_breakdown: {
        total_refunded_amount: { value: '1.00', currency_code: 'USD' } } });
    expect((await sendWebhook(paymentEvent('WH-PARTIAL-FIRST', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(10);
    expect((await sendWebhook(paymentEvent('WH-FULL-LATER', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
    expect(await CreditTransaction.countDocuments({ type: 'TOPUP_REFUND' })).toBe(2);
  });

  test('refund before local capture reconciliation first records the purchase then reverses it', async () => {
    await create();
    expect((await sendWebhook(paymentEvent('WH-EARLY-REFUND', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:capture:${CAPTURE}` })).toMatchObject({ status: 'committed' });
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:4.99` })).toMatchObject({ status: 'refunded' });
  });

  test('duplicate full refund events and later reversal do not remove credits twice', async () => {
    await create(); await capture();
    expect((await sendWebhook(paymentEvent('WH-FULL-ONE', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await sendWebhook(paymentEvent('WH-FULL-TWO', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await sendWebhook(paymentEvent('WH-REVERSE-AFTER-REFUND', 'PAYMENT.CAPTURE.REVERSED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
    expect(await CreditTransaction.countDocuments({ type: 'TOPUP_REFUND', status: 'refunded' })).toBe(1);
    expect(await CreditTransaction.countDocuments({ idempotencyKey: `paypal-topup:reversal:${CAPTURE}:full` })).toBe(0);
  });

  test('crash after refund wallet decrement recovers without another decrement', async () => {
    await create(); await capture();
    const spy = jest.spyOn(CreditTransaction, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated refund finalization crash'));
    expect((await sendWebhook(paymentEvent('WH-REFUND-CRASH', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(500);
    spy.mockRestore();
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
    expect((await sendWebhook(paymentEvent('WH-REFUND-CRASH', 'PAYMENT.CAPTURE.REFUNDED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
    expect(await CreditTransaction.findOne({ idempotencyKey: `paypal-topup:refund:${CAPTURE}:USD:4.99` })).toMatchObject({ status: 'refunded', amount: -10 });
  });

  test('documented reversal uses the same safe full-pack reversal rule', async () => {
    await create(); await capture(); expect((await sendWebhook(paymentEvent('WH-REVERSE', 'PAYMENT.CAPTURE.REVERSED'))).status).toBe(200);
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(0);
  });

  test('unknown capture event is stored review_required and never mutates wallet', async () => {
    await create(); await capture(); const before = (await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits;
    const res = await sendWebhook(paymentEvent('WH-UNKNOWN', 'PAYMENT.CAPTURE.SOMETHING_NEW'));
    expect(res.status).toBe(202); expect(await PaymentProviderEvent.findOne({ providerEventId: 'WH-UNKNOWN' })).toMatchObject({ status: 'review_required' });
    expect((await CreditWallet.findOne({ userId: teacher._id })).purchasedCredits).toBe(before);
  });

  test('webhook verification failure performs no payment work', async () => {
    await create(); paypalMock.verifyWebhookSignature.mockResolvedValue({ verification_status: 'FAILURE' });
    expect((await sendWebhook(paymentEvent('WH-BAD-SIG', 'PAYMENT.CAPTURE.COMPLETED'))).status).toBe(400);
    expect(paypalMock.getOrder).not.toHaveBeenCalled(); expect(await PaymentProviderEvent.countDocuments()).toBe(0);
  });
});
