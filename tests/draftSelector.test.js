'use strict';
// Draft comparison selector (DRAFT_COMPARISON_V2_ENABLED): ?againstDraft=<n> picks an earlier draft of the same chain; the v2 payload lists the
// earlier drafts (number, date, score) without ids. Flag off: the parameter is ignored and the payload is v1. Synthetic data only.
process.env.JWT_SECRET = 'draft-selector-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/draft-selector';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const { captureCurrentRevision } = require('../src/services/submissionRevision.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture;
const jwt = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
const asUser = (user, id, query = '') => request(app).get(`/api/submissions/${id}/draft-comparison${query}`).set('Authorization', `Bearer ${jwt(user)}`);
const asGuest = (id, query = '') => request(app).get(`/api/guest/submissions/${id}/drafts${query}`).set('X-Guest-Token', fixture.guestToken);
async function threeDrafts(id) {
  for (const next of [2, 3]) {
    await captureCurrentRevision(await Submission.findById(id));
    await Submission.updateOne({ _id: id }, { $set: { draftNumber: next, fileContentIdentity: `selector-${next}-${id}` } });
  }
}
beforeAll(connectInMemoryMongo);
beforeEach(async () => {
  process.env.DRAFT_COMPARISON_V2_ENABLED = 'true';
  await mongoose.connection.dropDatabase(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
});
afterAll(async () => { delete process.env.DRAFT_COMPARISON_V2_ENABLED; await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

test('default: latest vs previous, with the earlier drafts listed (number, date, score; no ids)', async () => {
  await threeDrafts(fixture.IDS.registered);
  const data = (await asUser(fixture.student, fixture.IDS.registered)).body.data;
  expect({ previous: data.previousDraftNumber, current: data.currentDraftNumber }).toEqual({ previous: 2, current: 3 });
  expect(data.earlierDrafts.map(d => d.draftNumber)).toEqual([2, 1]);
  for (const draft of data.earlierDrafts) expect(Object.keys(draft).sort()).toEqual(['draftNumber', 'score', 'submittedAt']);
  expect(data.earlierDrafts[0].score).toBe(82);
});
test('?againstDraft=1 compares the latest draft with draft 1; the v2 per-error list is there for the chosen pair', async () => {
  await threeDrafts(fixture.IDS.registered);
  const data = (await asUser(fixture.student, fixture.IDS.registered, '?againstDraft=1')).body.data;
  expect({ previous: data.previousDraftNumber, current: data.currentDraftNumber, version: data.comparisonVersion }).toEqual({ previous: 1, current: 3, version: 2 });
  expect(data.issueDetails).toBeDefined();
});
test('drafts outside the chain or not earlier are refused; malformed numbers are 400', async () => {
  await threeDrafts(fixture.IDS.registered);
  for (const query of ['?againstDraft=3', '?againstDraft=9']) {
    const res = await asUser(fixture.student, fixture.IDS.registered, query);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'DRAFT_NOT_FOUND' });
  }
  for (const query of ['?againstDraft=x', '?againstDraft=1.5', '?againstDraft=0']) expect((await asUser(fixture.student, fixture.IDS.registered, query)).status).toBe(400);
});
test('authorization: the class teacher may choose a draft; another teacher gets 404', async () => {
  await threeDrafts(fixture.IDS.registered);
  expect((await asUser(fixture.teacher, fixture.IDS.registered, '?againstDraft=1')).body.data.previousDraftNumber).toBe(1);
  expect((await asUser(fixture.otherTeacher, fixture.IDS.registered, '?againstDraft=1')).status).toBe(404);
});
test('guest link: only its own chain, the selector works there, nothing internal', async () => {
  await threeDrafts(fixture.IDS.guest);
  const res = await asGuest(fixture.IDS.guest, '?againstDraft=1');
  expect(res.status).toBe(200);
  expect(res.body.data.previousDraftNumber).toBe(1);
  expect(JSON.stringify(res.body)).not.toMatch(/previousSubmissionId|sourceSubmissionId|"_id"|teacher@example\.com/);
  expect([401, 403, 404, 410]).toContain((await asGuest(fixture.IDS.registered, '?againstDraft=1')).status);
});
test('flag off: the parameter is ignored and the payload is v1', async () => {
  await threeDrafts(fixture.IDS.registered);
  process.env.DRAFT_COMPARISON_V2_ENABLED = 'false';
  const data = (await asUser(fixture.student, fixture.IDS.registered, '?againstDraft=1')).body.data;
  expect(data.previousDraftNumber).toBe(2);
  expect(data).not.toHaveProperty('earlierDrafts');
  expect(data).not.toHaveProperty('comparisonVersion');
  expect((await asUser(fixture.student, fixture.IDS.registered, '?againstDraft=x')).status).toBe(200);
});
