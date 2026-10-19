'use strict';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const access = require('../src/services/guestAccess.service');
jest.setTimeout(60000);
beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(disconnectInMemoryMongo);
beforeEach(clearDatabase);
function guest(fields = {}) {
  const issued = access.issueToken();
  return { issued, data: { submissionMode: 'guest', assignment: new mongoose.Types.ObjectId(),
    class: new mongoose.Types.ObjectId(), submittedAt: new Date(), status: 'submitted',
    guest: { displayName: 'Student', normalizedEmail: 'guest@example.com', accessHash: issued.accessHash, expiresAt: issued.expiresAt }, ...fields } };
}
test('old/new assignments default to protected and registered submissions still require a student', async () => {
  expect(new Assignment().allowGuestSubmission).toBe(false);
  expect(new Submission().validateSync().errors.student).toBeDefined();
});
test('guest identity validates and normalizes without consulting User or Firebase', () => {
  expect(access.identity({ name: '  A Student  ', email: ' USER@Example.COM ' })).toEqual({ displayName: 'A Student', normalizedEmail: 'user@example.com' });
  for (const name of ['', '   ', '.'.repeat(3), 'a'.repeat(121)]) expect(() => access.identity({ name, email: 'a@b.com' })).toThrow();
  for (const email of ['', 'x', 'a@b', 'a\r\n@b.com', 'x'.repeat(255) + '@b.com']) expect(() => access.identity({ name: 'Student', email })).toThrow();
});
test('tokens have 256 random bits, one-way storage and centralized expiry', () => {
  const tokens = Array.from({ length: 100 }, access.issueToken);
  expect(new Set(tokens.map(t => t.token)).size).toBe(100);
  expect(tokens[0].token).toMatch(/^[\w-]{43}$/);
  expect(tokens[0].accessHash).toHaveLength(64);
  expect(tokens[0].accessHash).not.toBe(tokens[0].token);
  expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
});
test('only the exact guest token/submission pair works; cross-ID access and fabricated tokens fail', async () => {
  const a = guest(); const b = guest();
  const [one, two] = await Submission.create([a.data, b.data]);
  expect(String((await access.authorize(one.id, a.issued.token))._id)).toBe(one.id);
  await expect(access.authorize(two.id, a.issued.token)).rejects.toMatchObject({ statusCode: 410 });
  await expect(access.authorize(one.id, b.issued.token)).rejects.toMatchObject({ statusCode: 410 });
  await expect(access.authorize(one.id, 'fake')).rejects.toMatchObject({ statusCode: 410 });
  const stored = await Submission.findById(one._id).lean();
  expect(stored.guest.accessHash).toBeUndefined();
  expect(stored.guest.normalizedEmail).toBeUndefined();
  expect(JSON.stringify(await Submission.collection.findOne({ _id: one._id }))).not.toContain(a.issued.token);
});

test('rejection diagnostics report booleans without recording bearer material or hashes', async () => {
  const a = guest(); const doc = await Submission.create(a.data);
  const otherToken = access.issueToken().token;
  const warn = jest.spyOn(require('../src/utils/logger'), 'warn').mockImplementation(() => {});
  try {
    await expect(access.authorize(doc.id, otherToken)).rejects.toMatchObject({ statusCode: 410 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'guest_link_rejected',
      tokenPresent: true, headerPresent: true, tokenLength: 43, storedHashPresent: true,
      computedHashMatches: false, tokenExpired: false, tokenRevoked: false, submissionMode: 'guest' }));
    const output = JSON.stringify(warn.mock.calls);
    expect([a.issued.token, a.issued.accessHash, otherToken, access.hash(otherToken)].some(secret => output.includes(secret))).toBe(false);
  } finally { warn.mockRestore(); }
});
test.each(['expired', 'revoked'])('%s links fail securely', async mode => {
  const a = guest();
  if (mode === 'expired') a.data.guest.expiresAt = new Date(0);
  else a.data.guest.revokedAt = new Date();
  const doc = await Submission.create(a.data);
  await expect(access.authorize(doc.id, a.issued.token)).rejects.toMatchObject({ statusCode: 410 });
});
test('multiple guests per assignment work while registered uniqueness remains intact', async () => {
  const a = guest(); const b = guest({ assignment: a.data.assignment });
  await Submission.create([a.data, b.data]);
  const student = new mongoose.Types.ObjectId();
  const data = { ...a.data, submissionMode: 'registered', student };
  await Submission.create(data);
  await expect(Submission.create(data)).rejects.toMatchObject({ code: 11000 });
});
test('concurrent guest requests persist only one assessment source', async () => {
  const a = guest({ guestRequestKey: access.hash('one-intended-submission') });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => Submission.create(a.data)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await Submission.countDocuments()).toBe(1);
});
test('return token is a fragment and untrusted request hosts cannot choose the origin', () => {
  process.env.FRONTEND_URL = 'https://school.example';
  const issued = access.issueToken();
  const link = new URL(access.returnUrl(new mongoose.Types.ObjectId(), issued.token));
  expect(link.origin).toBe('https://school.example');
  expect(link.search).toBe(''); expect(link.hash).toBe('#' + issued.token);
});
