'use strict';
// Phase A: bulk hide / restore of teacher annotations. Owner only (404 for everyone else), ids must belong to the submission, 500 cap,
// idempotent by request id, one audit row per change, scores never recomputed (only the grade-check flag). Synthetic text only.
process.env.JWT_SECRET = 'annotation-bulk-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-bulk';
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture, teacher;
beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => {
  await mongoose.connection.dropDatabase(); await seedTestPlans();
  await AnnotationAudit.createIndexes();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const bulkUrl = id => `/api/submissions/${id}/teacher-annotations/bulk`;
const bulkAs = (user, id, body) => request(app).post(bulkUrl(id)).set('Authorization', `Bearer ${require('./helpers/auth').signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid })}`).send(body);
async function current(id) { const s = (await teacher.snapshot(id)).body.data; return { revision: s.revision, sourceHash: s.sourceHash, rows: s.corrections, scores: s.scoreReview.scores, flag: s.scoringReviewRequired }; }
async function bulk(id, body, user = fixture.teacher) {
  const { revision, sourceHash } = await current(id);
  return bulkAs(user, id, { revision, sourceHash, requestId: crypto.randomUUID(), ...body });
}
const statusOf = (rows, id) => rows.find(r => r.id === id)?.moderationStatus;
const overlayOf = async id => (await Submission.findById(id).select('+teacherAnnotations').lean()).teacherAnnotations ?? null;
const feedbackOf = async id => { const f = await SubmissionFeedback.findOne({ submissionId: id }).lean(); delete f.updatedAt; return JSON.parse(JSON.stringify(f)); };

describe('who may call it', () => {
  test('other teacher and student: 404, nothing changes', async () => {
    const id = fixture.IDS.registered, { rows } = await current(id), ids = rows.slice(0, 2).map(r => r.id);
    for (const user of [fixture.otherTeacher, fixture.student]) {
      for (const sub of [fixture.IDS.registered, fixture.IDS.guest]) {
        const res = await bulk(sub, { action: 'hide', ids }, user);
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'ANNOTATION_NOT_FOUND' });
      }
    }
    expect(await overlayOf(id)).toBeNull();
    expect(await AnnotationAudit.countDocuments()).toBe(0);
  });
  test('a guest token (no account) is refused before the controller (401), nothing changes', async () => {
    const res = await request(app).post(bulkUrl(fixture.IDS.guest)).set('X-Guest-Token', fixture.guestToken).send({ action: 'restore', all: true, revision: 0, sourceHash: 'x', requestId: crypto.randomUUID() });
    expect(res.status).toBe(401);
    expect(await overlayOf(fixture.IDS.guest)).toBeNull();
  });
  test('a closed class is read-only', async () => {
    await require('../src/models/class.model').updateOne({ _id: fixture.IDS.class }, { $set: { status: 'archived' } });
    const res = await bulk(fixture.IDS.registered, { action: 'restore', all: true });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ANNOTATION_CLASS_CLOSED' });
  });
});

describe('validation', () => {
  test('an id from another submission rejects the whole request, nothing is written', async () => {
    const added = await teacher.act(fixture.IDS.guest, { action: 'add', value: manualValue(fixture.guest, 'park') });
    expect(added.status).toBe(200);
    const foreign = (await current(fixture.IDS.guest)).rows.find(r => String(r.id).startsWith('teacher_')).id;
    const { rows } = await current(fixture.IDS.registered);
    const res = await bulk(fixture.IDS.registered, { action: 'hide', ids: [rows[0].id, foreign] });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: 'ANNOTATION_UNKNOWN_IDS' });
    expect(await overlayOf(fixture.IDS.registered)).toBeNull();
  });
  test('cap: 501 ids are refused; malformed bodies are refused', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `ai_${i}`);
    expect((await bulk(fixture.IDS.registered, { action: 'hide', ids })).body.code).toBe('ANNOTATION_BULK_TOO_MANY');
    for (const body of [{ action: 'archive', ids: ['a'] }, { action: 'hide', all: true }, { action: 'hide' }, { action: 'hide', ids: [] },
      { action: 'hide', ids: ['a', 'a'] }, { action: 'hide', ids: ['a'], category: 'GRAMMAR' }, { action: 'hide', ids: ['a'], extra: 1 }]) {
      expect((await bulk(fixture.IDS.registered, body)).status).toBe(400);
    }
    expect((await bulk(fixture.IDS.registered, { action: 'hide', category: 'SPELLING' })).body.code).toBe('ANNOTATION_INVALID_CATEGORY');
    expect(await overlayOf(fixture.IDS.registered)).toBeNull();
  });
  test('a stale revision is a conflict', async () => {
    const { rows, sourceHash } = await current(fixture.IDS.registered);
    const res = await bulkAs(fixture.teacher, fixture.IDS.registered, { action: 'hide', ids: [rows[0].id], revision: 7, sourceHash, requestId: crypto.randomUUID() });
    expect(res.body.code).toBe('ANNOTATION_REVISION_CONFLICT');
  });
});

