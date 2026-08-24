'use strict';

jest.mock('../src/models/assignment.model', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../src/models/membership.model', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/FlashcardSet', () => ({ find: jest.fn() }));
jest.mock('../src/models/Worksheet', () => ({ find: jest.fn() }));

const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const FlashcardSet = require('../src/models/FlashcardSet');
const Worksheet = require('../src/models/Worksheet');
const controller = require('../src/controllers/assignment.controller');

const response = () => {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};

function populatedQuery(value) {
  return {
    populate() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

function resourceQuery(values) {
  return { select() { return this; }, lean: jest.fn().mockResolvedValue(values) };
}

describe('assignment QR access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Membership.findOne.mockResolvedValue({ _id: 'membership-1' });
    Assignment.updateMany.mockResolvedValue({ modifiedCount: 0 });
  });

  test.each([
    ['essay', null],
    [undefined, null],
    ['flashcard', '507f1f77bcf86cd799439011'],
    ['worksheet', '507f191e810c19729de860ea']
  ])('resolves an enrolled student assignment for %s without persistence', async (resourceType, resourceId) => {
    const assignment = { _id: 'assignment-1', title: 'Work', resourceType, resourceId,
      class: { _id: 'class-1', isActive: true }, isActive: true };
    Assignment.findOne.mockReturnValue(populatedQuery(assignment));
    FlashcardSet.find.mockReturnValue(resourceQuery(resourceId ? [{ _id: resourceId }] : []));
    Worksheet.find.mockReturnValue(resourceQuery(resourceId ? [{ _id: resourceId }] : []));
    const res = response();

    await controller.getAssignmentByQrToken({ params: { qrToken: 'opaque-token' },
      user: { _id: 'student-1', role: 'student' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toBe(assignment);
    expect(Membership.findOne).toHaveBeenCalledWith({ student: 'student-1', class: 'class-1', status: 'active' });
    expect(Assignment.updateMany).not.toHaveBeenCalled();
  });

  it('denies a non-member without creating assignment state', async () => {
    Assignment.findOne.mockReturnValue(populatedQuery({ _id: 'assignment-1', resourceType: 'essay',
      class: { _id: 'class-1', isActive: true }, isActive: true }));
    Membership.findOne.mockResolvedValue(null);
    const res = response();
    await controller.getAssignmentByQrToken({ params: { qrToken: 'opaque-token' },
      user: { _id: 'student-2', role: 'student' } }, res);
    expect(res.statusCode).toBe(403);
    expect(Assignment.updateMany).not.toHaveBeenCalled();
  });

  it('returns not found for an invalid token', async () => {
    Assignment.findOne.mockReturnValue(populatedQuery(null));
    const res = response();
    await controller.getAssignmentByQrToken({ params: { qrToken: 'missing' },
      user: { _id: 'student-1', role: 'student' } }, res);
    expect(res.statusCode).toBe(404);
    expect(Membership.findOne).not.toHaveBeenCalled();
  });
});
