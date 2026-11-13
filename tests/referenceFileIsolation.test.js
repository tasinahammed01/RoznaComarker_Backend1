'use strict';
// Reference files never reach students, guests, recovery or PDFs.
//  1. Static: only the files listed in ALLOWED may mention the ReferenceFile collection or the reference-file services, and no route file
//     other than routes/referenceFile.routes.js can reach them through its requires (followed transitively, lazy requires included).
//     Stage 4 (marking) added exactly one context module, services/referenceFiles/markingContext.js, with its own leak tests
//     (tests/referenceFileMarking.test.js). It is the only part of the feature that marking (and so any route) may reach; anything else is a regression.
//  2. Runtime: with files uploaded and read, the student, member and guest endpoints return nothing about them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

jest.setTimeout(60000);
process.env.JWT_SECRET = 'reference-file-isolation-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.UPLOAD_BASE_PATH = `uploads/reference-isolation-${process.pid}`;
process.env.REFERENCE_FILES_ENABLED = 'true';

const SRC = path.resolve(__dirname, '..', 'src');
const rel = file => path.relative(SRC, file).split(path.sep).join('/');
const ALLOWED = new Set(['app.js', 'server.js', 'models/ReferenceFile.js', 'models/File.js', 'controllers/referenceFile.controller.js', 'routes/referenceFile.routes.js',
  // Stage 4, marking: resolves the context once per run and stores only its version, hash and file count on the (teacher-only) result.
  'services/canonicalEvaluation.service.js',
  // Stage 4, marking: adds the two prompt lines (assessment prompt only; none without usable files).
  'services/semanticRubricAssessment.service.js',
  // Stage 4: the context version joins the runtime fingerprint only while REFERENCE_FILES_ENABLED is on.
  'services/runtimeContractFingerprint.service.js']);
