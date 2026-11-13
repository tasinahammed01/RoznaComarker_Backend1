'use strict';
// /api/reference-files over HTTP: permissions (401/403/404), the feature switch, upload checks, idempotency, limits, storage quota, status
// polling, soft delete, and rubric draft/apply. In-memory MongoDB, synthetic files, the real extraction worker; the AI rubric parser is mocked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

jest.setTimeout(60000);   // files are read by the real extraction worker
process.env.JWT_SECRET = 'reference-file-routes-test-secret';
process.env.NODE_ENV = 'test';
// Relative, as app.js expects; under the git-ignored uploads folder, removed afterwards.
process.env.UPLOAD_BASE_PATH = `uploads/reference-routes-${process.pid}`;
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
process.env.REFERENCE_FILES_ENABLED = 'true';
jest.mock('../src/services/rubricAIParser.service', () => ({ parseRubricTextToJson: jest.fn() }));

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const File = require('../src/models/File');
const ReferenceFile = require('../src/models/ReferenceFile');
const { parseRubricTextToJson } = require('../src/services/rubricAIParser.service');
const f = require('./helpers/referenceFileFixtures');

const SECRET = 'Course outline for 9B: persuasive essays about the river crossing, with evidence from the two council reports.';
const RUBRIC = 'Essay Rubric\nCriteria | Excellent (4 points) | Proficient (3 points) | Developing (2 points) | Beginning (1 point)\n'
  + 'Thesis | Clear | Mostly clear | Vague | Missing\nEvidence | Strong | Some | Little | None';
const PARSED = { title: 'Essay Rubric', levels: [{ name: 'Beginning', score: 1 }, { name: 'Developing', score: 2 }, { name: 'Proficient', score: 3 }, { name: 'Excellent', score: 4 }],
  criteria: [{ title: 'Thesis', descriptions: ['Missing', 'Vague', 'Mostly clear', 'Clear'] }, { title: 'Evidence', descriptions: ['None', 'Little', 'Some', 'Strong'] }] };
const EXISTING_RUBRIC = { totalPoints: 100, criteria: [{ id: 'c1', name: 'Ideas', weight: 100,
  levels: [{ title: 'Low', score: 1, description: 'Weak' }, { title: 'High', score: 2, description: 'Strong' }] }] };

let teacher, other, student, token, otherToken, studentToken, klass, assignment, otherClass;
const auth = t => ({ Authorization: `Bearer ${t}` });
const rid = () => crypto.randomUUID();

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  process.env.REFERENCE_FILES_ENABLED = 'true';
  teacher = await User.create({ firebaseUid: rid(), email: 'teacher@example.com', role: 'teacher', displayName: 'Ms Rahman' });
  other = await User.create({ firebaseUid: rid(), email: 'other@example.com', role: 'teacher' });
  student = await User.create({ firebaseUid: rid(), email: 'student@example.com', role: 'student' });
  token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  otherToken = signTestJwt({ id: other._id, role: 'teacher', firebaseUid: other.firebaseUid });
  studentToken = signTestJwt({ id: student._id, role: 'student', firebaseUid: student.firebaseUid });
  klass = await Class.create({ name: '9B', teacher: teacher._id, joinCode: `J${rid().slice(0, 8)}` });
  otherClass = await Class.create({ name: 'Other', teacher: other._id, joinCode: `K${rid().slice(0, 8)}` });
  assignment = await Assignment.create({ title: 'River essay', class: klass._id, teacher: teacher._id, resourceType: 'essay' });
});

