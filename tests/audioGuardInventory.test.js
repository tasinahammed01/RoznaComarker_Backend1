'use strict';
// GUARD INVENTORY (audio + speech-to-text, stage 5). Every route that takes a submission id is read from app.js and the route files (not typed
// here), and must be either GUARDED (essay-only: refuses a speaking submission) or ALLOWED with its reason. A new route fails this test until
// someone decides. Each guarded route is then called by every caller that could otherwise use it (the owning teacher, the owning student, the
// guest's own link) with a sourceKind 'audio' submission, and must answer the 404 body with no side effect: no document, count or file changes.
process.env.JWT_SECRET = 'audio-guard-inventory-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/audio-guard-${process.pid}`;
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.IMPROVED_WRITING_MODEL_ENABLED = 'true';
process.env.TEACHER_EVALUATION_EDIT_ENABLED = 'true';
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'UPLOAD_USER_RATE_LIMIT_MAX',
  'ANNOTATION_RATE_LIMIT_MAX', 'TEACHER_EVALUATION_RATE_LIMIT_MAX', 'WRITING_MODEL_RATE_LIMIT_MAX', 'WRITING_MODEL_AI_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const access = require('../src/services/guestAccess.service');
const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const guard = require('../src/middlewares/essayOnly.middleware');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };

const GUARDED = [
  'POST /api/assignments/:assignmentId/teacher-uploads/:submissionId/send',
  'POST /api/assignments/:assignmentId/teacher-uploads/:submissionId/retry',
  'GET /api/submissions/:submissionId/draft-comparison',
  'GET /api/submissions/:submissionId/teacher-annotations',
  'GET /api/submissions/:submissionId/teacher-annotations/history',
  'GET /api/submissions/:submissionId/teacher-annotations/preview',
  'POST /api/submissions/:submissionId/teacher-annotations',
  'POST /api/submissions/:submissionId/teacher-annotations/bulk',
  'POST /api/submissions/:submissionId/teacher-annotations/score-review',
  'GET /api/submissions/:submissionId/writing-model',
  'GET /api/submissions/:submissionId/writing-model/teacher',
  'PUT /api/submissions/:submissionId/writing-model/teacher',
  'POST /api/submissions/:submissionId/writing-model/teacher/generate-draft',
  'GET /api/submissions/:submissionId/teacher-evaluation',
  'POST /api/submissions/:submissionId/teacher-evaluation',
  'GET /api/submissions/:submissionId/ocr-corrections',
  'POST /api/submissions/:submissionId/ocr-corrections',
  'POST /api/submissions/:submissionId/ocr-corrections/regenerate',
  'POST /api/submissions/:submissionId/corrections/retry',
  'POST /api/submissions/:submissionId/evaluation/retry',
  'POST /api/submissions/:submissionId/source-review',
  'GET /api/submissions/:submissionId/source-review/:itemId/crop',
  'POST /api/submissions/:submissionId/source-review/:itemId/resolve',
  'GET /api/submissions/:submissionId/source-review/page/:pageIndex',
  'GET /api/submissions/:submissionId/source-review/page/:pageIndex/image',
  'POST /api/submissions/:submissionId/source-review/page/:pageIndex/resolve',
  'POST /api/guest/submissions/:submissionId/image-preflight',
  'GET /api/guest/submissions/:submissionId',
  'POST /api/guest/submissions/:submissionId/corrections/retry',
  'POST /api/guest/submissions/:submissionId/revise',
  'GET /api/guest/submissions/:submissionId/presentation',
  'GET /api/guest/submissions/:submissionId/feedback',
  'GET /api/guest/submissions/:submissionId/media/:fileId/:filename',
  'GET /api/guest/submissions/:submissionId/practice/:sessionId/attempts',
  'GET /api/guest/submissions/:submissionId/practice',
  'POST /api/guest/submissions/:submissionId/practice',
  'POST /api/guest/submissions/:submissionId/practice/:sessionId/:activityId',
  'GET /api/guest/submissions/:submissionId/drafts',
  'GET /api/guest/submissions/:submissionId/writing-model',
  'GET /api/guest/submissions/:submissionId/ocr-corrections',
  'GET /api/guest/submissions/:submissionId/pdf',
  'POST /api/feedback/:submissionId',
  'POST /api/feedback/ai/:submissionId',
  'GET /api/feedback/:submissionId',
  'POST /api/feedback/:submissionId/generate-ai',
  'POST /api/feedback/:submissionId/generate-rubric',
  'POST /api/feedback/:submissionId/generate-rubric-ai',
  'POST /api/feedback/:submissionId/generate-rubric-prompt',
  'POST /api/feedback/:submissionId/generate-rubric-context',
  'POST /api/feedback/:submissionId/rubric-file',
  'PUT /api/feedback/:submissionId',
  'PATCH /api/feedback/:submissionId/reviewed',
  'PATCH /api/feedback/:submissionId/teacher-comments',
  'POST /api/feedback/:submissionId/teacher-comments/ai-draft',
  'GET /api/feedback/submission/:submissionId',
  'GET /api/feedback/submission/teacher/:submissionId',
  'GET /api/feedback/student/:submissionId',
  'GET /api/pdf/download/:submissionId',
  'GET /api/adaptive-practice/teacher/submissions/:submissionId/progress',
  'GET /api/adaptive-practice/submissions/:submissionId',
  'POST /api/adaptive-practice/submissions/:submissionId/generate'
];

