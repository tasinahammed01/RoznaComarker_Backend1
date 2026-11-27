'use strict';
// /api/similarity (teacher only) and /api/similarity/webhooks (the provider): 404 while off and for anyone but the owning teacher, the
// report view (percentages computed on read, own-class vs other-teacher sources, outdated text), exclude / restore with revision and
// request id, the webhooks' own JSON limit. Synthetic generated words only; no provider is called (provider none or a fake fetch).
process.env.JWT_SECRET = 'similarity-routes-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const SimilarityReport = require('../src/models/SimilarityReport');
const Submission = require('../src/models/Submission');
const check = require('../src/services/similarity/check.service');
const internal = require('../src/services/similarity/internal.service');
const { NOTICE_VERSION } = require('../src/services/similarity/policy');
const { words, person, classWithEssay, student, essay } = require('./helpers/similarityFixtures');

let app;
const ENV_KEYS = ['SIMILARITY_ENABLED', 'SIMILARITY_PROVIDER', 'SIMILARITY_DAILY_CHECKS_PER_TEACHER', 'SIMILARITY_CHECKS_PER_SUBMISSION'];
const savedEnv = {};
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  await connectInMemoryMongo();
  app = require('../src/app');
});
afterAll(async () => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } await disconnectInMemoryMongo(); });
beforeEach(async () => {
  await clearDatabase();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SIMILARITY_ENABLED = 'true'; process.env.SIMILARITY_PROVIDER = 'none';
});

const SHARED = words('s', 20);
async function scene() {
  const a = await classWithEssay({ label: 'a' });
  const b = await classWithEssay({ label: 'b' });
  const sa = await student(a.klass, 'sa');
  const sa2 = await student(a.klass, 'sa2');
  const sb = await student(b.klass, 'sb');
  const mine = await essay({ ...a, studentUser: sa.user, text: `${words('a', 30)} ${SHARED} ${words('a', 30, 30)}`,
    extra: { similarityNotice: { version: NOTICE_VERSION, acceptedAt: new Date() } } });
  const sameClass = await essay({ ...a, studentUser: sa2.user, text: `${words('c', 10)} ${SHARED}` });
  const otherTeacher = await essay({ ...b, studentUser: sb.user, text: `${words('b', 5)} ${words('s', 12)}` });
  await internal.indexSubmission(sameClass._id);
  await internal.indexSubmission(otherTeacher._id);
  return { a, b, sa, mine, sameClass, otherTeacher, teacher: a.teacher, other: b.teacher };
}
const auth = token => ({ Authorization: `Bearer ${token}` });
const get = (s, who) => request(app).get(`/api/similarity/submissions/${s.mine._id}`).set(auth(who.token));
const startCheck = (s, who, body = {}) => request(app).post(`/api/similarity/submissions/${s.mine._id}/checks`).set(auth(who.token))
  .set('Idempotency-Key', body.key || `k-${Math.random()}`).send(body);
async function checked(s) {
  const res = await startCheck(s, s.teacher);
  expect(res.status).toBe(202);
  await check.runQueued({ env: process.env });
  return (await get(s, s.teacher)).body.data;
}

describe('the switch and who may see it', () => {
  test('every route answers the same 404 while SIMILARITY_ENABLED is off (before sign-in is checked)', async () => {
    const s = await scene();
    process.env.SIMILARITY_ENABLED = 'false';
    const id = s.mine._id;
    for (const [method, url] of [['get', `/api/similarity/submissions/${id}`], ['post', `/api/similarity/submissions/${id}/checks`],
      ['post', `/api/similarity/submissions/${id}/checks/retry`], ['patch', `/api/similarity/submissions/${id}/sources/s1`],
      ['post', `/api/similarity/submissions/${id}/sources/restore-all`], ['get', `/api/similarity/submissions/${id}/pdf`],
      ['post', '/api/similarity/webhooks/copyleaks/completed/rb0123456789abcdef01234567']]) {
      const res = await request(app)[method](url).send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    }
  });
  test('404 for another teacher, a student, the essay\'s own student, an unknown id; 401 without sign-in', async () => {
    const s = await scene();
    const stranger = await person('teacher', 'stranger');
    expect((await get(s, s.other)).status).toBe(404);
    expect((await get(s, stranger)).status).toBe(404);
    expect((await get(s, s.sa)).status).toBe(404);
    expect((await startCheck(s, s.sa)).status).toBe(404);
    expect((await request(app).get(`/api/similarity/submissions/${new mongoose.Types.ObjectId()}`).set(auth(s.teacher.token))).status).toBe(404);
    expect((await request(app).get(`/api/similarity/submissions/${s.mine._id}`)).status).toBe(401);
  });
  test('responses are never cached', async () => {
    const s = await scene();
    expect((await get(s, s.teacher)).headers['cache-control']).toBe('private, no-store');
  });
});

