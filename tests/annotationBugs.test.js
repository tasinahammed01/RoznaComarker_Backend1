'use strict';
// Task 6A reproductions of the confirmed teacher-annotation bugs. Written before the fix; each must fail on the pre-6A code.
//   1. Hidden corrections are still counted (category counts, draft comparison).
//   2. A hidden correction reappears after an AI regenerate gives it a new id.
//   3. Teacher edits, hides and manual entries vanish after an OCR re-run.
//   4. (found in 6A) Registered students receive the raw correction list, hidden entries included, from the my-submission endpoints.
process.env.JWT_SECRET = 'annotation-bugs-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-bugs';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, rerunOcr, regenerateCorrections, AI_SPECS, WORDS } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(180000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture, teacher;
const HIDDEN_MESSAGE = 'Use "an" before a vowel sound.';

beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const studentSurfaces = () => capture(surfaces({ app, ids: fixture.IDS, guestToken: fixture.guestToken,
  studentJwt: signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid }) }));

/** Every { grammar, total, ... } statistics object and every correction list in a response body. */
function scan(body) {
  const stats = [], lists = [];
  (function walk(value, key) {
    if (Array.isArray(value)) {
      if (value.some(v => v && typeof v === 'object' && 'quotedText' in v && 'symbol' in v)) lists.push({ key, items: value });
      value.forEach(v => walk(v, key));
    } else if (value && typeof value === 'object') {
      if (/^(correctionStatistics|correctionStats|statistics)$/.test(key) && 'total' in value) stats.push({ key, value });
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  })(body, '');
  return { stats, lists };
}

async function hideWord(submissionId, word, symbol) {
  const target = await teacher.find(submissionId, word, symbol);
  const res = await teacher.act(submissionId, { action: 'hide', id: target.id });
  expect(res.status).toBe(200);
  return target;
}

describe('bug 1: hidden corrections must not be counted', () => {
  test('category counts on every student surface follow the visible set; scores do not change', async () => {
    await hideWord(fixture.IDS.registered, 'a', 'ART');
    await hideWord(fixture.IDS.guest, 'a', 'ART');
    const out = await studentSurfaces();
    let checked = 0;
    for (const [name, { status, body }] of Object.entries(out)) {
      expect({ name, status }).toEqual({ name, status: 200 });
      for (const { key, value } of scan(body).stats) {
        checked += 1;
        expect({ name, key, grammar: value.grammar, total: value.total }).toEqual({ name, key, grammar: 2, total: 4 });
      }
      const sourceCounts = body?.data?.sourceCounts;
      if (sourceCounts) expect({ name, semanticAi: sourceCounts.semanticAi }).toEqual({ name, semanticAi: 4 });
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    // Decision 1: scores never change automatically.
    expect(out['registered: feedback'].body.data.overallScore).toBe(82);
    expect(out['guest: feedback'].body.data.overallScore).toBe(82);
    expect(out['registered: feedback'].body.data.rubricScores.GRAMMAR.score).toBe(18);
  });

  test('draft comparison counts only visible corrections of both drafts', async () => {
    await hideWord(fixture.IDS.registered, 'a', 'ART');
    const doc = await Submission.findById(fixture.IDS.registered);
    await require('../src/services/submissionRevision.service').captureCurrentRevision(doc);
    await Submission.updateOne({ _id: doc._id }, { $set: { draftNumber: 2, fileContentIdentity: 'fixture-registered-draft-2' } });
    let comparison = (await studentSurfaces())['registered: draft comparison'].body.data;
    expect(comparison.available).toBe(true);
    // Teacher decisions belong to a draft: draft 1 counts without its hidden correction, draft 2 is untouched.
    expect(comparison.issues).toEqual(expect.objectContaining({ previousCount: 4, currentCount: 5 }));
    await hideWord(fixture.IDS.registered, 'a', 'ART');
    comparison = (await studentSurfaces())['registered: draft comparison'].body.data;
    expect(comparison.issues).toEqual(expect.objectContaining({ previousCount: 4, currentCount: 4, newIssueCount: 0 }));
  });
});

describe('bug 2: a hidden correction must stay hidden after an AI regenerate', () => {
  const visibleAt = (body, start, end) => (body.data.corrections || []).filter(c => c.startChar < end && c.endChar > start);
  test.each([
    ['same span, new symbol (new id)', AI_SPECS.map(s => s[0] === 9 ? [9, 'PREP', 'GRAMMAR', 'an', 'Article before a vowel.'] : s)],
    ['wider span containing the hidden one (new id)', AI_SPECS.map(s => s[0] === 9 ? [[9, 10], 'ART', 'GRAMMAR', 'an apple', 'Article before a vowel.'] : s)],
  ])('%s', async (_label, specs) => {
    const hidden = await hideWord(fixture.IDS.guest, 'a', 'ART');
    await regenerateCorrections({ submissionId: fixture.IDS.guest, specs });
    const out = await studentSurfaces();
    const body = out['guest: ocr-corrections'].body;
    expect(visibleAt(body, hidden.startChar, hidden.endChar)).toEqual([]);
    expect(body.data.statistics).toEqual(expect.objectContaining({ grammar: 2, total: 4 }));
    // The teacher still sees it, as hidden.
    const snap = await teacher.snapshot(fixture.IDS.guest);
    expect(snap.body.data.corrections.filter(c => c.startChar < hidden.endChar && c.endChar > hidden.startChar)
      .map(c => c.moderationStatus)).toEqual(['hidden']);
  });
});

describe('bug 3: teacher work must survive an OCR re-run', () => {
  test('edits, hides and manual entries are re-anchored; entries whose text is gone become orphans for the teacher only', async () => {
    const id = fixture.IDS.registered;
    const dont = await teacher.find(id, 'dont', 'SP');
    expect((await teacher.act(id, { action: 'edit', id: dont.id, value: { ...manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS',
      message: 'Teacher: add the apostrophe.', suggestedText: "don't" }) } })).status).toBe(200);
    await hideWord(id, 'a', 'ART');
    expect((await teacher.act(id, { action: 'add', value: manualValue(fixture.registered, 'park', { message: 'Teacher manual note.' }) })).status).toBe(200);
    const realy = await teacher.find(id, 'realy', 'SP');
    expect((await teacher.act(id, { action: 'edit', id: realy.id, value: manualValue(fixture.registered, 'realy', { symbol: 'SP', category: 'MECHANICS',
      message: 'Teacher note on realy.', suggestedText: 'really' }) })).status).toBe(200);

    // OCR re-run: a word is added at the start (every offset moves) and "realy" is now read as "really".
    const words = ['Today', ...WORDS.map(w => w === 'realy' ? 'really' : w)];
    await rerunOcr({ submissionId: id, words, specs: AI_SPECS.filter(s => s[0] !== 22).map(([w, ...rest]) => [w + 1, ...rest]) });

    const out = await studentSurfaces();
    const corrections = out['registered: ocr-corrections'].body.data.corrections;
    const at = word => corrections.filter(c => c.quotedText === word);
    expect(at('dont').map(c => c.message)).toEqual(['Teacher: add the apostrophe.']);
    expect(at('a')).toEqual([]);
    expect(at('park').map(c => c.message)).toEqual(['Teacher manual note.']);
    expect(at('park')[0].startChar).toBe(words.slice(0, 5).join(' ').length + 1);
    expect(JSON.stringify(out)).not.toContain('Teacher note on realy.');
    expect(out['registered: ocr-corrections'].body.data.statistics).toEqual(expect.objectContaining({ grammar: 3, mechanics: 1, total: 4 }));

    const snap = (await teacher.snapshot(id)).body.data;
    expect(snap.corrections.filter(c => c.quotedText === 'a').map(c => c.moderationStatus)).toEqual(['hidden']);
    expect(snap.orphans.map(o => o.value.message)).toEqual(['Teacher note on realy.']);
  });
});

describe('bug 4: registered students must never receive hidden corrections', () => {
  test('no student surface contains the hidden correction or its message', async () => {
    const hidden = await hideWord(fixture.IDS.registered, 'a', 'ART');
    await hideWord(fixture.IDS.guest, 'a', 'ART');
    const out = await studentSurfaces();
    for (const [name, { body }] of Object.entries(out)) {
      // Compare in JSON-escaped form: the message contains quotes.
      const text = JSON.stringify(body);
      expect({ name, leaksMessage: text.includes(JSON.stringify(HIDDEN_MESSAGE).slice(1, -1)), leaksId: text.includes(hidden.id) }).toEqual({ name, leaksMessage: false, leaksId: false });
      for (const { key, items } of scan(body).lists) {
        expect({ name, key, hidden: items.filter(c => c.quotedText === 'a' && c.symbol === 'ART').length }).toEqual({ name, key, hidden: 0 });
      }
    }
  });
});