const ALLOWED = {
  'DELETE /api/submissions/:submissionId': 'removal supports speaking: it deletes the recording, its audio and releases its storage (speakingUpload.test.js)',
  'POST /api/submissions/:submissionId/guest-access/revoke': 'guest link management, not an essay feature; the controller refuses registered submissions and no guest speaking flow exists yet',
  'GET /api/submissions/:submissionId/guest-access/recovery-link': 'guest link management (as above)',
  'POST /api/submissions/:submissionId/guest-access/recovery-link': 'guest link management (as above)',
  'POST /api/guest/submissions/:submissionId/recover': 'answers the same public 202 for every id (no enumeration); a guard here would make speaking ids distinguishable',
  'GET /api/pdf/download-worksheet/:submissionId': 'takes a WorksheetSubmission id (another collection); a Submission id finds nothing there',
  'GET /api/pdf/student-worksheet-result/:submissionId': 'takes a WorksheetSubmission id (another collection)',
  'POST /api/speaking/submissions/:submissionId/retry-transcription': 'the speaking feature itself',
  'GET /api/speaking/submissions/:submissionId': 'the speaking feature itself (teacher view)',
  'GET /api/audio/submissions/:submissionId/media': 'the speaking feature itself (playback)',
  'GET /api/audio/submissions/:submissionId/download': 'the speaking feature itself (teacher download)'
};

