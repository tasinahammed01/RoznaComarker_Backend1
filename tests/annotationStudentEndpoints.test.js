'use strict';
// Task 6A follow-up: contract of the two registered-student endpoints that 6A changed to return a projected copy
//   GET /api/submissions/my  and  GET /api/submissions/assignment/:id/my
// (a) without annotations the response is byte-identical to the pre-6A golden (tests/annotationGolden.test.js holds the stored output);
// (b) with one hidden correction, exactly the visible-set fields differ and nothing else.
process.env.JWT_SECRET = 'annotation-student-endpoints-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-student-endpoints';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, normalizeVolatile } = require('./helpers/annotationFixture');
const { annotationApi } = require('./helpers/annotationApi');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'annotationGolden.golden'), 'utf8'));
const NAMES = { single: 'registered: my submission for assignment', list: 'registered: my submissions list' };
let fixture, jwt;
beforeAll(async () => { await connectInMemoryMongo(); await seedTestPlans(); fixture = await seedAnnotationFixture({ uploadRoot });
  jwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid }); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

// The golden was captured under uploads/annotation-golden; this file uses its own upload directory (parallel-safe), so only that segment is mapped.
const sameDir = value => JSON.parse(JSON.stringify(value).split('annotation-student-endpoints').join('annotation-golden'));
const get = async url => { const res = await request(app).get(url).set('Authorization', `Bearer ${jwt}`); return { status: res.status, body: sameDir(normalizeVolatile(res.body)) }; };
const fetchBoth = async () => ({ single: await get(`/api/submissions/assignment/${fixture.IDS.assignment}/my`), list: await get('/api/submissions/my') });

/** Every path whose value differs between two JSON values: "a.b[2].c". */
function diff(a, b, at = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out); return out; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], at ? `${at}.${k}` : k, out); return out; }
  out.push(at); return out;
}

test('without annotations: both endpoints equal the pre-6A golden output, key for key', async () => {
  const now = await fetchBoth();
  for (const [key, name] of Object.entries(NAMES)) {
    expect(diff(GOLDEN[name], now[key])).toEqual([]);
    expect(JSON.stringify(now[key])).toBe(JSON.stringify(GOLDEN[name]));
  }
});

test('with one hidden correction: only the visible-set fields change', async () => {
  const before = await fetchBoth();
  const api = annotationApi(app, fixture.teacher);
  const target = await api.find(fixture.IDS.registered, 'a', 'ART');
  expect((await api.act(fixture.IDS.registered, { action: 'hide', id: target.id })).status).toBe(200);
  const after = await fetchBoth();
  for (const key of ['single', 'list']) {
    const pick = r => (key === 'list' ? r.body.data[0] : r.body.data);
    const { writingCorrections: beforeList, ...beforeRest } = pick(before[key]);
    const { writingCorrections: afterList, ...afterRest } = pick(after[key]);
    // Everything except the correction list differs only in the two statistics the hidden item contributed to.
    const changed = diff(beforeRest, afterRest);
    console.log(`[contract] ${key}: paths changed outside writingCorrections: ${JSON.stringify(changed)}`);
    console.log(`[contract] ${key}: writingCorrections ${beforeList.length} -> ${afterList.length}; removed ids: ${JSON.stringify(beforeList.filter(c => !afterList.some(a => a.id === c.id)).map(c => c.id))}`);
    expect(changed.sort()).toEqual(['correctionStatistics.grammar', 'correctionStatistics.total']);
    // The list is the old list minus the hidden item: every remaining item is untouched.
    expect(afterList).toEqual(beforeList.filter(c => c.id !== target.id));
    expect(afterList.map(c => c.quotedText)).toEqual(['goes', 'dont', 'goes', 'realy']);
    expect(pick(after[key]).correctionStatistics).toEqual(expect.objectContaining({ grammar: 2, mechanics: 2, total: 4 }));
    expect(Object.keys(pick(after[key])).sort()).toEqual(Object.keys(pick(before[key])).sort());
    expect(JSON.stringify(after[key])).not.toContain('teacherAnnotations');
    expect(JSON.stringify(after[key])).not.toContain(target.id);
  }
});