describe('GET before any check, and starting a check', () => {
  test('no report yet: the panel state with the checks left and the word count', async () => {
    const s = await scene();
    process.env.SIMILARITY_DAILY_CHECKS_PER_TEACHER = '7';
    const res = await get(s, s.teacher);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ state: 'none', eligible: true, reason: null, wordCount: 80, checksLeftToday: 7, checksLeftForSubmission: 3,
      externalAvailable: false, noticeShown: true });
  });
  test('the external check is offered only with a configured provider and an essay that carries the notice', async () => {
    const s = await scene();
    process.env.SIMILARITY_PROVIDER = 'stub';
    expect((await get(s, s.teacher)).body.data).toMatchObject({ externalAvailable: true, noticeShown: true });
    const noNotice = await request(app).get(`/api/similarity/submissions/${s.sameClass._id}`).set(auth(s.teacher.token));
    expect(noNotice.body.data).toMatchObject({ externalAvailable: false, noticeShown: false });
  });
  test('POST needs an Idempotency-Key; 202 with the queued report; the same key again is the same check; errors are coded', async () => {
    const s = await scene();
    expect((await request(app).post(`/api/similarity/submissions/${s.mine._id}/checks`).set(auth(s.teacher.token)).send({})).status).toBe(400);
    const first = await startCheck(s, s.teacher, { key: 'same-key' });
    expect(first.status).toBe(202);
    expect(first.body.data.state).toBe('queued');
    expect((await startCheck(s, s.teacher, { key: 'same-key' })).status).toBe(202);
    const busy = await startCheck(s, s.teacher);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('SIMILARITY_IN_PROGRESS');
    expect((await SimilarityReport.findOne({ submissionId: s.mine._id }).lean()).checks).toHaveLength(1);
  });
  test('the caps answer 429 with their own codes', async () => {
    const s = await scene();
    process.env.SIMILARITY_CHECKS_PER_SUBMISSION = '1';
    await checked(s);
    const res = await startCheck(s, s.teacher);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('SIMILARITY_SUBMISSION_CAP');
  });
});

describe('the report view', () => {
  test('percentages computed on read; an own-class source can be opened and shows its passage, another teacher\'s is a label and a percentage only', async () => {
    const s = await scene();
    const data = await checked(s);
    expect(data).toMatchObject({ state: 'completed', outdated: false, totalWords: 80, matchedWords: 20, overallPercent: 25,
      external: { state: 'not_configured' } });
    expect(data.text).toEqual((await internal.loadEssay(s.mine._id)).text);
    const [own, other] = data.sources;
    expect(own).toEqual({ sourceId: 's1', number: 1, kind: 'internal', label: 'Another submission in Rubrilo', percent: 25, words: 20, excluded: false,
      compared: true, spans: [expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) })],
      open: { studentId: String(s.sameClass.student), classId: String(s.a.klass._id), assignmentId: String(s.a.assignment._id), submissionId: String(s.sameClass._id) } });
    expect(other).toEqual({ sourceId: 's2', number: null, kind: 'internal', label: 'Another submission in Rubrilo', percent: 0, words: 0, excluded: false,
      compared: true });
    const json = JSON.stringify(data);
    expect(json).not.toContain(String(s.otherTeacher._id));
    expect(json).not.toContain(String(s.other.user._id));
    expect(json).not.toMatch(/refSubmissionId|refTeacherId|attemptKey|externalRef|providerPending|lastRequestId|"by"/);
    expect(data.highlights).toEqual([{ start: expect.any(Number), end: expect.any(Number), sourceId: 's1' }]);
  });
  test('a source whose essay was deleted is labelled as removed and cannot be opened', async () => {
    const s = await scene();
    await checked(s);
    await Submission.deleteOne({ _id: s.sameClass._id });
    const data = (await get(s, s.teacher)).body.data;
    expect(data.sources[0]).toMatchObject({ label: 'A submission that was removed' });
    expect(data.sources[0].open).toBeUndefined();
  });
  test('the essay text changed after the check: outdated', async () => {
    const s = await scene();
    await checked(s);
    const next = `${words('z', 10)} ${SHARED}`;
    await Submission.updateOne({ _id: s.mine._id }, { $set: { 'ocrPages.0.text': next, 'ocrPages.0.words': next.split(' ').map((w, i) => ({ id: `w${i}`, text: w, page: 1 })) } });
    expect((await get(s, s.teacher)).body.data.outdated).toBe(true);
  });
  test('a teacher-only audit block names the provider; the essay\'s student and guests never reach these routes', async () => {
    const s = await scene();
    const data = await checked(s);
    expect(data.audit).toEqual({ provider: null, units: null, costUsd: null, resultCount: null });
  });
});

