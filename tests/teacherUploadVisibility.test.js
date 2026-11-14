'use strict';
// FIX 2: work a teacher uploads with a typed name + email must appear in EVERY teacher list (the default list used by
// "View All Submission" / the submission page, the "cards" list used by the View Submissions dialog, the "activity" list used by
// the class page counters, and the teacher-uploads status list), whatever the account kind, assignment settings or status.
// Real routes; marking dispatch, credits and email are mocked. Synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-visibility-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-visibility-' + process.pid;
jest.setTimeout(120000);
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));

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
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const credits = require('../src/services/assessmentCreditRouter.service').canRunAssessment;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FYQAAAAASUVORK5CYII=', 'base64');
const page2 = Buffer.concat([png, Buffer.from('second page')]);
let teacher, member, outsider, classDoc, assignment, token;

function upload({ name, email, mode, files = [png], batchId = 'batch-0001' }) {
  let req = request(app).post(`/api/assignments/${assignment._id}/teacher-uploads`).set('Authorization', `Bearer ${token}`)
    .field('name', name).field('email', email).field('requestKey', crypto.randomUUID()).field('batchId', batchId);
  if (mode) req = req.field('mode', mode);
  files.forEach((bytes, i) => { req = req.attach('files', bytes, { filename: `page-${i + 1}.png`, contentType: 'image/png' }); });
  return req;
}
const get = url => request(app).get(url).set('Authorization', `Bearer ${token}`);
/** What every teacher list shows for one submission id. */
async function lists(submissionId) {
  const id = String(submissionId);
  const [full, cards, activity, uploads] = await Promise.all([
    get(`/api/submissions/assignment/${assignment._id}`), get(`/api/submissions/assignment/${assignment._id}?view=cards`),
    get(`/api/submissions/assignment/${assignment._id}?view=activity`), get(`/api/assignments/${assignment._id}/teacher-uploads`)]);
  for (const res of [full, cards, activity, uploads]) expect(res.status).toBe(200);
  const find = rows => (rows || []).find(row => String(row._id || row.submissionId) === id) || null;
  return { full: find(full.body.data), cards: find(cards.body.data), activity: find(activity.body.data), upload: find(uploads.body.data.items) };
}
function expectListedEverywhere(seen, label) {
  for (const where of ['full', 'cards', 'activity', 'upload']) expect({ label, where, listed: !!seen[where] }).toEqual({ label, where, listed: true });
}

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH), { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.OCR_SOURCE_MODE = 'legacy';
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  credits.mockResolvedValue({ allowed: true, availableCredits: 100 });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher', displayName: 'Ms Rahman' });
  member = await User.create({ firebaseUid: crypto.randomUUID(), email: 'member@example.com', role: 'student', displayName: 'Mia Member' });
  outsider = await User.create({ firebaseUid: crypto.randomUUID(), email: 'outsider@example.com', role: 'student', displayName: 'Oli Outside' });
  classDoc = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'VISIBILITY' });
  await Membership.create({ student: member._id, class: classDoc._id, status: 'active' });
  // (f) guest submissions OFF for this assignment (the default) and (g) the due date has passed.
  assignment = await Assignment.create({ title: 'My Summer Holiday', class: classDoc._id, teacher: teacher._id, instructions: 'Write about a holiday.',
    qrToken: 'visibility-qr', deadline: new Date(Date.now() - 86400000), allowGuestSubmission: false });
  token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
});

test('(a) new guest, (f) guest setting off, (g) past due: listed everywhere with the typed name and email', async () => {
  const res = await upload({ name: 'Sam Lee', email: 'Sam.Lee@Example.com' });
  expect(res.status).toBe(200);
  const seen = await lists(res.body.data.item.submissionId);
  expectListedEverywhere(seen, 'a');
  expect(seen.upload).toEqual(expect.objectContaining({ name: 'Sam Lee', email: 'sam.lee@example.com', account: 'guest' }));
  expect(seen.cards.guest).toEqual(expect.objectContaining({ displayName: 'Sam Lee', normalizedEmail: 'sam.lee@example.com' }));
});

test('(b) a class member\'s email: listed everywhere, as that member', async () => {
  const res = await upload({ name: 'Mia M.', email: 'MEMBER@example.com' });
  expect(res.status).toBe(200);
  const seen = await lists(res.body.data.item.submissionId);
  expectListedEverywhere(seen, 'b');
  expect(seen.upload).toEqual(expect.objectContaining({ account: 'member', email: 'member@example.com' }));
});

test('(c) an existing account that is not in the class, and a teacher account\'s email: guest work, listed everywhere', async () => {
  for (const [name, email] of [['Oli Outside', 'outsider@example.com'], ['Tara Teacher', 'teacher@example.com']]) {
    const res = await upload({ name, email });
    expect(res.status).toBe(200);
    const seen = await lists(res.body.data.item.submissionId);
    expectListedEverywhere(seen, `c ${email}`);
    expect(seen.upload).toEqual(expect.objectContaining({ name, email, account: 'guest' }));
  }
});

test('(d, e, k) CSV / class-list / batch uploads (the same route, several in a row): all listed', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const res = await upload({ name: `Batch Student ${i}`, email: `batch.${i}@example.com`, batchId: 'batch-0002' });
    expect(res.status).toBe(200); ids.push(res.body.data.item.submissionId);
  }
  for (const id of ids) expectListedEverywhere(await lists(id), `k ${id}`);
});

test('(h) every status is listed, with a status the teacher can read', async () => {
  const res = await upload({ name: 'Sam Lee', email: 'sam.lee@example.com' });
  const id = res.body.data.item.submissionId;
  const states = [
    [{ ocrStatus: 'pending', assessmentStatus: 'started' }, 'uploaded'],
    [{ ocrStatus: 'processing', assessmentStatus: 'processing', analysisLeaseOwner: 'w1' }, 'reading'],
    [{ ocrStatus: 'completed', correctionStatus: 'processing', assessmentStatus: 'processing' }, 'processing'],
    [{ ocrStatus: 'completed', evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS', assessmentStatus: 'started' }, 'waiting_credits'],
    [{ ocrStatus: 'completed', assessmentStatus: 'complete' }, 'marked'],
    [{ ocrStatus: 'completed', assessmentStatus: 'failed', assessmentErrorCode: 'AI_PROVIDER_TIMEOUT' }, 'failed'],
  ];
  for (const [patch, status] of states) {
    await Submission.updateOne({ _id: id }, { $set: patch });
    const seen = await lists(id);
    expectListedEverywhere(seen, `h ${status}`);
    expect(seen.upload.status).toBe(status);
  }
});

test('(i) replace and add pages keep one listed submission; (j) a second "new" upload of the same email is refused, not hidden', async () => {
  const first = await upload({ name: 'Sam Lee', email: 'sam.lee@example.com' });
  const id = first.body.data.item.submissionId;
  const again = await upload({ name: 'Sam Lee', email: 'sam.lee@example.com' });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('TEACHER_UPLOAD_EXISTS');
  for (const mode of ['add_pages', 'replace']) {
    const res = await upload({ name: 'Sam Lee', email: 'sam.lee@example.com', mode, files: [page2] });
    expect(res.status).toBe(200);
    expect(res.body.data.item.submissionId).toBe(id);
    expectListedEverywhere(await lists(id), `i ${mode}`);
  }
  const cards = (await get(`/api/submissions/assignment/${assignment._id}?view=cards`)).body.data;
  expect(cards.filter(row => String(row._id) === id).length).toBe(1);
});
