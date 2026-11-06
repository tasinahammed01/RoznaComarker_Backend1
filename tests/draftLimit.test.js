'use strict';
// Draft limit (DRAFT_LIMIT_ENABLED): maximum drafts per assignment, set by the owning teacher, enforced for registered students (the shared
// draft writer and its pre-check) and guests (revision preflight and revise). Flag off = no limit, field ignored. Synthetic data only.
process.env.JWT_SECRET = 'draft-limit-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/draft-limit';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
jest.mock('../src/services/ocrPipeline.service', () => ({
  runOcrAndPersist: jest.fn().mockResolvedValue(undefined),
  runOcrAndPersistForFiles: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn().mockResolvedValue(undefined) }));
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
beforeAll(connectInMemoryMongo);
afterAll(async () => { delete process.env.DRAFT_LIMIT_ENABLED; await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

describe('registered students and the teacher setting', () => {
  let teacher, student, classDoc, teacherToken, studentToken;
  beforeEach(async () => {
    process.env.DRAFT_LIMIT_ENABLED = 'true';
    await clearDatabase(); await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'dl-teacher', email: 'dl-teacher@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'dl-student', email: 'dl-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Draft limit class', teacher: teacher._id, joinCode: 'DLIMIT', qrCodeUrl: 'data:,' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
  });
  const createAssignment = (overrides = {}) => Assignment.create({ title: 'Essay', writingType: 'essay', deadline: new Date(Date.now() + 86400000),
    class: classDoc._id, teacher: teacher._id, qrToken: `dl-${Math.random()}`, allowResubmission: true, ...overrides });
  // The route refuses a new draft while the previous one is still being processed; OCR is mocked here, so each draft is marked processed.
  const processed = () => Submission.updateMany({}, { $set: { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'completed', assessmentStatus: 'completed' } });
  const upload = async (assignmentId, name = 'draft.pdf') => {
    const res = await request(app).post(`/api/submissions/${assignmentId}`).set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from(`%PDF-1.4\n%${name}\n`), { filename: name, contentType: 'application/pdf' });
    await processed();
    return res;
  };
  const patch = (id, body, token = teacherToken) => request(app).patch(`/api/assignments/${id}`).set('Authorization', `Bearer ${token}`).send(body);
  const draftOf = async assignment => (await Submission.findOne({ student: student._id, assignment: assignment._id }).lean())?.draftNumber;

  test('limit 2: draft 1 and 2 go through, draft 3 is refused with the neutral code; another assignment is unaffected', async () => {
    const a = await createAssignment({ maxDrafts: 2 }), b = await createAssignment({ maxDrafts: 2 });
    expect((await upload(a._id, 'one.pdf')).status).toBe(200);
    expect((await upload(a._id, 'two.pdf')).status).toBe(200);
    const third = await upload(a._id, 'three.pdf');
    expect({ status: third.status, code: third.body.code, message: third.body.message }).toEqual({ status: 403, code: 'DRAFT_LIMIT_REACHED', message: 'Maximum number of drafts reached.' });
    expect(await draftOf(a)).toBe(2);
    expect((await upload(b._id, 'b-one.pdf')).status).toBe(200);
    expect(await draftOf(b)).toBe(1);
  });
  test('no stored limit: the default (3) applies when the flag is on', async () => {
    const a = await createAssignment();
    for (const name of ['1.pdf', '2.pdf', '3.pdf']) expect((await upload(a._id, name)).status).toBe(200);
    expect((await upload(a._id, '4.pdf')).body.code).toBe('DRAFT_LIMIT_REACHED');
  });
  test('two uploads at the same moment at the limit boundary: only one becomes the last draft', async () => {
    const a = await createAssignment({ maxDrafts: 2 });
    expect((await upload(a._id, 'one.pdf')).status).toBe(200);
    const [x, y] = await Promise.all([upload(a._id, 'x.pdf'), upload(a._id, 'y.pdf')]);
    const statuses = [x.status, y.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409, 429]).toContain(statuses[1]);
    expect(await draftOf(a)).toBe(2);
  });
  test('flag off: no limit, and the field is neither stored nor shown', async () => {
    process.env.DRAFT_LIMIT_ENABLED = 'false';
    const a = await createAssignment({ maxDrafts: 2 });
    for (const name of ['1.pdf', '2.pdf', '3.pdf', '4.pdf']) expect((await upload(a._id, name)).status).toBe(200);
    expect(await draftOf(a)).toBe(4);
    const b = await createAssignment();
    expect((await patch(b._id, { maxDrafts: 5 })).status).toBe(200);
    expect((await Assignment.findById(b._id).lean()).maxDrafts).toBeUndefined();
    const shown = await request(app).get(`/api/assignments/${a._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data).not.toHaveProperty('maxDrafts');
    const listed = (await request(app).get('/api/assignments/my').set('Authorization', `Bearer ${studentToken}`)).body.data;
    expect(listed.find(item => String(item._id) === String(a._id))).not.toHaveProperty('maxDrafts');
  });
  test('teacher setting: validated 2..10, cleared when another draft is not allowed; students cannot set it; students see the effective value', async () => {
    const a = await createAssignment();
    expect((await patch(a._id, { maxDrafts: 5 })).status).toBe(200);
    expect((await Assignment.findById(a._id).lean()).maxDrafts).toBe(5);
    for (const bad of [1, 11, 2.5, 'x']) expect((await patch(a._id, { maxDrafts: bad })).status).toBe(400);
    expect((await Assignment.findById(a._id).lean()).maxDrafts).toBe(5);
    expect((await patch(a._id, { maxDrafts: 4 }, studentToken)).status).toBe(403);
    const shown = (await request(app).get(`/api/assignments/${a._id}`).set('Authorization', `Bearer ${studentToken}`)).body.data;
    expect(shown.maxDrafts).toBe(5);
    const listed = (await request(app).get('/api/assignments/my').set('Authorization', `Bearer ${studentToken}`)).body.data;
    expect(listed.find(item => String(item._id) === String(a._id)).maxDrafts).toBe(5);
    expect((await patch(a._id, { allowResubmission: false })).status).toBe(200);
    expect((await Assignment.findById(a._id).lean()).maxDrafts).toBeUndefined();
    const config = await request(app).get('/api/assignments/draft-limit/config').set('Authorization', `Bearer ${teacherToken}`);
    expect(config.body.data).toEqual({ enabled: true, min: 2, max: 10, default: 3 });
    expect((await request(app).get('/api/assignments/draft-limit/config').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });
});

describe('guests', () => {
  let fixture;
  beforeEach(async () => {
    process.env.DRAFT_LIMIT_ENABLED = 'true';
    await clearDatabase(); await seedTestPlans();
    fixture = await seedAnnotationFixture({ uploadRoot });
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { allowResubmission: true, allowGuestSubmission: true, maxDrafts: 2 } });
  });
  // Multipart like the real client (a body-less request hits an unrelated, pre-existing crash in bindRevisionIdentity).
  const revise = (id = fixture.IDS.guest, token = fixture.guestToken) => request(app).post(`/api/guest/submissions/${id}/revise`)
    .set('X-Guest-Token', token).set('Idempotency-Key', 'k'.repeat(40)).field('note', 'no file');
  const preflight = () => request(app).post(`/api/guest/submissions/${fixture.IDS.guest}/image-preflight`).set('X-Guest-Token', fixture.guestToken);

  test('below the limit the revision passes the limit check (fails later only for the missing file); at the limit preflight and revise are refused', async () => {
    const below = await revise();
    expect(below.body.code).not.toBe('DRAFT_LIMIT_REACHED');
    expect(below.status).toBe(400);
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: { draftNumber: 2 }, $unset: { guestRevisionLease: 1 } });
    const blocked = await revise();
    expect({ status: blocked.status, code: blocked.body.code }).toEqual({ status: 403, code: 'DRAFT_LIMIT_REACHED' });
    expect((await preflight()).body.code).toBe('DRAFT_LIMIT_REACHED');
    expect((await Submission.findById(fixture.IDS.guest).lean()).draftNumber).toBe(2);
  });
  test('the guest presentation tells the effective limit and nothing internal', async () => {
    const res = await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/presentation`).set('X-Guest-Token', fixture.guestToken);
    expect(res.status).toBe(200);
    expect(res.body.data.assignment.maxDrafts).toBe(2);
    expect(res.body.data.submission.draftNumber).toBe(1);
    for (const term of ['teacher@example.com', 'guestRevisionLease', 'teacherId']) expect(JSON.stringify(res.body)).not.toContain(term);
  });
  test('a guest token for one submission cannot act on another', async () => {
    const res = await revise(fixture.IDS.registered);
    expect([401, 403, 404, 410]).toContain(res.status);
    expect((await Submission.findById(fixture.IDS.registered).lean()).draftNumber).toBe(1);
  });
  test('flag off: the guest presentation has no limit field and the limit check does not run', async () => {
    process.env.DRAFT_LIMIT_ENABLED = 'false';
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: { draftNumber: 5 } });
    expect((await revise()).body.code).not.toBe('DRAFT_LIMIT_REACHED');
    const res = await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/presentation`).set('X-Guest-Token', fixture.guestToken);
    expect(res.body.data.assignment).not.toHaveProperty('maxDrafts');
  });
});
