'use strict';
// A signed-in account that opens a guest QR link: the guest routes never read the session. The submission is a guest
// submission (no student, no account link), the teacher's credits are checked, and the account itself is untouched.
// The registered QR lookup answers 403 to a non-member: the frontend relies on that status to offer the guest form.
process.env.JWT_SECRET = 'guest-ignores-session-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/guest-session-test-' + process.pid;
jest.setTimeout(60000);
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 1000 }) };
});
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const Notification = require('../src/models/notification.model');
const accounting = require('../src/services/assessmentCreditRouter.service');
const email = require('../src/services/email.service');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FYQAAAAASUVORK5CYII=', 'base64');
const root = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');
let teacher, student, classDoc, assignment;
const bearer = user => `Bearer ${signTestJwt(user)}`;
const submitAs = (user, fields = {}) => {
  const req = request(app).post('/api/guest/assignments/share-token/submit').set('Idempotency-Key', crypto.randomUUID());
  if (user) req.set('Authorization', bearer(user));
  return req.field('name', fields.name ?? 'Typed Guest Name').field('email', fields.email ?? 'typed-guest@example.com')
    .attach('files', png, { filename: 'writing.png', contentType: 'image/png' });
};
const accountSnapshot = async id => {
  const doc = await User.findById(id).lean();
  delete doc.updatedAt;
  return JSON.stringify(doc);
};

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  await disconnectInMemoryMongo();
  // Delete only this test's own Multer output.
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
});
beforeEach(async () => {
  process.env.GUEST_SUBMISSION_ENABLED = 'true';
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  accounting.canRunAssessment.mockResolvedValue({ allowed: true });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
  student = await User.create({ firebaseUid: crypto.randomUUID(), email: 'account-student@example.com', role: 'student', displayName: 'Account Student' });
  classDoc = await Class.create({ name: 'Writing', teacher: teacher._id, joinCode: 'SESSION-TEST' });
  assignment = await Assignment.create({ title: 'Guest essay', class: classDoc._id, teacher: teacher._id,
    instructions: 'Write an essay.', qrToken: 'share-token', allowGuestSubmission: true });
});

test('the registered QR lookup answers 403 to a signed-in student who is not a member, and 200 to a member', async () => {
  const lookup = () => request(app).get('/api/assignments/qr/share-token').set('Authorization', bearer(student));
  expect((await lookup()).status).toBe(403);
  await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
  expect((await lookup()).status).toBe(200);
});

test('a non-member student session on the guest link: guest entry and a guest submission, never linked to the account', async () => {
  const before = await accountSnapshot(student._id);
  const entry = await request(app).get('/api/guest/assignments/share-token').set('Authorization', bearer(student));
  expect(entry.status).toBe(200); expect(entry.body.data.title).toBe('Guest essay');

  const accepted = await submitAs(student);
  expect(accepted.status).toBe(200); expect(accepted.body.data.received).toBe(true);
  // guest.normalizedEmail is select:false; ask for it to prove which email was stored.
  const saved = await Submission.findOne({ assignment: assignment._id }).select('+guest.normalizedEmail').lean();
  expect(saved.submissionMode).toBe('guest');
  expect(saved.student).toBeUndefined();
  expect(saved.guest.displayName).toBe('Typed Guest Name');
  expect(saved.guest.normalizedEmail).toBe('typed-guest@example.com');
  expect(JSON.stringify(saved)).not.toContain(String(student._id));
  expect(JSON.stringify(saved)).not.toContain('account-student@example.com');

  // Credits: only the teacher's are checked; the account is never the payer.
  expect(accounting.canRunAssessment).toHaveBeenCalledTimes(1);
  const [creditArgs] = accounting.canRunAssessment.mock.calls[0];
  expect(String(creditArgs.teacherUserId)).toBe(String(teacher._id));
  expect(String(creditArgs.user._id)).toBe(String(teacher._id));
  // The return link goes to the typed email, not the account email.
  expect(email.sendGuestSubmissionEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'typed-guest@example.com' }));

  expect(await accountSnapshot(student._id)).toBe(before);
  expect(await Membership.countDocuments()).toBe(0);
  expect(await Submission.countDocuments({ student: student._id })).toBe(0);
  expect(await Notification.countDocuments({ recipientId: student._id })).toBe(0);
  expect(await User.countDocuments()).toBe(2);
});

test('the guest result is identical with or without a session header', async () => {
  const anonymous = await submitAs(null, { email: 'one@example.com' });
  const signedIn = await submitAs(student, { email: 'two@example.com' });
  expect(signedIn.status).toBe(anonymous.status);
  expect(Object.keys(signedIn.body.data).sort()).toEqual(Object.keys(anonymous.body.data).sort());
  const docs = await Submission.find({ assignment: assignment._id }).lean();
  expect(docs).toHaveLength(2);
  for (const doc of docs) { expect(doc.submissionMode).toBe('guest'); expect(doc.student).toBeUndefined(); }
});

test('an assignment that does not accept guests stays closed to a signed-in session on the guest routes', async () => {
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowGuestSubmission: false } });
  expect((await request(app).get('/api/guest/assignments/share-token').set('Authorization', bearer(student))).status).toBe(404);
  expect((await submitAs(student)).status).toBe(404);
  expect(await Submission.countDocuments()).toBe(0);
});
