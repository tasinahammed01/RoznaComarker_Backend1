'use strict';
// Audio + speech-to-text, stage 5: the speaking assignment type. Capabilities (essay, worksheet and flashcard unchanged), create/update
// validation, the feature switch, and every essay-only feature refusing or hiding a speaking assignment. In-memory MongoDB, synthetic data.
process.env.JWT_SECRET = 'speaking-assignment-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-assignment-${process.pid}`;
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.REFERENCE_FILES_ENABLED = 'true';
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const caps = require('../src/config/assignmentCapabilities');
const policy = require('../src/services/audio/policy');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SavedRubric = require('../src/models/savedRubric.model');
const File = require('../src/models/File');

const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const future = () => new Date(Date.now() + 3 * 86400000).toISOString();
let f;
const savedRubric = (teacher, extra = {}) => SavedRubric.create({ teacher, name: 'Speaking rubric', rubricData: { totalPoints: 10,
  criteria: [{ name: 'Fluency', weight: 100, levels: [{ title: 'Good', score: 10, description: 'Clear and steady.' }] }] }, ...extra });

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; delete process.env.AUDIO_MAX_DURATION_SECONDS; });

describe('assignment capabilities', () => {
  // The exact values before speaking existed: essay, worksheet and flashcard must not change.
  const ESSAY = { type: 'essay', deadline: true, instructions: true, showMarksToStudent: true, allowLateResubmission: false, allowResubmission: true,
    requireAdaptiveBeforeResubmission: true, rubric: true, writingControls: true };
  const FLASHCARD = { type: 'flashcard', deadline: true, instructions: true, showMarksToStudent: false, allowLateResubmission: false, allowResubmission: false,
    requireAdaptiveBeforeResubmission: false, rubric: false, writingControls: false };
  const WORKSHEET = { ...FLASHCARD, type: 'worksheet', allowLateResubmission: true };
  test.each([
    [{ resourceType: 'essay' }, ESSAY], [{}, ESSAY], [null, ESSAY], [{ resourceType: 'unknown' }, ESSAY],
    [{ resourceType: 'flashcard' }, FLASHCARD], [{ resourceType: 'worksheet' }, WORKSHEET]
  ])('%p is unchanged', (assignment, expected) => {
    expect(caps.assignmentCapabilities(assignment)).toEqual(expected);
  });

  // Stage 6: speaking results now have marks, so the teacher gets the "show marks to students" control. The essay rubric editor (rubric)
  // stays off: the speaking rubric is a saved rubric edited in the rubric library.
  test('speaking: no essay writing controls or essay rubric editor, no resubmission or late resubmission; marks can be shown or hidden', () => {
    expect(caps.assignmentType({ resourceType: 'speaking' })).toBe('speaking');
    expect(caps.assignmentCapabilities({ resourceType: 'speaking' })).toEqual({ type: 'speaking', deadline: true, instructions: true,
      showMarksToStudent: true, allowLateResubmission: false, allowResubmission: false, requireAdaptiveBeforeResubmission: false, rubric: false,
      writingControls: false });
  });

  test.each([['essay', true], ['flashcard', false], ['worksheet', false], ['speaking', false]])('normalizeUnsupportedWritingFlags(%s) keeps writing flags: %p', (type, kept) => {
    const out = caps.normalizeUnsupportedWritingFlags({ resourceType: type, allowResubmission: true, requireAdaptiveBeforeResubmission: true });
    expect([out.allowResubmission, out.requireAdaptiveBeforeResubmission]).toEqual([kept, kept]);
  });
});

