'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'paypal-cancellation-test-secret';
process.env.PAYMENT_PROVIDER = 'paypal';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
process.env.PAYPAL_PRODUCT_ID = 'PROD-SAFE';
process.env.PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID = 'P-ESSENTIAL-MONTHLY';
process.env.PAYPAL_WEBHOOK_ID = 'WH-SAFE';
process.env.PAYPAL_RETURN_URL = 'http://localhost:4200/billing/paypal/success';
process.env.PAYPAL_CANCEL_URL = 'http://localhost:4200/billing/paypal/cancel';

const paypalMock = { createSubscription: jest.fn(), getSubscription: jest.fn(), verifyWebhookSignature: jest.fn() };
jest.mock('../src/services/paypal/paypalClient.service', () => ({
  PayPalClient: jest.fn(() => paypalMock), PayPalApiError: class PayPalApiError extends Error {}
}));

const { syncSubscription } = require('../src/services/paypal/paypalSubscription.service');
const { ensureActivePlan } = require('../src/middlewares/usage.middleware');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const PaymentCheckoutAttempt = require('../src/models/PaymentCheckoutAttempt');
const PaymentManagementAttempt = require('../src/models/PaymentManagementAttempt');
const CreditWallet = require('../src/models/CreditWallet');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

const SUBSCRIPTION = 'I-PAYPAL-CANCEL-TEST';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';
let free, essential, pro;

function subscription(status = 'ACTIVE', planId = 'P-ESSENTIAL-MONTHLY', nextBillingTime = null) {
  const base = {
    id: SUBSCRIPTION,
    plan_id: planId,
    custom_id: ATTEMPT_ID,
    status,
    start_time: '2026-08-31T00:00:00Z'
  };
  if (nextBillingTime) {
    base.billing_info = { next_billing_time: nextBillingTime };
  }
  return base;
}

