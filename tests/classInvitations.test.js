'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'invitation-test-secret';
process.env.FRONTEND_URL = 'https://comarkers.roznahub.com';
process.env.GCE_METADATA_DISABLED = 'true';
jest.mock('../src/services/email.service', () => ({ sendInvitationEmail: jest.fn() }));
const request = require('supertest');
const app = require('../src/app');
const Class = require('../src/models/class.model');
const User = require('../src/models/user.model');
const Membership = require('../src/models/membership.model');
const Invitation = require('../src/models/invitation.model');
const { sendInvitationEmail } = require('../src/services/email.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

jest.setTimeout(60000);
let number = 0;
async function actor(role) {
  number += 1;
  const user = await User.create({ firebaseUid: `${role}-${number}`, email: `${role}-${number}@example.test`, role });
  return { user, token: signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role }) };
}
async function setup() {
  const owner = await actor('teacher');
  const cls = await Class.create({ name: '<Math & Writing>', teacher: owner.user._id, joinCode: `INVITE${number}` });
  const send = emails => request(app).post(`/api/classes/${cls._id}/invite`).set('Authorization', `Bearer ${owner.token}`).send({ emails });
  return { owner, cls, send };
}
beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Class.init(), Invitation.init()]); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => { await clearDatabase(); await seedTestPlans(); sendInvitationEmail.mockReset().mockResolvedValue({ success: true }); });

test('two valid recipients are normalized, invited separately, and sent the canonical URL', async () => {
  const { send, cls } = await setup();
  const response = await send([' S.ALHARSHI@CSQU.EDU.OM ', ' salahalharshi@gmail.com']);
  expect(response.status).toBe(200);
  expect(response.body.data.summary).toMatchObject({ total: 2, invited: 2, errors: 0 });
  expect(sendInvitationEmail).toHaveBeenCalledTimes(2);
  expect(sendInvitationEmail.mock.calls[0][0]).toMatchObject({ to: 's.alharshi@csqu.edu.om', joinUrl: `https://comarkers.roznahub.com/student/join-class?joinCode=${cls.joinCode}` });
  expect(await Invitation.countDocuments({ class: cls._id, deliveryStatus: 'sent' })).toBe(2);
  expect(response.body.data.results[0].token).toBeUndefined();
});

test('duplicate recipient in one batch is sent once and retry reports already invited', async () => {
  const { send, cls } = await setup();
  const first = await send(['a@example.com', ' A@example.com ']);
  expect(first.body.data.summary).toMatchObject({ total: 1, invited: 1 });
  const second = await send(['a@example.com']);
  expect(second.body.data.summary).toMatchObject({ total: 1, already_invited: 1 });
  expect(sendInvitationEmail).toHaveBeenCalledTimes(1);
  expect(await Invitation.countDocuments({ class: cls._id })).toBe(1);
});

test('provider failure is truthful and retry sends the same invitation once', async () => {
  const { send, cls } = await setup();
  sendInvitationEmail.mockResolvedValueOnce({ success: false, error: 'SMTP_SECRET_DETAIL' }).mockResolvedValueOnce({ success: true });
  const first = await send(['a@example.com']);
  expect(first.body.data.summary).toMatchObject({ total: 1, invited: 0, errors: 1 });
  expect(JSON.stringify(first.body)).not.toContain('SMTP_SECRET_DETAIL');
  expect((await Invitation.findOne({ class: cls._id })).deliveryStatus).toBe('failed');
  const retry = await send(['a@example.com']);
  expect(retry.body.data.summary).toMatchObject({ invited: 1, errors: 0 });
  expect(sendInvitationEmail).toHaveBeenCalledTimes(2);
  expect(await Invitation.countDocuments({ class: cls._id })).toBe(1);
});

test('legacy invitation without delivery evidence is held for review, not claimed sent', async () => {
  const { send, cls, owner } = await setup();
  await Invitation.collection.insertOne({ class: cls._id, teacher: owner.user._id, email: 'legacy@example.com',
    status: 'pending', token: 'legacy-test-token', expiresAt: new Date(Date.now() + 86400000), invitedAt: new Date() });
  const response = await send(['legacy@example.com']);
  expect(response.body.data.summary).toMatchObject({ total: 1, invited: 0, errors: 1 });
  expect(response.body.data.results[0].message).toContain('cannot be verified');
  expect(sendInvitationEmail).not.toHaveBeenCalled();
});

test('already joined student is not emailed', async () => {
  const { send, cls } = await setup();
  const student = await User.create({ firebaseUid: 'joined-student', email: 'joined@example.com', role: 'student' });
  await Membership.create({ class: cls._id, student: student._id, status: 'active' });
  const response = await send(['joined@example.com']);
  expect(response.body.data.summary.already_joined).toBe(1);
  expect(sendInvitationEmail).not.toHaveBeenCalled();
});

test('rejects malformed and oversized lists before any delivery', async () => {
  const { send } = await setup();
  expect((await send(['wrong-email', 'valid@example.com'])).status).toBe(400);
  expect((await send(Array.from({ length: 26 }, (_, i) => `user${i}@example.com`))).status).toBe(400);
  expect(sendInvitationEmail).not.toHaveBeenCalled();
});

test('requires teacher ownership', async () => {
  const { cls } = await setup();
  const other = await actor('teacher');
  const student = await actor('student');
  const path = `/api/classes/${cls._id}/invite`;
  expect((await request(app).post(path).set('Authorization', `Bearer ${other.token}`).send({ emails: ['a@example.com'] })).status).toBe(404);
  expect((await request(app).post(path).set('Authorization', `Bearer ${student.token}`).send({ emails: ['a@example.com'] })).status).toBe(403);
  expect(sendInvitationEmail).not.toHaveBeenCalled();
});
