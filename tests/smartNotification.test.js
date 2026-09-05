'use strict';
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'smart-notification-test';
const User = require('../src/models/user.model'); const Notification = require('../src/models/notification.model');
const service = require('../src/services/notification.service'); const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('smart notifications', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await Notification.init(); }); afterAll(disconnectInMemoryMongo); let teacher; let other;
  beforeEach(async () => { await clearDatabase(); teacher = await User.create({ firebaseUid: 'smart-teacher', email: 'smart@example.test', role: 'teacher' });
    other = await User.create({ firebaseUid: 'smart-other', email: 'other@example.test', role: 'teacher' }); });
  test('submission notification is actionable, categorized, and idempotent', async () => {
    const input = { recipientId: teacher._id, type: 'assignment_submitted', title: 'Assignment submitted', description: 'Student submitted Essay',
      idempotencyKey: 'submission:abc:submitted', data: { submissionId: 'abc', route: { path: '/teacher/my-classes/detail/student-submissions', params: ['student'] } } };
    await service.createSmartNotification(input); await service.createSmartNotification(input);
    const item = await Notification.findOne({ idempotencyKey: input.idempotencyKey }); expect(item).toMatchObject({ category: 'ACTION_REQUIRED', priority: 'HIGH' });
    expect(await Notification.countDocuments({ idempotencyKey: input.idempotencyKey })).toBe(1); expect(item.data.route.path).toBe('/teacher/my-classes/detail/student-submissions');
  });
  test('revision identities remain distinct from the first submission', async () => {
    for (const key of ['submission:abc:submitted', 'submission:abc:revision:2']) await service.createSmartNotification({ recipientId: teacher._id,
      type: 'assignment_submitted', title: 'Submitted', description: 'Submitted', idempotencyKey: key });
    expect(await Notification.countDocuments({ idempotencyKey: { $in: ['submission:abc:submitted', 'submission:abc:revision:2'] } })).toBe(2);
  });
  test('adaptive completion creates one normal progress record', async () => {
    const input = { recipientId: teacher._id, type: 'adaptive_completed', title: 'Adaptive Learning completed', description: 'Student completed Adaptive Learning', idempotencyKey: 'adaptive:s1:completed' };
    await Promise.all([service.createSmartNotification(input), service.createSmartNotification(input)]);
    expect(await Notification.findOne({ idempotencyKey: input.idempotencyKey })).toMatchObject({ category: 'STUDENT_PROGRESS', priority: 'NORMAL' });
    expect(await Notification.countDocuments({ idempotencyKey: input.idempotencyKey })).toBe(1);
  });
  test('reward, milestone, and credit nudge taxonomy remains compatible', async () => {
    await service.createNotification({ recipientId: teacher._id, type: 'referral_reward', title: 'Reward', description: 'Reward', idempotencyKey: 'reward:1' });
    await service.createNotification({ recipientId: teacher._id, type: 'professional_milestone', title: 'Milestone', description: 'Milestone', idempotencyKey: 'milestone:1' });
    await service.createNotification({ recipientId: teacher._id, type: 'credit_usage_nudge', title: 'Credits', description: 'Credits', idempotencyKey: 'credit:1' });
    expect(await Notification.countDocuments({ category: 'REWARD' })).toBe(2); expect(await Notification.countDocuments({ priority: 'HIGH' })).toBe(1);
  });
  test('unsafe external action targets are removed', async () => { const item = await service.createSmartNotification({ recipientId: teacher._id,
    type: 'assignment_submitted', title: 'Submitted', description: 'Submitted', idempotencyKey: 'unsafe:1', data: { route: { path: 'https://evil.example' } } });
    expect(item.data?.route).toBeUndefined(); });
  test('recipient ownership remains isolated and ordering remains chronological', async () => {
    await service.createSmartNotification({ recipientId: teacher._id, type: 'assignment_submitted', title: 'First', description: 'First', idempotencyKey: 'order:1' });
    await service.createSmartNotification({ recipientId: other._id, type: 'assignment_submitted', title: 'Foreign', description: 'Foreign', idempotencyKey: 'order:foreign' });
    await service.createSmartNotification({ recipientId: teacher._id, type: 'assignment_submitted', title: 'Second', description: 'Second', idempotencyKey: 'order:2' });
    const own = await Notification.find({ recipient: teacher._id }).sort({ createdAt: -1 }); expect(own.map((x) => x.title)).toEqual(['Second', 'First']);
  });
});