const isFeature = name => name === 'models/ReferenceFile.js' || name.startsWith('services/referenceFiles/');
// The single entry point marking may use. Followed no further: what it reads (ready files' excerpts) goes only into the AI request.
const MARKING_BRIDGE = 'services/referenceFiles/markingContext.js';
// The on/off switch and limits (no database, no file data, no requires): the runtime fingerprint (health route) reads the switch.
const SWITCH_ONLY = 'services/referenceFiles/policy.js';
const MENTION = /ReferenceFile|referenceFiles|reference-files|referencefiles/u;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(c?js|ts)$/u.test(entry.name) ? [full] : [];
  });
}
function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, `${base}.ts`, path.join(base, 'index.js'), path.join(base, 'index.ts')])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return null;
}
const requiresOf = file => [...fs.readFileSync(file, 'utf8').matchAll(/(?:require\(|from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu)]
  .map(match => resolveLocal(file, match[1])).filter(Boolean);

describe('static isolation', () => {
  test('only the allowed files mention the reference-file collection or services', () => {
    const offenders = sourceFiles(SRC).map(rel).filter(name => !isFeature(name) && !ALLOWED.has(name)
      && MENTION.test(fs.readFileSync(path.join(SRC, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('no route except the reference-file router reaches the collection or its services (transitively), except marking through the one bridge', () => {
    const routes = fs.readdirSync(path.join(SRC, 'routes')).filter(name => /\.(js|ts)$/u.test(name) && name !== 'referenceFile.routes.js');
    expect(routes.length).toBeGreaterThan(20);
    const reached = {}; const throughBridge = new Set();
    for (const route of routes) {
      const seen = new Set(), queue = [path.join(SRC, 'routes', route)];
      while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        if (rel(file) === MARKING_BRIDGE) { throughBridge.add(route); continue; }
        if (rel(file) === SWITCH_ONLY) { expect(requiresOf(file)).toEqual([]); continue; }
        if (isFeature(rel(file))) (reached[route] ||= []).push(rel(file));
        queue.push(...requiresOf(file));
      }
    }
    expect(reached).toEqual({});
    expect(throughBridge.size).toBeGreaterThan(0);                 // the check sees marking: it is not vacuous
  });

  test('the marking bridge returns no file text to its callers, only the prompt lines and a version/hash/count record', () => {
    const marking = require('../src/services/referenceFiles/markingContext');
    const ctx = marking.assembleContext([{ _id: 'x', scope: 'class', markingText: 'Secret course text.' }]);
    expect(marking.resultRecord(ctx)).toEqual({ version: 'reference-context-v1', hash: ctx.hash, fileCount: 1 });
    expect(JSON.stringify(marking.resultSet(ctx))).not.toContain('Secret');
    expect(marking.promptLines(ctx)[0]).toContain('Secret course text.');   // only ever passed to the assessment request builder
    const callers = sourceFiles(SRC).map(rel).filter(name => name !== MARKING_BRIDGE && /promptLines\(/u.test(fs.readFileSync(path.join(SRC, name), 'utf8')));
    expect(callers).toEqual(['services/semanticRubricAssessment.service.js']);
  });

  test('the check itself works: the reference-file router does reach them', () => {
    const seen = new Set(), queue = [path.join(SRC, 'routes', 'referenceFile.routes.js')];
    while (queue.length) { const file = queue.pop(); if (!seen.has(file)) { seen.add(file); queue.push(...requiresOf(file)); } }
    expect([...seen].map(rel)).toEqual(expect.arrayContaining(['models/ReferenceFile.js', 'services/referenceFiles/referenceFile.service.js']));
  });
});

describe('runtime isolation', () => {
  const request = require('supertest');
  const app = require('../src/app');
  const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
  const { seedTestPlans } = require('./helpers/seedTestPlans');
  const { signTestJwt } = require('./helpers/auth');
  const User = require('../src/models/user.model');
  const Class = require('../src/models/class.model');
  const Assignment = require('../src/models/assignment.model');
  const Membership = require('../src/models/membership.model');
  const ReferenceFile = require('../src/models/ReferenceFile');
  const f = require('./helpers/referenceFileFixtures');
  const SECRET = 'Confidential answer key: the strongest essays cite the harbour survey of 2019.';
  const NAMES = ['Answer key 9B.docx', 'Teacher notes 9B.docx'];
  let teacherToken, studentToken, assignment, klass;

  beforeAll(async () => {
    await connectInMemoryMongo(); await seedTestPlans();
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 't@example.com', role: 'teacher', displayName: 'Ms Rahman' });
    const student = await User.create({ firebaseUid: crypto.randomUUID(), email: 's@example.com', role: 'student', displayName: 'Sam' });
    teacherToken = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
    studentToken = signTestJwt({ id: student._id, role: 'student', firebaseUid: student.firebaseUid });
    klass = await Class.create({ name: '9B', teacher: teacher._id, joinCode: `J${crypto.randomUUID().slice(0, 8)}` });
    assignment = await Assignment.create({ title: 'Harbour essay', instructions: 'Argue for or against the new harbour.', class: klass._id,
      teacher: teacher._id, resourceType: 'essay', allowGuestSubmission: true, qrToken: crypto.randomUUID(), deadline: new Date(Date.now() + 864e5) });
    await Membership.create({ student: student._id, class: klass._id, status: 'active' });
    for (const [scope, id, name] of [['classes', klass._id, NAMES[0]], ['assignments', assignment._id, NAMES[1]]]) {
      const res = await request(app).post(`/api/reference-files/${scope}/${id}`).set('Authorization', `Bearer ${teacherToken}`)
        .field('requestId', crypto.randomUUID()).attach('file', await f.docx([SECRET]), name);
      expect(res.status).toBe(201);
    }
    for (let i = 0; i < 150 && await ReferenceFile.exists({ status: 'processing' }); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
    expect(await ReferenceFile.countDocuments({ status: 'ready' })).toBe(2);
  });
  afterAll(async () => {
    await disconnectInMemoryMongo();
    fs.rmSync(path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH), { recursive: true, force: true });
  });

  const expectNothingAboutFiles = (label, res) => {
    const json = JSON.stringify(res.body);
    expect([label, res.status]).toEqual([label, expect.any(Number)]);
    for (const leak of [...NAMES, 'harbour survey', 'Confidential', 'classFiles', 'rubricSuggestion', 'referenceFile', 'reference-file'])
      expect([label, json.includes(leak) ? leak : null]).toEqual([label, null]);
  };

  test('student, member and guest endpoints return nothing about the files', async () => {
    const student = { Authorization: `Bearer ${studentToken}` };
    const calls = [
      ['assignments/my', await request(app).get('/api/assignments/my').set(student)],
      ['assignment detail', await request(app).get(`/api/assignments/${assignment._id}`).set(student)],
      ['assignment by QR', await request(app).get(`/api/assignments/qr/${assignment.qrToken}`).set(student)],
      ['memberships/mine', await request(app).get('/api/memberships/mine').set(student)],
      ['guest entry', await request(app).get(`/api/guest/assignments/${assignment.qrToken}`)]];
    for (const [label, res] of calls) expectNothingAboutFiles(label, res);
    // The calls really returned the assignment (so the check is meaningful).
    expect(JSON.stringify(calls[1][1].body)).toContain('Harbour essay');
    expect(JSON.stringify(calls[4][1].body)).toContain('Harbour essay');
    // And the reference-file routes refuse students.
    expect((await request(app).get(`/api/reference-files/assignments/${assignment._id}`).set(student)).status).toBe(403);
  });
});
