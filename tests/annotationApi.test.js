'use strict';
// Task 6A: teacher annotation API - authorization (404 for everyone but the owning teacher), closed/revoked rules, concurrency,
// idempotency, audit history without a cap, and the preview that must equal the student payload. Synthetic text only.
process.env.JWT_SECRET = 'annotation-api-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-api';
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
// The 300-write audit test exceeds the app-wide per-user limits (AUTH_WRITE 180 / AUTH_READ 600 per 15 minutes).
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture, teacher, admin;
beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => {
  await mongoose.connection.dropDatabase(); await seedTestPlans();
  await AnnotationAudit.createIndexes();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const correctionId = async (id, word, symbol) => (await teacher.find(id, word, symbol)).id;

describe('authorization: 404 for everyone but the owning teacher', () => {
  const callers = () => ({
    'other teacher': annotationApi(app, fixture.otherTeacher),
    student: annotationApi(app, fixture.student),
    admin: annotationApi(app, admin),
  });
  for (const who of ['other teacher', 'student', 'admin']) {
    test(`${who}: snapshot, history, preview and writes are 404`, async () => {
      admin = await require('../src/models/user.model').create({ firebaseUid: 'fixture-admin', email: 'admin@example.com', role: 'admin', displayName: 'Admin' });
      const api = callers()[who];
      for (const id of [fixture.IDS.registered, fixture.IDS.guest]) {
        expect((await api.snapshot(id)).status).toBe(404);
        expect((await api.history(id)).status).toBe(404);
        expect((await api.preview(id)).status).toBe(404);
        const res = await api.post(id, { action: 'hide', id: 'x', revision: 0, sourceHash: 'x', requestId: crypto.randomUUID() });
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'ANNOTATION_NOT_FOUND' });
      }
    });
  }
  test('a guest token and no token', async () => {
    const base = `/api/submissions/${fixture.IDS.guest}/teacher-annotations`;
    expect((await request(app).get(base).set('X-Guest-Token', fixture.guestToken)).status).toBe(401);
    expect((await request(app).get(base)).status).toBe(401);
  });
  test('an unknown or malformed submission id is 404, like a foreign one', async () => {
    expect((await teacher.snapshot(new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await teacher.snapshot('not-an-id')).status).toBe(404);
  });
  test('deleted class or assignment: 404; closed (archived) class: read-only', async () => {
    const Class = require('../src/models/class.model');
    await Class.updateOne({ _id: fixture.IDS.class }, { $set: { status: 'archived' } });
    expect((await teacher.snapshot(fixture.IDS.registered)).status).toBe(200);
    const id = await correctionId(fixture.IDS.registered, 'dont');
    const res = await teacher.act(fixture.IDS.registered, { action: 'hide', id });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ANNOTATION_CLASS_CLOSED' });
    await Class.updateOne({ _id: fixture.IDS.class }, { $set: { status: 'active', isActive: false } });
    expect((await teacher.snapshot(fixture.IDS.registered)).status).toBe(404);
  });
  test('a revoked guest link: the teacher may still edit; the old link reads nothing', async () => {
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: { 'guest.revokedAt': new Date() }, $unset: { 'guest.accessHash': 1 } });
    const id = await correctionId(fixture.IDS.guest, 'dont');
    expect((await teacher.act(fixture.IDS.guest, { action: 'hide', id })).status).toBe(200);
    const guestRead = await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/ocr-corrections`).set('X-Guest-Token', fixture.guestToken);
    expect(guestRead.status).not.toBe(200);
  });
  test('responses are private, no-store; errors carry only a code', async () => {
    const res = await teacher.snapshot(fixture.IDS.registered);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const bad = await annotationApi(app, fixture.otherTeacher).snapshot(fixture.IDS.registered);
    expect(bad.headers['cache-control']).toBe('private, no-store');
    expect(Object.keys(bad.body).sort()).toEqual(['code', 'message', 'success']);
  });
});

describe('concurrency and idempotency', () => {
  test('a stale revision is 409; two writes on one revision: exactly one wins', async () => {
    const snap = (await teacher.snapshot(fixture.IDS.registered)).body.data;
    const [a, b] = [await correctionId(fixture.IDS.registered, 'dont'), await correctionId(fixture.IDS.registered, 'realy')];
    const body = id => ({ action: 'hide', id, revision: snap.revision, sourceHash: snap.sourceHash, requestId: crypto.randomUUID() });
    const results = await Promise.all([teacher.post(fixture.IDS.registered, body(a)), teacher.post(fixture.IDS.registered, body(b))]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409).body.code).toBe('ANNOTATION_REVISION_CONFLICT');
    const stale = await teacher.post(fixture.IDS.registered, body(b));
    expect({ status: stale.status, code: stale.body.code }).toEqual({ status: 409, code: 'ANNOTATION_REVISION_CONFLICT' });
  });
  test('a replayed request returns its first result; a reused id with another body is refused', async () => {
    const snap = (await teacher.snapshot(fixture.IDS.registered)).body.data;
    const body = { action: 'hide', id: await correctionId(fixture.IDS.registered, 'dont'), revision: snap.revision, sourceHash: snap.sourceHash, requestId: crypto.randomUUID() };
    expect((await teacher.post(fixture.IDS.registered, body)).body.data).toEqual({ revision: 1 });
    expect((await teacher.post(fixture.IDS.registered, body)).body.data).toEqual({ revision: 1, replay: true });
    const conflict = await teacher.post(fixture.IDS.registered, { ...body, action: 'archive' });
    expect({ status: conflict.status, code: conflict.body.code }).toEqual({ status: 409, code: 'ANNOTATION_IDEMPOTENCY_CONFLICT' });
    expect(await AnnotationAudit.countDocuments({ submissionId: fixture.IDS.registered })).toBe(1);
  });
  test('writes are refused while the assessment is running', async () => {
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { evaluationStatus: 'processing' } });
    const res = await teacher.act(fixture.IDS.registered, { action: 'hide', id: await correctionId(fixture.IDS.registered, 'dont') });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ANNOTATION_ASSESSMENT_BUSY' });
  });
});

describe('audit history: separate collection, no cap', () => {
  test('300 changes are all kept and paged, newest first; old embedded history is migrated on read', async () => {
    const id = await correctionId(fixture.IDS.registered, 'dont');
    const started = Date.now();
    for (let i = 0; i < 300; i++) {
      const res = await teacher.act(fixture.IDS.registered, { action: i % 2 ? 'restore' : 'hide', id });
      if (res.status !== 200) throw new Error(`write ${i}: ${res.status} ${res.body.code}`);
    }
    const perWriteMs = (Date.now() - started) / 300;
    expect(await AnnotationAudit.countDocuments({ submissionId: fixture.IDS.registered })).toBe(300);
    const pages = []; let offset = 0;
    do { const res = await teacher.history(fixture.IDS.registered, `?offset=${offset}`); pages.push(...res.body.data.items); offset = res.body.data.nextOffset; } while (offset != null);
    expect(pages.map(r => r.newRevision)).toEqual(Array.from({ length: 300 }, (_, i) => 300 - i));
    expect(pages.some(r => 'requestHash' in r)).toBe(false);
    const stored = (await Submission.findById(fixture.IDS.registered).select('+teacherAnnotations').lean()).teacherAnnotations;
    expect(stored.recent).toHaveLength(20);
    expect(stored.audit).toBeUndefined();
    console.log(`[annotation perf] 300 sequential writes: ${perWriteMs.toFixed(1)} ms per write (snapshot + post)`);
  });
  test('a write whose audit insert failed is repaired from the overlay by the next history read', async () => {
    const id = await correctionId(fixture.IDS.registered, 'dont');
    const spy = jest.spyOn(AnnotationAudit, 'bulkWrite').mockRejectedValueOnce(new Error('down'));
    expect((await teacher.act(fixture.IDS.registered, { action: 'hide', id })).status).toBe(200);
    spy.mockRestore();
    expect(await AnnotationAudit.countDocuments({})).toBe(0);
    expect((await teacher.history(fixture.IDS.registered)).body.data.items.map(r => r.action)).toEqual(['hide']);
  });
});

describe('preview', () => {
  for (const mode of ['registered', 'guest']) {
    test(`${mode}: the preview equals what the student receives, hidden content included nowhere`, async () => {
      const id = fixture.IDS[mode];
      const hidden = await teacher.find(id, 'a', 'ART');
      expect((await teacher.act(id, { action: 'hide', id: hidden.id })).status).toBe(200);
      await teacher.act(id, { action: 'add', value: manualValue(mode === 'guest' ? fixture.guest : fixture.registered, 'park') });
      const preview = await teacher.preview(id);
      expect(preview.status).toBe(200);
      const out = await capture(surfaces({ app, ids: fixture.IDS, guestToken: fixture.guestToken,
        studentJwt: signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid }) }));
      expect(preview.body.data.ocrCorrections).toEqual(out[`${mode}: ocr-corrections`].body.data);
      expect(preview.body.data.feedback).toEqual(out[`${mode}: feedback`].body.data);
      expect(JSON.stringify(preview.body)).not.toContain(hidden.id);
      expect(preview.body.data.ocrCorrections.corrections.filter(c => c.source === 'Teacher')).toHaveLength(1);
    });
  }
});