/** Every route (all methods) of every router mounted in app.js whose path has :submissionId. Same reading as tests/helpers/studentRouteScan.js. */
function submissionRoutes() {
  const src = path.join(__dirname, '..', 'src');
  const appText = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
  const vars = Object.fromEntries([...appText.matchAll(/const (\w+) = require\(['"]\.\/routes\/([\w.\-/]+)['"]\)/g)].map(m => [m[1], m[2]]));
  const out = [];
  for (const mount of appText.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"],\s*(?:require\(['"]\.\/routes\/([\w.\-/]+)['"]\)|(\w+))\s*\)/g)) {
    const file = mount[2] || vars[mount[3]];
    const full = file && path.join(src, 'routes', file.endsWith('.js') ? file : `${file}.js`);
    if (!full || !fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\(\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"])/g)) {
      const paths = m[2] ? [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : [m[3]];
      for (const p of paths) out.push(`${m[1].toUpperCase()} ${mount[1]}${p === '/' ? '' : p}`);
    }
  }
  return [...new Set(out)].filter(route => route.includes(':submissionId')).sort();
}

let f, registered, guest, guestToken;

async function snapshot() {
  const db = mongoose.connection.db;
  const counts = {};
  for (const { name } of await db.listCollections().toArray()) counts[name] = await db.collection(name).countDocuments();
  const docs = {};
  for (const id of [registered.submission._id, guest.submission._id]) docs[`submission:${id}`] = await Submission.collection.findOne({ _id: id });
  for (const id of [registered.recording._id, guest.recording._id]) docs[`recording:${id}`] = await db.collection('audiorecordings').findOne({ _id: id });
  const listing = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
  return JSON.parse(JSON.stringify({ counts, docs, files: listing(uploadRoot) }));
}

function urlFor(route, submissionId) {
  return route.replace(/^\w+ /, '').replace(/:(\w+)/g, (_, name) => ({
    submissionId: String(submissionId), assignmentId: String(f.assignment._id), itemId: 'a'.repeat(64), pageIndex: '0',
    sessionId: String(new mongoose.Types.ObjectId()), activityId: 'activity-1', fileId: String(registered.file._id), filename: 'x.wav'
  }[name] ?? name));
}

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true } });
  registered = await makeAudioSubmission(f);
  guest = await makeAudioSubmission(f, { mode: 'guest' });
  const issued = access.issueToken();
  guestToken = issued.token;
  await Submission.collection.updateOne({ _id: guest.submission._id }, { $set: { 'guest.accessHash': issued.accessHash, 'guest.expiresAt': issued.expiresAt } });
});
afterAll(async () => { delete process.env.AUDIO_STT_ENABLED; await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

describe('the inventory', () => {
  test('every route that takes a submission id is GUARDED or ALLOWED (with its reason), and nothing listed is stale', () => {
    const routes = submissionRoutes();
    const listed = [...GUARDED, ...Object.keys(ALLOWED)].sort();
    expect({ unlisted: routes.filter(r => !listed.includes(r)), stale: listed.filter(r => !routes.includes(r)) }).toEqual({ unlisted: [], stale: [] });
    expect(GUARDED.filter(r => r in ALLOWED)).toEqual([]);
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(20);
  });

  test('the guest link really opens the guest audio submission (control: requireGuestAccess passes, so the guard is what refuses)', async () => {
    const reached = await access.authorize(String(guest.submission._id), guestToken);
    expect(String(reached._id)).toBe(String(guest.submission._id));
  });
});

describe('each guarded route refuses a speaking submission, with no side effects', () => {
  test.each(GUARDED)('%s', async (route) => {
    const method = route.split(' ')[0].toLowerCase();
    const isGuest = route.includes(' /api/guest/');
    const callers = isGuest
      ? [['guest link', { 'X-Guest-Token': guestToken }, guest.submission._id]]
      : [['owning teacher', { Authorization: `Bearer ${f.teacher.token}` }, registered.submission._id],
        ['owning student', { Authorization: `Bearer ${f.student.token}` }, registered.submission._id]];
    const before = await snapshot();
    const answers = [];
    for (const [who, headers, id] of callers) {
      const req = request(app)[method](urlFor(route, id)).set(headers);
      const res = method === 'get' ? await req : await req.send({});
      answers.push({ who, status: res.status, notFound: JSON.stringify(res.body) === JSON.stringify(NOT_FOUND) });
    }
    // Every caller is refused; a caller the route does not serve may be refused earlier by its role check (403), never let through.
    for (const answer of answers) expect([404, 403]).toContain(answer.status);
    for (const answer of answers.filter(a => a.status === 404)) expect(answer).toMatchObject({ notFound: true });
    expect(answers.some(a => a.notFound)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});

describe('the guard itself', () => {
  const run = (middleware, params) => new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ refused: this.code, body }); } };
    middleware({ params }, res, error => resolve({ next: true, error }));
  });

  test('an essay submission passes through; a speaking one is refused; a malformed id is left to the route', async () => {
    const essay = await Submission.create({ student: f.otherStudent.user._id, assignment: f.essay._id, class: f.klass._id, status: 'submitted', submittedAt: new Date(), isLate: false });
    expect(await run(guard.refuseAudioSubmission, { submissionId: String(essay._id) })).toEqual({ next: true, error: undefined });
    expect(await run(guard.refuseAudioSubmission, { submissionId: String(registered.submission._id) })).toEqual({ refused: 404, body: NOT_FOUND });
    expect(await run(guard.refuseAudioSubmission, { submissionId: 'not-an-id' })).toEqual({ next: true, error: undefined });
    expect(await run(guard.refuseAudioSubmission, { submissionId: String(new mongoose.Types.ObjectId()) })).toEqual({ next: true, error: undefined });
  });

  test('refuseSpeakingAssignment: essay passes, speaking refused', async () => {
    const middleware = guard.refuseSpeakingAssignment('id');
    expect(await run(middleware, { id: String(f.essay._id) })).toEqual({ next: true, error: undefined });
    expect(await run(middleware, { id: String(f.assignment._id) })).toEqual({ refused: 404, body: NOT_FOUND });
  });

  test('the same 404 body for a speaking id and for an id that does not exist (nothing to tell apart) on a teacher route', async () => {
    const auth = { Authorization: `Bearer ${f.otherTeacher.token}` };
    const speaking = await request(app).post(`/api/submissions/${registered.submission._id}/evaluation/retry`).set(auth);
    expect(speaking.status).toBe(404);
    expect(speaking.body).toEqual(NOT_FOUND);
  });

  test('a database error goes to the error handler (not let through)', async () => {
    const spy = jest.spyOn(Submission, 'exists').mockRejectedValueOnce(new Error('db down'));
    const result = await run(guard.refuseAudioSubmission, { submissionId: String(registered.submission._id) });
    expect(result.next).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    spy.mockRestore();
  });
});