describe('exclude and restore', () => {
  const patch = (s, sourceId, body) => request(app).patch(`/api/similarity/submissions/${s.mine._id}/sources/${sourceId}`).set(auth(s.teacher.token)).send(body);
  test('excluding updates the percentages at once; the same request id again changes nothing; a stale revision is 409 with the current report', async () => {
    const s = await scene();
    const data = await checked(s);
    const res = await patch(s, 's1', { excluded: true, revision: data.revision, requestId: 'ex-1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ overallPercent: 15, revision: data.revision + 1 });
    expect(res.body.data.sources.find(x => x.sourceId === 's1')).toMatchObject({ excluded: true, percent: null, number: null });
    expect(res.body.data.sources.find(x => x.sourceId === 's2')).toMatchObject({ percent: 15, number: 1 });
    const again = await patch(s, 's1', { excluded: true, revision: data.revision, requestId: 'ex-1' });
    expect(again.status).toBe(200);
    expect(again.body.data.revision).toBe(data.revision + 1);
    const stale = await patch(s, 's2', { excluded: true, revision: data.revision, requestId: 'ex-2' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SIMILARITY_REVISION_CONFLICT');
    expect(stale.body.data.revision).toBe(data.revision + 1);
  });
  test('restore one, and restore all', async () => {
    const s = await scene();
    let data = await checked(s);
    data = (await patch(s, 's1', { excluded: true, revision: data.revision, requestId: 'a' })).body.data;
    data = (await patch(s, 's2', { excluded: true, revision: data.revision, requestId: 'b' })).body.data;
    expect(data.overallPercent).toBe(0);
    data = (await patch(s, 's2', { excluded: false, revision: data.revision, requestId: 'c' })).body.data;
    expect(data.overallPercent).toBe(15);
    const all = await request(app).post(`/api/similarity/submissions/${s.mine._id}/sources/restore-all`).set(auth(s.teacher.token))
      .send({ revision: data.revision, requestId: 'd' });
    expect(all.status).toBe(200);
    expect(all.body.data.overallPercent).toBe(25);
    expect(all.body.data.sources.every(x => !x.excluded)).toBe(true);
  });
  test('bad input: an unknown source 404, a missing revision or request id 400, while a check runs 409, another teacher 404', async () => {
    const s = await scene();
    const data = await checked(s);
    expect((await patch(s, 's9', { excluded: true, revision: data.revision, requestId: 'x' })).status).toBe(404);
    expect((await patch(s, 's1', { excluded: 'yes', revision: data.revision, requestId: 'x' })).status).toBe(400);
    expect((await patch(s, 's1', { excluded: true, requestId: 'x' })).status).toBe(400);
    expect((await patch(s, 's1', { excluded: true, revision: data.revision })).status).toBe(400);
    expect((await request(app).patch(`/api/similarity/submissions/${s.mine._id}/sources/s1`).set(auth(s.other.token))
      .send({ excluded: true, revision: data.revision, requestId: 'x' })).status).toBe(404);
    await startCheck(s, s.teacher);
    const busy = await patch(s, 's1', { excluded: true, revision: data.revision + 1, requestId: 'y' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('SIMILARITY_IN_PROGRESS');
  });
});

describe('webhooks', () => {
  test('the provider webhook routes take a large JSON body (the export uploads) and answer 404 unless Copyleaks is fully configured', async () => {
    const big = { text: { value: 'x'.repeat(2 * 1024 * 1024) } };
    const res = await request(app).post('/api/similarity/webhooks/copyleaks/export/rb0123456789abcdef01234567/crawled').send(big);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(413);
  });
});