const upload = (scope, id, buffer, name, { t = token, requestId = rid(), fields = {} } = {}) => {
  const req = request(app).post(`/api/reference-files/${scope}/${id}`).set(auth(t)).field('requestId', requestId);
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  return req.attach('file', buffer, name);
};
async function ready(id, t = token) {
  for (let i = 0; i < 150; i += 1) {
    const res = await request(app).get(`/api/reference-files/${id}`).set(auth(t));
    if (res.body?.data?.file?.status !== 'processing') return res;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('still processing');
}
/** Nothing in a response may reveal the text, the stored path or file id, or a hash. */
async function expectClean(body) {
  const json = JSON.stringify(body);
  expect(json).not.toContain('river crossing');
  expect(json).not.toMatch(/references[\\/]|internal:reference|contentHash|"path"|"text"|"fileId"|"filename"|[0-9a-f]{64}/u);
  for (const file of await File.find({ type: 'references' }).lean()) { expect(json).not.toContain(String(file._id)); expect(json).not.toContain(file.filename); }
}

describe('access', () => {
  test('signed out 401, student 403, another teacher 404 on every route', async () => {
    const res = await upload('classes', klass._id, await f.docx([SECRET]), 'outline.docx');
    const fileId = res.body.data.file.id;
    const routes = [['get', `/api/reference-files/classes/${klass._id}`], ['post', `/api/reference-files/classes/${klass._id}`],
      ['get', `/api/reference-files/assignments/${assignment._id}`], ['post', `/api/reference-files/assignments/${assignment._id}`],
      ['get', `/api/reference-files/${fileId}`], ['delete', `/api/reference-files/${fileId}`],
      ['post', `/api/reference-files/${fileId}/rubric-draft`], ['post', `/api/reference-files/${fileId}/apply-rubric`]];
    for (const [method, url] of routes) {
      expect((await request(app)[method](url)).status).toBe(401);
      expect((await request(app)[method](url).set(auth(studentToken))).status).toBe(403);
      const forOther = await request(app)[method](url).set(auth(otherToken));
      expect([method, url, forOther.status]).toEqual([method, url, 404]);
    }
    expect((await ReferenceFile.findById(fileId)).removedAt).toBeNull();          // the other teacher's delete did nothing
    expect((await request(app).get(`/api/reference-files/classes/${otherClass._id}`).set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/reference-files/classes/not-an-id').set(auth(token))).status).toBe(404);
    expect((await request(app).get(`/api/reference-files/${new mongoose.Types.ObjectId()}`).set(auth(token))).status).toBe(404);
  });

  test('another teacher\'s upload is refused before the file is read or stored', async () => {
    const onDisk = () => (fs.existsSync(path.join(uploadRoot, 'references')) ? fs.readdirSync(path.join(uploadRoot, 'references')).length : 0);
    const before = onDisk();
    const res = await upload('classes', klass._id, await f.docx([SECRET]), 'outline.docx', { t: otherToken });
    expect(res.status).toBe(404);
    expect(await ReferenceFile.countDocuments()).toBe(0);
    expect(onDisk()).toBe(before);
  });

  test('config: teachers learn whether the feature is on (also while off); students 403, signed out 401', async () => {
    const on = await request(app).get('/api/reference-files/config').set(auth(token));
    expect(on.body.data).toEqual({ enabled: true, maxFiles: 5, maxFileBytes: 10 * 1024 * 1024 });
    process.env.REFERENCE_FILES_ENABLED = 'false';
    expect((await request(app).get('/api/reference-files/config').set(auth(token))).body.data).toEqual({ enabled: false });
    expect((await request(app).get('/api/reference-files/config').set(auth(studentToken))).status).toBe(403);
    expect((await request(app).get('/api/reference-files/config')).status).toBe(401);
  });

  test('with REFERENCE_FILES_ENABLED off every route answers 404', async () => {
    process.env.REFERENCE_FILES_ENABLED = 'false';
    expect((await request(app).get(`/api/reference-files/classes/${klass._id}`).set(auth(token))).status).toBe(404);
    expect((await upload('classes', klass._id, await f.docx([SECRET]), 'outline.docx')).status).toBe(404);
    expect(await ReferenceFile.countDocuments()).toBe(0);
  });

  test('archived classes, removed assignments and non-writing assignments', async () => {
    await Class.updateOne({ _id: klass._id }, { $set: { status: 'archived' } });
    expect((await request(app).get(`/api/reference-files/classes/${klass._id}`).set(auth(token))).status).toBe(404);
    expect((await request(app).get(`/api/reference-files/assignments/${assignment._id}`).set(auth(token))).status).toBe(404);
    await Class.updateOne({ _id: klass._id }, { $set: { status: 'active' } });
    const worksheet = await Assignment.create({ title: 'Sheet', class: klass._id, teacher: teacher._id, resourceType: 'worksheet' });
    const res = await upload('assignments', worksheet._id, await f.docx([SECRET]), 'outline.docx');
    expect([res.status, res.body.code]).toEqual([400, 'REFERENCE_FILE_NOT_WRITING']);
  });
});

describe('upload, status, list and remove', () => {
  test('a class file is stored, read in the background and reported ready; no response reveals text, path, file id or hash', async () => {
    const res = await upload('classes', klass._id, await f.docx([SECRET]), '..\\..\\Outline 9B.docx');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ duplicate: false, file: expect.objectContaining({ scope: 'class', name: 'Outline 9B.docx', kind: 'docx',
      status: 'processing', markedAsRubric: false, rubricSuggestion: null }) });
    await expectClean(res.body);
    const done = await ready(res.body.data.file.id);
    expect(done.body.data.file).toEqual(expect.objectContaining({ status: 'ready', failureMessage: null, rubricSuggestion: null }));
    await expectClean(done.body);
    const list = await request(app).get(`/api/reference-files/classes/${klass._id}`).set(auth(token));
    expect(list.body.data).toEqual({ files: [expect.objectContaining({ id: res.body.data.file.id })], limits: { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024 } });
    await expectClean(list.body);
    expect((await ReferenceFile.findById(res.body.data.file.id).select('+text').lean()).text).toBe(SECRET);   // cached server-side only
    const stored = await File.findOne({ type: 'references' }).lean();
    expect(stored.filename).toMatch(/^[0-9a-f-]{36}\.docx$/u);                                                 // random name on disk
    expect(fs.existsSync(path.join(uploadRoot, 'references', stored.filename))).toBe(true);
  });

  test('a scanned PDF ends failed with the clear reason', async () => {
    const res = await upload('classes', klass._id, await f.pdf([]), 'scan.pdf');
    const done = await ready(res.body.data.file.id);
    expect(done.body.data.file).toEqual(expect.objectContaining({ status: 'failed', failureCode: 'REFERENCE_FILE_NO_TEXT_PDF',
      failureMessage: 'No readable text found (scanned PDF).' }));
  });

  test('the same request id twice stores one file and counts storage once; reusing it elsewhere is refused', async () => {
    const buffer = await f.docx([SECRET], { extra: { 'word/media/noise.bin': crypto.randomBytes(300 * 1024) } });   // about 0.3 MB
    const requestId = rid();
    const first = await upload('classes', klass._id, buffer, 'outline.docx', { requestId });
    const again = await upload('classes', klass._id, buffer, 'outline.docx', { requestId });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.data).toEqual({ duplicate: true, file: expect.objectContaining({ id: first.body.data.file.id }) });
    expect(await ReferenceFile.countDocuments()).toBe(1);
    expect(await File.countDocuments({ type: 'references' })).toBe(1);
    const usage = (await User.findById(teacher._id)).usage.storageMB;
    expect(usage).toBeCloseTo(0.29, 1);
    const reused = await upload('assignments', assignment._id, buffer, 'outline.docx', { requestId });
    expect([reused.status, reused.body.code]).toEqual([409, 'REFERENCE_FILE_REQUEST_REUSED']);
    expect((await User.findById(teacher._id)).usage.storageMB).toBe(usage);
    expect((await upload('classes', klass._id, buffer, 'outline.docx', { requestId: 'bad id!' })).status).toBe(400);
  });

  test('the same content twice in one class is refused; five files per class at most', async () => {
    const buffer = await f.docx([SECRET]);
    await upload('classes', klass._id, buffer, 'a.docx');
    const dup = await upload('classes', klass._id, buffer, 'b.docx');
    expect([dup.status, dup.body.code]).toEqual([409, 'REFERENCE_FILE_DUPLICATE']);
    for (let i = 1; i < 5; i += 1) expect((await upload('classes', klass._id, await f.docx([`${SECRET} ${i}`]), `${i}.docx`)).status).toBe(201);
    const sixth = await upload('classes', klass._id, await f.docx([`${SECRET} six`]), 'six.docx');
    expect([sixth.status, sixth.body.code, sixth.body.message]).toEqual([409, 'REFERENCE_FILE_LIMIT', 'You can add up to 5 files to each class. Remove one first.']);
    // The assignment has its own five.
    expect((await upload('assignments', assignment._id, await f.docx([`${SECRET} six`]), 'six.docx')).status).toBe(201);
  });

  test('refused files: type, old PowerPoint, spoofed, macro, password, too large, two files; nothing stored', async () => {
    const cases = [
      [Buffer.from('plain text'), 'notes.txt', 400, 'REFERENCE_FILE_TYPE'],
      [f.ole({ 'PowerPoint Document': Buffer.alloc(64) }), 'deck.ppt', 400, 'REFERENCE_FILE_OLD_POWERPOINT'],
      [Buffer.from('89504e470d0a1a0a', 'hex'), 'image.pdf', 400, 'REFERENCE_FILE_MISMATCH'],
      [await f.docx(['x'], { extra: { 'word/vbaProject.bin': 'vba' } }), 'plan.docx', 400, 'REFERENCE_FILE_MACRO'],
      [f.ole({ EncryptionInfo: Buffer.alloc(64), EncryptedPackage: Buffer.alloc(64) }), 'locked.docx', 422, 'REFERENCE_FILE_PASSWORD'],
      [Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024)]), 'big.pdf', 413, 'REFERENCE_FILE_TOO_LARGE']];
    for (const [buffer, name, status, code] of cases) {
      const res = await upload('classes', klass._id, buffer, name);
      expect([name, res.status, res.body.code]).toEqual([name, status, code]);
    }
    const two = await request(app).post(`/api/reference-files/classes/${klass._id}`).set(auth(token)).field('requestId', rid())
      .attach('file', await f.docx(['a']), 'a.docx').attach('file', await f.docx(['b']), 'b.docx');
    expect([two.status, two.body.code]).toEqual([400, 'REFERENCE_FILE_ONE_AT_A_TIME']);
    expect(await ReferenceFile.countDocuments()).toBe(0);
    expect(await File.countDocuments({ type: 'references' })).toBe(0);
    expect((await User.findById(teacher._id)).usage?.storageMB || 0).toBe(0);
  });

  test('storage full: refused, nothing stored, usage unchanged', async () => {
    await User.updateOne({ _id: teacher._id }, { $set: { 'usage.storageMB': 499.99 } });
    const res = await upload('classes', klass._id, await f.docx([SECRET], { extra: { 'word/media/noise.bin': crypto.randomBytes(100 * 1024) } }), 'outline.docx');
    expect([res.status, res.body.code]).toEqual([413, 'REFERENCE_FILE_STORAGE_FULL']);
    expect(await ReferenceFile.countDocuments()).toBe(0);
    expect((await User.findById(teacher._id)).usage.storageMB).toBe(499.99);
  });

  test('assignment list shows its files and, read-only, the class files; remove is a soft delete and idempotent', async () => {
    const classFile = (await upload('classes', klass._id, await f.docx([SECRET]), 'class.docx')).body.data.file;
    const own = (await upload('assignments', assignment._id, await f.docx([`${SECRET} own`]), 'own.docx')).body.data.file;
    const list = await request(app).get(`/api/reference-files/assignments/${assignment._id}`).set(auth(token));
    expect(list.body.data.files.map(x => x.id)).toEqual([own.id]);
    expect(list.body.data.classFiles.map(x => x.id)).toEqual([classFile.id]);
    const removed = await request(app).delete(`/api/reference-files/${own.id}`).set(auth(token));
    expect([removed.status, removed.body.data.removed, removed.body.data.file.status]).toEqual([200, true, 'removed']);
    expect((await request(app).delete(`/api/reference-files/${own.id}`).set(auth(token))).status).toBe(200);
    expect((await request(app).get(`/api/reference-files/${own.id}`).set(auth(token))).status).toBe(404);
    const after = await request(app).get(`/api/reference-files/assignments/${assignment._id}`).set(auth(token));
    expect(after.body.data.files).toEqual([]);
    expect(await ReferenceFile.findById(own.id).lean()).toEqual(expect.objectContaining({ removedBy: teacher._id }));   // kept, audited
    await expectClean(removed.body);
  });

  test('"This file is a rubric" is only for assignment files', async () => {
    const res = await upload('classes', klass._id, await f.docx([SECRET]), 'a.docx', { fields: { markedAsRubric: 'true' } });
    expect([res.status, res.body.code]).toEqual([400, 'REFERENCE_FILE_RUBRIC_CLASS']);
    const ok = await upload('assignments', assignment._id, await f.docx([SECRET]), 'a.docx', { fields: { markedAsRubric: 'true' } });
    expect(ok.body.data.file.markedAsRubric).toBe(true);
  });
});