describe('hide and restore', () => {
  test('hide by ids: one audit row per change, flag set, scores identical; restore all returns the original visible set', async () => {
    const id = fixture.IDS.registered, before = await current(id), feedbackBefore = await feedbackOf(id);
    const ids = before.rows.slice(0, 3).map(r => r.id);
    const hidden = await bulk(id, { action: 'hide', ids });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.changedIds).toEqual(ids);
    const mid = await current(id);
    for (const c of ids) expect(statusOf(mid.rows, c)).toBe('hidden');
    expect(mid.flag).toBe(true);
    expect(mid.scores).toEqual(before.scores);
    expect(await feedbackOf(id)).toEqual(feedbackBefore);
    expect(await AnnotationAudit.countDocuments({ submissionId: id, action: 'hide' })).toBe(3);

    const restored = await bulk(id, { action: 'restore', all: true });
    expect(restored.body.data.changedIds.sort()).toEqual([...ids].sort());
    const after = await current(id);
    expect(after.rows.map(r => [r.id, r.moderationStatus])).toEqual(before.rows.map(r => [r.id, r.moderationStatus]));
    expect(after.scores).toEqual(before.scores);
    expect(await feedbackOf(id)).toEqual(feedbackBefore);
    expect(await AnnotationAudit.countDocuments({ submissionId: id, action: 'restore' })).toBe(3);
  });
  test('hide by category touches only that category; restore all leaves removed items removed', async () => {
    const id = fixture.IDS.registered, { rows } = await current(id);
    const grammar = rows.filter(r => r.category === 'GRAMMAR').map(r => r.id), other = rows.filter(r => r.category !== 'GRAMMAR');
    expect(grammar.length).toBeGreaterThan(0); expect(other.length).toBeGreaterThan(0);
    expect((await teacher.act(id, { action: 'archive', id: other[0].id })).status).toBe(200);
    const res = await bulk(id, { action: 'hide', category: 'GRAMMAR' });
    expect(res.body.data.changedIds.sort()).toEqual([...grammar].sort());
    let now = (await current(id)).rows;
    for (const r of other.slice(1)) expect(statusOf(now, r.id)).toBe('visible');
    await bulk(id, { action: 'restore', all: true });
    now = (await current(id)).rows;
    for (const g of grammar) expect(statusOf(now, g)).toBe('visible');
    expect(statusOf(now, other[0].id)).toBe('archived');
  });
  test('idempotent: the same request id replays its first result; a new request changes nothing; a reused id with another body is a conflict', async () => {
    const id = fixture.IDS.registered, s = await current(id), ids = s.rows.slice(0, 2).map(r => r.id);
    const body = { action: 'hide', ids, revision: s.revision, sourceHash: s.sourceHash, requestId: crypto.randomUUID() };
    const first = await bulkAs(fixture.teacher, id, body);
    const again = await bulkAs(fixture.teacher, id, body);
    expect(again.body.data).toEqual({ replay: true, revision: first.body.data.revision, changedIds: ids });
    expect(await AnnotationAudit.countDocuments({ submissionId: id })).toBe(2);
    const repeat = await bulk(id, { action: 'hide', ids });
    expect(repeat.body.data.changedIds).toEqual([]);
    expect((await current(id)).revision).toBe(first.body.data.revision);
    const reused = await bulkAs(fixture.teacher, id, { ...body, ids: [ids[0]] });
    expect(reused.body.code).toBe('ANNOTATION_IDEMPOTENCY_CONFLICT');
  });
  test('students and guests: hidden items leave every student surface, restored ones come back', async () => {
    const id = fixture.IDS.guest, { rows } = await current(id), target = rows[0];
    const reads = surfaces({ app, ids: fixture.IDS, guestToken: fixture.guestToken,
      studentJwt: require('./helpers/auth').signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid }) });
    const guestIds = async () => { const out = await capture(reads); expect(out['guest: ocr-corrections'].status).toBe(200);
      return { ids: out['guest: ocr-corrections'].body.data.corrections.map(c => c.id).sort(), all: JSON.stringify(Object.entries(out).filter(([k]) => k.startsWith('guest'))) }; };
    const before = await guestIds();
    expect(before.ids).toContain(target.id);
    await bulk(id, { action: 'hide', ids: [target.id] });
    const mid = await guestIds();
    expect(mid.ids).not.toContain(target.id);
    expect(mid.all).not.toContain(target.id);
    await bulk(id, { action: 'restore', all: true });
    expect((await guestIds()).ids).toEqual(before.ids);
  });
});