describe('PayPal Cancellation Entitlement Fix', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  
  beforeEach(async () => {
    await clearDatabase();
    jest.clearAllMocks();
    
    free = await Plan.create({
      name: 'Free',
      slug: 'free',
      price: 0,
      currency: 'USD',
      billingInterval: 'month',
      isActive: true,
      features: { essayAnalysesPerMonth: 25, storageMB: 500, maxClasses: 3, maxStudents: 50 }
    });
    
    essential = await Plan.create({
      name: 'Essential Monthly',
      slug: 'essential_monthly',
      price: 9.99,
      currency: 'USD',
      billingInterval: 'month',
      isActive: true,
      features: { essayAnalysesPerMonth: 300, storageMB: 2048, maxClasses: 10, maxStudents: 200 }
    });
    
    pro = await Plan.create({
      name: 'Pro Annual',
      slug: 'pro_annual',
      price: 99,
      currency: 'USD',
      billingInterval: 'year',
      isActive: true,
      features: { essayAnalysesPerMonth: 500, storageMB: 5120, maxClasses: 25, maxStudents: 500 }
    });
  });

  describe('syncSubscription() - CANCELLED behavior', () => {
    test('1. ACTIVE Essential: paid plan remains Essential', async () => {
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: free._id
      });
      
      const attempt = await PaymentCheckoutAttempt.create({
        provider: 'paypal',
        attemptId: ATTEMPT_ID,
        userId: teacher._id,
        planKey: 'essential_monthly',
        billingInterval: 'monthly',
        providerPlanId: 'P-ESSENTIAL-MONTHLY',
        providerSubscriptionId: SUBSCRIPTION,
        status: 'approval_pending'
      });
      
      const activeSub = subscription('ACTIVE', 'P-ESSENTIAL-MONTHLY', '2026-10-07T00:00:00Z');
      const result = await syncSubscription(activeSub, { eventType: 'TEST' });
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(String(updatedTeacher.plan)).toBe(String(essential._id));
      expect(updatedTeacher.paypalSubscriptionStatus).toBe('ACTIVE');
      expect(updatedTeacher.paypalPlanId).toBe('P-ESSENTIAL-MONTHLY');
    });

    test('2. CANCELLED with paypalCurrentPeriodEnd 20 days in future: user.plan remains Essential, planExpiresAt remains future, no assign Free', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', futureDate.toISOString());
      const result = await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(String(updatedTeacher.plan)).toBe(String(essential._id));
      expect(updatedTeacher.paypalSubscriptionStatus).toBe('CANCELLED');
      expect(updatedTeacher.paypalPlanId).toBe('P-ESSENTIAL-MONTHLY');
      expect(updatedTeacher.paypalCurrentPeriodEnd).not.toBeNull();
      expect(new Date(updatedTeacher.paypalCurrentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
    });

    test('3. CANCELLED provider response with no next_billing_time: preserves existing paypalCurrentPeriodEnd', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', null);
      const result = await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(updatedTeacher.paypalCurrentPeriodEnd).not.toBeNull();
      expect(new Date(teacher.paypalCurrentPeriodEnd).getTime()).toBe(futureDate.getTime());
    });

    test('4. CANCELLED does not clear paypalPlanId', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', futureDate.toISOString());
      await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(updatedTeacher.paypalPlanId).toBe('P-ESSENTIAL-MONTHLY');
    });

    test('5. CANCELLED management attempt becomes completed', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const managementAttempt = await PaymentManagementAttempt.create({
        provider: 'paypal',
        attemptId: ATTEMPT_ID,
        userId: teacher._id,
        providerSubscriptionId: SUBSCRIPTION,
        operation: 'CANCEL',
        status: 'processing'
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', futureDate.toISOString());
      await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedAttempt = await PaymentManagementAttempt.findById(managementAttempt._id);
      expect(updatedAttempt.status).toBe('completed');
      expect(updatedAttempt.completedAt).not.toBeNull();
    });

    test('6. CANCELLED does not modify purchased credits', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const now = new Date();
      const wallet = await CreditWallet.create({
        userId: teacher._id,
        purchasedCredits: 100,
        bonusCredits: 50,
        lastCreditReset: now,
        billingCycleStart: now,
        billingCycleEnd: futureDate
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', futureDate.toISOString());
      await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedWallet = await CreditWallet.findById(wallet._id);
      expect(updatedWallet.purchasedCredits).toBe(100);
    });

    test('7. CANCELLED does not modify bonus credits', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const now = new Date();
      const wallet = await CreditWallet.create({
        userId: teacher._id,
        purchasedCredits: 100,
        bonusCredits: 50,
        lastCreditReset: now,
        billingCycleStart: now,
        billingCycleEnd: futureDate
      });
      
      const cancelledSub = subscription('CANCELLED', 'P-ESSENTIAL-MONTHLY', futureDate.toISOString());
      await syncSubscription(cancelledSub, { eventType: 'TEST' });
      
      const updatedWallet = await CreditWallet.findById(wallet._id);
      expect(updatedWallet.bonusCredits).toBe(50);
    });

    test('8. EXPIRED: Free becomes effective', async () => {
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionId: SUBSCRIPTION,
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalSubscriptionStatus: 'ACTIVE'
      });
      
      const attempt = await PaymentCheckoutAttempt.create({
        provider: 'paypal',
        attemptId: ATTEMPT_ID,
        userId: teacher._id,
        planKey: 'essential_monthly',
        billingInterval: 'monthly',
        providerPlanId: 'P-ESSENTIAL-MONTHLY',
        providerSubscriptionId: SUBSCRIPTION,
        status: 'active'
      });
      
      const expiredSub = subscription('EXPIRED', 'P-ESSENTIAL-MONTHLY', null);
      await syncSubscription(expiredSub, { eventType: 'TEST' });
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(String(updatedTeacher.plan)).toBe(String(free._id));
      expect(updatedTeacher.paypalSubscriptionStatus).toBe('EXPIRED');
    });
  });

  describe('ensureActivePlan() - CANCELLED entitlement behavior', () => {
    test('9. ACTIVE PayPal: returns paid PayPal plan', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: free._id,
        paypalSubscriptionStatus: 'ACTIVE',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(String(plan._id)).toBe(String(essential._id));
    });

    test('10. CANCELLED + period end in future: returns paid PayPal plan', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(String(plan._id)).toBe(String(essential._id));
    });

    test('11. CANCELLED + period end in past: returns Free', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: pastDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(String(plan._id)).toBe(String(free._id));
    });

    test('12. CANCELLED + invalid/missing period end: does not grant indefinite paid access; follows safe existing fallback/Free behavior', async () => {
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: null
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(String(plan._id)).toBe(String(free._id));
    });

    test('13. CANCELLED + future paid-through + stale user.plan: repairs user.plan to authoritative paypalPlanId mapping', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: free._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(String(plan._id)).toBe(String(essential._id));
      
      const updatedTeacher = await User.findById(teacher._id);
      expect(String(updatedTeacher.plan)).toBe(String(essential._id));
    });

    test('14. repair does NOT extend planExpiresAt beyond provider paid-through date', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: free._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: futureDate
      });
      
      await ensureActivePlan(teacher);
      const updatedTeacher = await User.findById(teacher._id);
      
      expect(updatedTeacher.planExpiresAt).not.toBeNull();
      expect(new Date(updatedTeacher.planExpiresAt).getTime()).toBeLessThanOrEqual(futureDate.getTime());
    });

    test('15. storage/usage entitlement resolves paid limits before expiry', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: free._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: futureDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(plan.features.storageMB).toBe(2048);
      expect(plan.features.essayAnalysesPerMonth).toBe(300);
    });

    test('16. same account resolves Free limits after expiry', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 20);
      
      const teacher = await User.create({
        firebaseUid: `teacher-${Date.now()}`,
        email: `teacher-${Date.now()}@example.com`,
        role: 'teacher',
        plan: essential._id,
        paypalSubscriptionStatus: 'CANCELLED',
        paypalPlanId: 'P-ESSENTIAL-MONTHLY',
        paypalCurrentPeriodEnd: pastDate
      });
      
      const plan = await ensureActivePlan(teacher);
      expect(plan.features.storageMB).toBe(500);
      expect(plan.features.essayAnalysesPerMonth).toBe(25);
    });
  });
});