describe('creating a speaking assignment', () => {
  const create = (body, token = f.teacher.token) => request(app).post('/api/assignments').set(auth(token))
    .send({ title: 'Talk about your weekend', classId: String(f.klass._id), deadline: future(), instructions: 'Speak for two minutes.', resourceType: 'speaking', ...body });

  test('title, description, due date and the default maximum (the policy limit) are stored; essay-only flags are off', async () => {
    const res = await create({ allowGuestSubmission: true, allowResubmission: true, requireAdaptiveBeforeResubmission: true, allowLateResubmission: true,
      rubric: 'Ideas | Language', rubrics: { criteria: [{ name: 'Ideas', levels: [] }] } });
    expect(res.status).toBeLessThan(300);
    const stored = await Assignment.findById(res.body.data._id).lean();
    // Stage 6: without a chosen rubric, the teacher's own editable copy of the default speaking rubric is created once and referenced.
    const seeded = await SavedRubric.findOne({ teacher: f.teacher.user._id, name: 'Speaking rubric', writingType: 'speaking' }).lean();
    expect(seeded.rubricData.criteria.map(c => c.weight)).toEqual([25, 20, 20, 20, 15]);
    expect(stored).toMatchObject({ title: 'Talk about your weekend', instructions: 'Speak for two minutes.', resourceType: 'speaking', writingType: 'speaking',
      resourceId: null, allowGuestSubmission: false, allowResubmission: false, requireAdaptiveBeforeResubmission: false, allowLateResubmission: false,
      speaking: { maxRecordingSeconds: null, rubricRef: seeded._id } });
    const again = await create({ title: 'Second talk' });
    expect((await Assignment.findById(again.body.data._id).lean()).speaking.rubricRef).toEqual(seeded._id);
    expect(await SavedRubric.countDocuments({ teacher: f.teacher.user._id, writingType: 'speaking' })).toBe(1);
    expect(stored.rubric ?? null).toBeNull();
    expect(stored.rubrics ?? null).toBeNull();
    expect(stored.deadline).toBeTruthy();
  });

  test('a maximum recording length within the policy limit, and a rubric reference owned by the teacher', async () => {
    const rubric = await savedRubric(f.teacher.user._id);
    const res = await create({ speaking: { maxRecordingSeconds: 180, rubricRef: String(rubric._id) } });
    expect(res.status).toBeLessThan(300);
    expect((await Assignment.findById(res.body.data._id).lean()).speaking).toEqual({ maxRecordingSeconds: 180, rubricRef: rubric._id });
  });

  test.each([[9], [421], [12.5], ['60'], [-1]])('maxRecordingSeconds %p is refused (10 to the policy limit, whole seconds)', async (value) => {
    const res = await create({ speaking: { maxRecordingSeconds: value } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPEAKING_MAX_RECORDING_INVALID');
    expect(await Assignment.countDocuments({ title: 'Talk about your weekend' })).toBe(0);
  });

  test('the limit follows AUDIO_MAX_DURATION_SECONDS', async () => {
    process.env.AUDIO_MAX_DURATION_SECONDS = '120';
    expect((await create({ speaking: { maxRecordingSeconds: 121 } })).status).toBe(400);
    expect((await create({ speaking: { maxRecordingSeconds: 120 } })).status).toBeLessThan(300);
  });

  test('a rubric reference that is not the teacher\'s own is refused', async () => {
    const theirs = await savedRubric(f.otherTeacher.user._id);
    const archived = await savedRubric(f.teacher.user._id, { isActive: false });
    for (const rubricRef of [String(theirs._id), String(archived._id), String(new mongoose.Types.ObjectId()), 'not-an-id']) {
      const res = await create({ speaking: { rubricRef } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SPEAKING_RUBRIC_NOT_FOUND');
    }
  });

  test.each([[{ title: '' }], [{ deadline: undefined }], [{ deadline: '2020-01-01T00:00:00Z' }]])('the usual title and due-date checks apply (%p)', async (body) => {
    expect((await create(body)).status).toBe(400);
  });

  test('while AUDIO_STT_ENABLED is off a speaking assignment cannot be created (the same answer as before speaking existed)', async () => {
    delete process.env.AUDIO_STT_ENABLED;
    const res = await create({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('resourceType must be essay, flashcard, or worksheet');
  });

  test('essay creation is unchanged (writingType still required, no speaking settings stored)', async () => {
    const base = { title: 'Essay', classId: String(f.klass._id), deadline: future() };
    expect((await request(app).post('/api/assignments').set(auth(f.teacher.token)).send(base)).status).toBe(400);
    const ok = await request(app).post('/api/assignments').set(auth(f.teacher.token)).send({ ...base, writingType: 'narrative', speaking: { maxRecordingSeconds: 60 } });
    expect(ok.status).toBeLessThan(300);
    const stored = await Assignment.findById(ok.body.data._id).lean();
    expect(stored.resourceType).toBe('essay');
    expect(stored.speaking).toBeUndefined();
  });
});

describe('updating a speaking assignment', () => {
  const patch = (body, id = f.assignment._id, token = f.teacher.token) => request(app).patch(`/api/assignments/${id}`).set(auth(token)).send(body);

  test('title, description, due date and the maximum can change; essay-only fields are ignored', async () => {
    const res = await patch({ title: 'New title', instructions: 'New text', deadline: future(), speaking: { maxRecordingSeconds: 90 }, rubric: 'x',
      allowLateResubmission: true, allowResubmission: true });
    expect(res.status).toBe(200);
    const stored = await Assignment.findById(f.assignment._id).lean();
    expect(stored).toMatchObject({ title: 'New title', instructions: 'New text', speaking: { maxRecordingSeconds: 90 }, allowLateResubmission: false, allowResubmission: false });
    expect(stored.rubric ?? null).toBeNull();
  });

  test('an invalid maximum is refused and nothing changes', async () => {
    const res = await patch({ title: 'Changed', speaking: { maxRecordingSeconds: 5000 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPEAKING_MAX_RECORDING_INVALID');
    expect((await Assignment.findById(f.assignment._id).lean()).title).toBe('Describe your town');
  });

  test('speaking settings sent for an essay are ignored', async () => {
    expect((await patch({ speaking: { maxRecordingSeconds: 60 } }, f.essay._id)).status).toBe(200);
    expect((await Assignment.findById(f.essay._id).lean()).speaking).toBeUndefined();
  });

  test('another teacher gets 404', async () => {
    expect((await patch({ title: 'x' }, f.assignment._id, f.otherTeacher.token)).status).toBe(404);
  });

  test('Duplicate keeps the speaking settings', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { 'speaking.maxRecordingSeconds': 150 } });
    const res = await request(app).post(`/api/assignments/${f.assignment._id}/duplicate`).set(auth(f.teacher.token))
      .send({ targetClassId: String(f.klass._id), title: 'Copy', deadline: future() });
    expect(res.status).toBeLessThan(300);
    const copy = await Assignment.findOne({ title: 'Copy' }).lean();
    expect(copy).toMatchObject({ resourceType: 'speaking', speaking: { maxRecordingSeconds: 150 } });
  });
});

describe('essay-only features refuse or hide a speaking assignment', () => {
  const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };

  test.each([
    ['patch', id => `/api/assignments/${id}/rubrics`, { rubrics: { criteria: [] } }],
    ['post', id => `/api/assignments/${id}/generate-rubric-prompt`, { prompt: 'A rubric' }],
    ['post', id => `/api/assignments/${id}/rubric-file`, {}]
  ])('%s %s: 404, and the assignment is unchanged', async (method, url, body) => {
    const before = await Assignment.findById(f.assignment._id).lean();
    const res = await request(app)[method](url(f.assignment._id)).set(auth(f.teacher.token)).send(body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(await Assignment.findById(f.assignment._id).lean()).toEqual(before);
  });

  test('the whole-assignment report refuses it (409, the existing essay-only answer)', async () => {
    const res = await request(app).get(`/api/assignments/${f.assignment._id}/report`).set(auth(f.teacher.token));
    expect([404, 409]).toContain(res.status);
  });

  test.each([['stale-summary', 'get'], ['retry-stale', 'post']])('evaluations %s: 404 (essays only)', async (suffix, method) => {
    expect((await request(app)[method](`/api/assignments/${f.assignment._id}/evaluations/${suffix}`).set(auth(f.teacher.token))).status).toBe(404);
  });

  test('reference files: an assignment-scoped upload is refused', async () => {
    const res = await request(app).post(`/api/reference-files/assignments/${f.assignment._id}`).set(auth(f.teacher.token))
      .field('requestId', 'speaking-reference-1').attach('file', Buffer.from('notes'), 'notes.txt');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await require('../src/models/ReferenceFile').countDocuments()).toBe(0);
  });

  test('the guest essay flow: the QR entry is unavailable', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true } });
    expect((await request(app).get(`/api/guest/assignments/${f.assignment.qrToken}`)).status).toBe(404);
  });

  test('teacher upload on behalf (essay) is refused for a speaking assignment', async () => {
    const res = await request(app).post(`/api/assignments/${f.assignment._id}/teacher-uploads/check`).set(auth(f.teacher.token)).send({ students: [{ name: 'Speaking Student', email: 'speaking-student@example.com' }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test.each([
    ['by assignment id', () => `/api/submissions/${f.assignment._id}`],
    ['by QR', () => `/api/submissions/qr/${f.assignment.qrToken}`]
  ])('the essay image upload %s refuses a speaking assignment and keeps no file', async (_label, url) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const res = await request(app).post(url()).set(auth(f.student.token)).attach('file', png, 'page.png');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEAKING_NEEDS_RECORDING');
    expect(await Submission.countDocuments()).toBe(0);
    expect(await File.countDocuments()).toBe(0);
    const submissions = path.join(uploadRoot, 'submissions');
    expect(fs.existsSync(submissions) ? fs.readdirSync(submissions) : []).toEqual([]);
  });

  test('the recovery portal lists no speaking assignment (existing essay-only filter)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'recoveryPortal.service.js'), 'utf8');
    expect(source).toMatch(/resourceType && assignment\.resourceType !== 'essay'\) return \[\]/);
  });

  test('the Improved Writing Model refuses a speaking submission (existing essay-only filter)', async () => {
    process.env.IMPROVED_WRITING_MODEL_ENABLED = 'true';
    try {
      const { submission } = await makeAudioSubmission(f);
      expect((await request(app).get(`/api/submissions/${submission._id}/writing-model/teacher`).set(auth(f.teacher.token))).status).toBe(404);
    } finally { delete process.env.IMPROVED_WRITING_MODEL_ENABLED; }
  });
});

describe('lists keep their inclusion projections', () => {
  test('class submission counts include speaking submissions (same Submission collection)', async () => {
    await makeAudioSubmission(f);
    const res = await request(app).get(`/api/classes/${f.klass._id}/summary`).set(auth(f.teacher.token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/"submissionsCount":1/);
  });

  test('the teacher\'s submission list for a speaking assignment answers and marks the submission as audio', async () => {
    await makeAudioSubmission(f);
    for (const view of ['', '?view=cards', '?view=activity']) {
      const res = await request(app).get(`/api/submissions/assignment/${f.assignment._id}${view}`).set(auth(f.teacher.token));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    }
    const cards = await request(app).get(`/api/submissions/assignment/${f.assignment._id}?view=cards`).set(auth(f.teacher.token));
    expect(cards.body.data[0].sourceKind).toBe('audio');
  });

  test('the policy default is what an omitted maximum means', () => {
    expect(policy.readLimits({}).limits.maxDurationSeconds).toBe(420);
  });
});