describe('rubric detection, draft and apply', () => {
  async function rubricFile(scope = 'assignments', id = assignment._id) {
    const res = await upload(scope, id, await f.docx(RUBRIC.split('\n')), 'rubric.docx');
    return (await ready(res.body.data.file.id)).body.data.file;
  }

  test('an assignment file that looks like a rubric carries a suggestion; a class file never does', async () => {
    expect((await rubricFile()).rubricSuggestion).toEqual({ looksLikeRubric: true, confidence: 'high' });
    expect((await rubricFile('classes', klass._id)).rubricSuggestion).toBeNull();
  });

  test('draft: a valid designer rubric for review, nothing saved; class files, failures and AI outages are reported', async () => {
    const file = await rubricFile();
    parseRubricTextToJson.mockResolvedValue(PARSED);
    const draft = await request(app).post(`/api/reference-files/${file.id}/rubric-draft`).set(auth(token));
    expect(draft.status).toBe(200);
    expect(draft.body.data).toEqual({ rubricDesigner: expect.objectContaining({ totalPoints: 100 }), notes: ['WEIGHTS_SET_EQUALLY'], hasExistingRubric: false });
    expect(parseRubricTextToJson).toHaveBeenCalledWith({ text: RUBRIC.replace(/\n/gu, '\n\n') });
    expect((await Assignment.findById(assignment._id).lean()).rubrics).toBeUndefined();

    parseRubricTextToJson.mockResolvedValue({ ...PARSED, criteria: [{ title: 'Thesis', descriptions: ['', '', '', ''] }] });
    const failed = await request(app).post(`/api/reference-files/${file.id}/rubric-draft`).set(auth(token));
    expect([failed.status, failed.body.code]).toEqual([422, 'REFERENCE_RUBRIC_CONVERSION_FAILED']);
    expect(failed.body.details.issues).toContain('Every performance level requires a description.');
    parseRubricTextToJson.mockRejectedValue(Object.assign(new Error('provider down'), { statusCode: 502 }));
    const down = await request(app).post(`/api/reference-files/${file.id}/rubric-draft`).set(auth(token));
    expect([down.status, down.body.code]).toEqual([503, 'REFERENCE_RUBRIC_AI_UNAVAILABLE']);
    expect(JSON.stringify(down.body)).not.toContain('provider down');

    const classFile = await rubricFile('classes', klass._id);
    const refused = await request(app).post(`/api/reference-files/${classFile.id}/rubric-draft`).set(auth(token));
    expect([refused.status, refused.body.code]).toEqual([400, 'REFERENCE_RUBRIC_ASSIGNMENT_ONLY']);
  });

  test('a file still being read, or that failed, cannot be drafted', async () => {
    const res = await upload('assignments', assignment._id, await f.pdf([]), 'scan.pdf');
    const now = await request(app).post(`/api/reference-files/${res.body.data.file.id}/rubric-draft`).set(auth(token));
    expect(now.status).toBe(409);
    await ready(res.body.data.file.id);
    const failed = await request(app).post(`/api/reference-files/${res.body.data.file.id}/rubric-draft`).set(auth(token));
    expect([failed.status, failed.body.message]).toEqual([409, 'No readable text found (scanned PDF).']);
  });

  test('apply: saved through the normal rubric save; an existing rubric needs replace: true; invalid rubrics refused', async () => {
    const file = await rubricFile();
    parseRubricTextToJson.mockResolvedValue(PARSED);
    const { rubricDesigner } = (await request(app).post(`/api/reference-files/${file.id}/rubric-draft`).set(auth(token))).body.data;
    const applied = await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token)).send({ rubricDesigner });
    expect([applied.status, applied.body.data]).toEqual([200, { applied: true, replaced: false, assignmentId: String(assignment._id) }]);
    const saved = (await Assignment.findById(assignment._id).lean()).rubrics;
    expect(saved.criteria.map(c => [c.name, c.weight])).toEqual([['Thesis', 50], ['Evidence', 50]]);
    expect((await ReferenceFile.findById(file.id).lean()).rubricAppliedAt).toBeInstanceOf(Date);

    const edited = { ...rubricDesigner, criteria: rubricDesigner.criteria.map((c, i) => ({ ...c, weight: [70, 30][i] })) };
    const blocked = await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token)).send({ rubricDesigner: edited });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'REFERENCE_RUBRIC_EXISTS']);
    expect((await Assignment.findById(assignment._id).lean()).rubrics.criteria.map(c => c.weight)).toEqual([50, 50]);
    const replaced = await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token)).send({ rubricDesigner: edited, replace: true });
    expect([replaced.status, replaced.body.data.replaced]).toEqual([200, true]);
    expect((await Assignment.findById(assignment._id).lean()).rubrics.criteria.map(c => c.weight)).toEqual([70, 30]);

    const invalid = await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token))
      .send({ rubricDesigner: { ...edited, totalPoints: 50 }, replace: true });
    expect([invalid.status, invalid.body.code]).toEqual([400, 'REFERENCE_RUBRIC_INVALID']);
    expect((await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token)).send({})).status).toBe(400);
  });

  test('an assignment that already had a rubric before any file is protected the same way', async () => {
    await Assignment.updateOne({ _id: assignment._id }, { $set: { rubrics: EXISTING_RUBRIC } });
    const file = await rubricFile();
    parseRubricTextToJson.mockResolvedValue(PARSED);
    const draft = (await request(app).post(`/api/reference-files/${file.id}/rubric-draft`).set(auth(token))).body.data;
    expect(draft.hasExistingRubric).toBe(true);
    const blocked = await request(app).post(`/api/reference-files/${file.id}/apply-rubric`).set(auth(token)).send({ rubricDesigner: draft.rubricDesigner });
    expect(blocked.status).toBe(409);
    expect((await Assignment.findById(assignment._id).lean()).rubrics.criteria[0].name).toBe('Ideas');
  });

  test('rubric drafts are rate-limited per teacher', async () => {
    const busy = await User.create({ firebaseUid: rid(), email: 'busy@example.com', role: 'teacher' });
    const busyToken = signTestJwt({ id: busy._id, role: 'teacher', firebaseUid: busy.firebaseUid });
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await request(app).post(`/api/reference-files/${new mongoose.Types.ObjectId()}/rubric-draft`).set(auth(busyToken))).status);
    expect(statuses.slice(0, 10).every(status => status === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(parseRubricTextToJson).not.toHaveBeenCalled();
  });
});
