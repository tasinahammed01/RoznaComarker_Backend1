'use strict';

const { EventEmitter } = require('events');
const mockUserUpdateOne = jest.fn();
const mockPlan = { _id: 'plan-1', slug: 'essential', isActive: true,
  features: { aiWorksheets: true, aiWorksheetsLimit: 5 } };

jest.mock('../src/models/user.model', () => ({ updateOne: (...args) => mockUserUpdateOne(...args) }));
jest.mock('../src/models/Plan', () => ({
  findOne: jest.fn(() => Promise.resolve(mockPlan)),
  findById: jest.fn(() => Promise.resolve(mockPlan)),
}));
jest.mock('../src/models/class.model', () => ({}));
jest.mock('../src/services/stripeSubscription.service', () => ({ isSubscriptionEntitled: () => false }));
jest.mock('../src/services/paypal/paypalPlanMapping.service', () => ({ getPlanByPayPalPlanId: jest.fn() }));

const { reserveAiWorksheetUsage } = require('../src/middlewares/usage.middleware');

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = () => res;
  return res;
}

describe('AI worksheet usage reservation lifecycle', () => {
  beforeEach(() => mockUserUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 }));

  test.each([
    ['DOCX parse failure', 400],
    ['AI request failure', 500],
    ['schema validation failure', 500],
    ['repair failure', 500],
  ])('rolls back the reservation after %s', async (_stage, statusCode) => {
    const req = { user: { _id: 'teacher-1', role: 'teacher', plan: 'plan-1', usage: { aiWorksheets: 0 } } };
    const res = response();
    const next = jest.fn();
    await reserveAiWorksheetUsage()(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.statusCode = statusCode;
    res.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockUserUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockUserUpdateOne.mock.calls[1][1]).toEqual({ $inc: { 'usage.aiWorksheets': -1 } });
  });

  test('keeps exactly one reservation after successful extraction', async () => {
    const req = { user: { _id: 'teacher-1', role: 'teacher', plan: 'plan-1', usage: { aiWorksheets: 0 } } };
    const res = response();
    await reserveAiWorksheetUsage()(req, res, jest.fn());
    res.statusCode = 200;
    res.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockUserUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUserUpdateOne.mock.calls[0][1]).toEqual({ $inc: { 'usage.aiWorksheets': 1 } });
  });
});
