jest.mock('../src/models/Plan', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../src/models/class.model', () => ({ countDocuments: jest.fn().mockResolvedValue(1) }));
jest.mock('../src/services/paypal/paypalPlanMapping.service', () => ({ getPlanByPayPalPlanId: jest.fn() }));
const Plan = require('../src/models/Plan');
const { getPlanByPayPalPlanId } = require('../src/services/paypal/paypalPlanMapping.service');
const { ensureActivePlan, enforceUsageLimit } = require('../src/middlewares/usage.middleware');
const free = { _id: 'free', slug: 'free', isActive: true, features: { maxClasses: 1 } };
beforeEach(() => { jest.clearAllMocks(); Plan.findOne.mockResolvedValue(free); Plan.findById.mockResolvedValue(free); });
test('free teacher quota is still resolved and enforced', async () => {
  const user = { role: 'teacher', plan: 'free', usage: { classes: 1 }, save: jest.fn() };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  await enforceUsageLimit('classes', 1)({ user }, res, next);
  expect(Plan.findOne).toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
});
test('active PayPal teacher retains paid plan', async () => {
  const paid = { _id: 'paid', slug: 'pro', features: { maxClasses: 100 } };
  getPlanByPayPalPlanId.mockResolvedValue(paid);
  expect(await ensureActivePlan({ role: 'teacher', plan: 'paid', paypalSubscriptionStatus: 'ACTIVE', paypalPlanId: 'P-PAID' })).toBe(paid);
});
test('legacy Stripe fields cannot grant a paid entitlement', async () => {
  const user = { role: 'teacher', plan: 'paid', stripePriceId: 'price_legacy', stripeSubscriptionStatus: 'active', save: jest.fn() };
  expect(await ensureActivePlan(user)).toBe(free);
  expect(user.stripePriceId).toBe('price_legacy');
  expect(Plan.findOne).toHaveBeenCalledTimes(1);
});
