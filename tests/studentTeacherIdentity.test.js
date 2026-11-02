'use strict';
// Student-facing responses never carry a teacher's email or id, only a display name. The scan reads every GET route from the route files, so a
// new route is covered without being listed here. Teacher-facing endpoints are unchanged. Synthetic data only.
process.env.JWT_SECRET = 'student-identity-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/student-identity';
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
// The legacy route asks LanguageTool for its own academic evaluation; no network in tests.
jest.mock('../src/services/ocrCorrections.service', () => ({ ...jest.requireActual('../src/services/ocrCorrections.service'), buildOcrCorrections: jest.fn(async () => ({ corrections: [] })) }));
jest.mock('../src/services/notificationRealtime.service', () => { const actual = jest.requireActual('../src/services/notificationRealtime.service'); return { ...actual, publishToUser: jest.fn(actual.publishToUser) }; });
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const LegacyFeedback = require('../src/models/Feedback');
const identity = require('../src/services/studentTeacherIdentity.service');
const notifications = require('../src/services/notification.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const src = path.join(__dirname, '..', 'src');
const TEACHER_EMAIL = 'teacher@example.com';
let f, studentJwt, teacherJwt;
const asStudent = url => request(app).get(url).set('Authorization', `Bearer ${studentJwt}`);

function routeTable() {
  const appText = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
  const vars = Object.fromEntries([...appText.matchAll(/const (\w+) = require\(['"]\.\/routes\/([\w.\-/]+)['"]\)/g)].map(m => [m[1], m[2]]));
  const out = [];
  for (const m of appText.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"],\s*(?:require\(['"]\.\/routes\/([\w.\-/]+)['"]\)|(\w+))\s*\)/g)) {
    const file = m[2] || vars[m[3]];
    const full = file && path.join(src, 'routes', file.endsWith('.js') ? file : `${file}.js`);
    if (!full || !fs.existsSync(full)) continue;
    for (const r of fs.readFileSync(full, 'utf8').matchAll(/router\.get\(\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"])/g)) {
      for (const p of r[1] ? [...r[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : [r[2]]) out.push(m[1] + (p === '/' ? '' : p));
    }
  }
  return [...new Set(out)];
}
const NOT_JSON = /\/pdf|media|download|stream|\/sse|events|export|\/uploads|\/files|docs|swagger/i;
const fill = (route, anyId) => route.replace(/:(\w+)/g, (_, name) => {
  const n = name.toLowerCase();
  if (n.includes('submission')) return String(f.IDS.registered);
  if (n.includes('assignment')) return String(f.IDS.assignment);
  if (n.includes('class')) return String(f.IDS.class);
  if (n.includes('student') || n.includes('user')) return String(f.student._id);
  if (n.includes('qr') || n.includes('token')) return 'fixture-qr';
  return anyId;
});
/** Paths in a JSON value whose string value contains the teacher's id or email. */
function hits(value, at = '$', out = []) {
  if (typeof value === 'string') { if (value.includes(String(f.IDS.teacher)) || value.includes(TEACHER_EMAIL)) out.push(at); }
  else if (Array.isArray(value)) value.forEach((v, i) => hits(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) hits(v, `${at}.${k}`, out);
  return out;
}

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  f = await seedAnnotationFixture({ uploadRoot });
  studentJwt = signTestJwt({ id: f.student._id, role: 'student', firebaseUid: f.student.firebaseUid });
  teacherJwt = signTestJwt({ id: f.teacher._id, role: 'teacher', firebaseUid: f.teacher.firebaseUid });
  await LegacyFeedback.collection.insertOne({ submission: f.IDS.registered, student: f.IDS.student, teacher: f.IDS.teacher, class: f.IDS.class,
    assignment: f.IDS.assignment, teacherComments: 'Legacy note.', overriddenBy: f.IDS.teacher, createdAt: new Date(), updatedAt: new Date() });
  await notifications.createNotification({ recipientId: f.student._id, actorId: f.teacher._id, type: 'assignment_uploaded', title: 'New assignment', description: 'Fixture' });
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

describe('every GET route, as the student and as the guest', () => {
  test('no teacher id or email in any response', async () => {
    const found = [], scanned = new Set();
    for (const route of routeTable()) {
      if (NOT_JSON.test(route)) continue;
      for (const url of new Set([f.IDS.class, f.IDS.assignment, f.IDS.registered].map(id => fill(route, String(id))))) {
        const calls = [['student', () => asStudent(url)]];
        if (route.includes('/guest/')) calls.push(['guest', () => request(app).get(url.replace(String(f.IDS.registered), String(f.IDS.guest))).set('X-Guest-Token', f.guestToken)]);
        for (const [who, call] of calls) {
          const res = await call();
          if (res.status !== 200) continue;
          scanned.add(`${who} ${route}`);
          for (const at of hits(res.body)) found.push(`${who} GET ${route} ${at.replace(/\[\d+\]/g, '[]')}`);
        }
      }
    }
    expect([...new Set(found)]).toEqual([]);
    // Positive control: the routes that used to carry the identity did answer.
    for (const route of ['/api/classes/:classId/summary', '/api/memberships/mine', '/api/assignments/my', '/api/assignments/:id', '/api/assignments/qr/:qrToken',
      '/api/submissions/my', '/api/submissions/assignment/:assignmentId/my', '/api/feedback/submission/:submissionId', '/api/notifications']) expect([...scanned]).toContain(`student ${route}`);
    expect(scanned.size).toBeGreaterThanOrEqual(30);
  });
});

describe('the display name replaces it', () => {
  test.each([
    ['submission', async () => (await asStudent(`/api/submissions/assignment/${f.IDS.assignment}/my`)).body.data, d => [d.assignment, d.class]],
    ['submission list', async () => (await asStudent('/api/submissions/my')).body.data, d => [d[0].assignment, d[0].class]],
    ['assignment', async () => (await asStudent(`/api/assignments/${f.IDS.assignment}`)).body.data, d => [d, d.class]],
    ['assignment list', async () => (await asStudent('/api/assignments/my')).body.data, d => [d[0], d[0].class]],
    ['assignment by QR', async () => (await asStudent('/api/assignments/qr/fixture-qr')).body.data, d => [d, d.class]],
    ['membership', async () => (await asStudent('/api/memberships/mine')).body.data, d => [d[0].class]],
    ['class summary', async () => (await asStudent(`/api/classes/${f.IDS.class}/summary`)).body.data, d => [d]],
    ['legacy feedback', async () => (await asStudent(`/api/feedback/submission/${f.IDS.registered}`)).body.data, d => [d, d.assignment, d.class]],
  ])('%s', async (_name, load, objects) => {
    for (const object of objects(await load())) {
      expect(object.teacherDisplayName).toBe('Teacher');
      expect(object).not.toHaveProperty('teacher');
    }
  });
  test('legacy feedback: no one who overrode it, either', async () => {
    const { data } = (await asStudent(`/api/feedback/submission/${f.IDS.registered}`)).body;
    expect(data).not.toHaveProperty('overriddenBy');
    expect(data.teacherComments).toBe('Legacy note.');
  });
  test('falls back when the display name is empty or is an email', async () => {
    for (const displayName of ['', 'teacher@example.com', '   ']) {
      await User.collection.updateOne({ _id: f.teacher._id }, { $set: { displayName } });
      const { data } = (await asStudent(`/api/submissions/assignment/${f.IDS.assignment}/my`)).body;
      expect({ displayName, name: data.assignment.teacherDisplayName, cls: data.class.teacherDisplayName }).toEqual({ displayName, name: 'Your teacher', cls: 'Your teacher' });
    }
    await User.collection.updateOne({ _id: f.teacher._id }, { $set: { displayName: 'Teacher' } });
  });
  test('joining a class: no identity in the response', async () => {
    await Membership.deleteMany({ student: f.student._id });
    const res = await request(app).post('/api/memberships/join').set('Authorization', `Bearer ${studentJwt}`).send({ joinCode: 'FIXTURE-1' });
    expect(res.status).toBe(200);
    expect(hits(res.body)).toEqual([]);
    expect(res.body.data.class.teacherDisplayName).toBe('Teacher');
  });
  test('notifications: the sender is a name only, for students', async () => {
    const { data } = (await asStudent('/api/notifications')).body;
    expect(data[0].actor).toEqual({ displayName: 'Teacher' });
    const read = await request(app).patch(`/api/notifications/${data[0]._id}/read`).set('Authorization', `Bearer ${studentJwt}`);
    expect(read.status).toBe(200);
    expect(read.body.data.actor).toEqual({ displayName: 'Teacher' });
  });
  test('the live notification push is reduced as well', async () => {
    const { publishToUser } = require('../src/services/notificationRealtime.service');
    publishToUser.mockClear();
    await notifications.createNotification({ recipientId: f.student._id, actorId: f.teacher._id, type: 'assignment_uploaded', title: 'Another', description: 'Fixture' });
    expect(publishToUser).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(JSON.stringify(publishToUser.mock.calls[0][0].payload));
    expect(payload.title).toBe('Another');
    expect(hits(payload)).toEqual([]);
  });
});

describe('helper', () => {
  test('a bare id, null and a plain value pass through', () => {
    expect(identity.assignmentForStudent('abc')).toBe('abc');
    expect(identity.assignmentForStudent(null)).toBeNull();
    expect(identity.teacherDisplayName(undefined)).toBe('Your teacher');
    expect(identity.teacherDisplayName({ displayName: ' Ms Rahman ' })).toBe('Ms Rahman');
    expect(identity.teacherDisplayName({ displayName: 'a@b.c' })).toBe('Your teacher');
  });
  test('removes the internal fields from a submission', () => {
    const out = identity.submissionForStudent({ _id: '1', evaluationProvider: 'p', evaluationModel: 'm', evaluationAttempts: [], analysisInputHash: 'h', evaluationPolicy: {}, evaluationStatus: 'completed' });
    expect(out).toEqual({ _id: '1', evaluationStatus: 'completed' });
  });
});

describe('teachers are unchanged', () => {
  const asTeacher = url => request(app).get(url).set('Authorization', `Bearer ${teacherJwt}`);
  test('class summary, assignment and submission list keep the teacher object', async () => {
    const summary = (await asTeacher(`/api/classes/${f.IDS.class}/summary`)).body.data;
    expect(summary.teacher).toEqual(expect.objectContaining({ id: String(f.IDS.teacher), email: TEACHER_EMAIL }));
    expect(summary).not.toHaveProperty('teacherDisplayName');
    const assignment = (await asTeacher(`/api/assignments/teacher/${f.IDS.assignment}`));
    expect(assignment.status).toBe(200);
    expect(assignment.body.data.teacher).toEqual(expect.objectContaining({ email: TEACHER_EMAIL }));
    const list = (await asTeacher(`/api/submissions/assignment/${f.IDS.assignment}`)).body.data;
    expect(list[0].assignment.teacher).toEqual(expect.objectContaining({ email: TEACHER_EMAIL }));
  });
  test('the feedback endpoint keeps the internal fields for the teacher, and not for the student', async () => {
    await require('../src/models/SubmissionFeedback').collection.updateOne({ submissionId: f.IDS.registered }, { $set: { evaluationProvider: 'prov', evaluationModel: 'mod', evaluationAttempts: [{ code: 'x' }], evaluationPolicy: { strictness: 'balanced' } } });
    const teacher = (await asTeacher(`/api/feedback/${f.IDS.registered}`)).body.data;
    expect(teacher).toEqual(expect.objectContaining({ evaluationProvider: 'prov', evaluationModel: 'mod', evaluationPolicy: { strictness: 'balanced' }, analysisInputHash: expect.any(String) }));
    const student = (await asStudent(`/api/feedback/${f.IDS.registered}`)).body.data;
    for (const key of identity.INTERNAL_FIELDS) expect({ key, present: key in student }).toEqual({ key, present: false });
  });
});
