'use strict';
// Task 7G: a manual correction in a category with no AI corrections was counted in the statistics but had no "Areas for Improvement" card.
// The student view now adds one from the deterministic templates, with no score fields; stored feedback is untouched. Synthetic text only.
process.env.JWT_SECRET = 'annotation-card-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-card';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-card-pdf-'));
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Assignment = require('../src/models/assignment.model');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const MODES = ['registered', 'guest'];
const VOCABULARY = { symbol: 'WC', category: 'VOCABULARY', message: 'A more exact word fits here.', suggestedText: 'stroll' };
let fixture, teacher, list, seeded;
const binary = r => r.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
const seededDoc = mode => (mode === 'guest' ? fixture.guest : fixture.registered);
const feedbackOf = async mode => (await list[`${mode}: feedback`]()).body.data.detailedFeedback;
const card = (detailed, category = 'VOCABULARY') => detailed.areasForImprovement.filter(a => a.category === category && a.evidenceKind !== 'holistic');
const addManual = async (mode, word = 'park', options = VOCABULARY) => {
  const res = await teacher.act(fixture.IDS[mode], { action: 'add', value: manualValue(seededDoc(mode), word, options) });
  if (res.status !== 200) throw new Error(`${res.status} ${res.body.code}`);
  return (await teacher.snapshot(fixture.IDS[mode])).body.data.corrections.find(c => c.quotedText === word && c.category === options.category);
};
const pdfText = async res => { expect(res.status).toBe(200); return (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' '); };

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await require('../src/models/AnnotationAudit').init();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
  const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
  list.pdf = { registered: () => binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)),
    guest: () => binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken)) };
  seeded = { submissions: await Submission.collection.find({}).toArray(), feedback: await SubmissionFeedback.collection.find({}).toArray() };
});
beforeEach(async () => {
  await Submission.collection.deleteMany({}); await Submission.collection.insertMany(seeded.submissions);
  await SubmissionFeedback.collection.deleteMany({}); await SubmissionFeedback.collection.insertMany(seeded.feedback);
  await require('../src/models/AnnotationAudit').deleteMany({});
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.rmSync(process.env.PDF_FEEDBACK_CACHE_DIR, { recursive: true, force: true });
});

describe.each(MODES)('%s', (mode) => {
  test('no card before; a manual correction adds one with its action step, no score fields, stored feedback untouched', async () => {
    expect(card(await feedbackOf(mode))).toEqual([]);
    const before = JSON.stringify(await SubmissionFeedback.collection.find({}).sort({ _id: 1 }).toArray());
    const manual = await addManual(mode);
    const detailed = await feedbackOf(mode);
    expect(card(detailed)).toEqual([{ id: 'area_vocabulary', category: 'VOCABULARY', title: 'Vocabulary', issueCount: 1,
      explanation: '1 distinct issue affected this category. The main recorded pattern is WC.', dominantSymbols: ['WC'],
      examples: [expect.objectContaining({ correctionId: manual.id, symbol: 'WC', quotedText: 'park', message: VOCABULARY.message, suggestedText: 'stroll' })] }]);
    expect(card(detailed)[0]).not.toHaveProperty('score');
    expect(card(detailed)[0]).not.toHaveProperty('maxScore');
    expect(detailed.actionSteps.filter(s => s.category === 'VOCABULARY')).toEqual([expect.objectContaining({ id: 'action_vocabulary', priority: detailed.actionSteps.length,
      action: 'Revise the WC correction in the highlighted passages.', reason: '1 canonical vocabulary issue currently affect this category.', relatedSymbols: ['WC'], relatedCorrectionIds: [manual.id] })]);
    expect(JSON.stringify(await SubmissionFeedback.collection.find({}).sort({ _id: 1 }).toArray())).toBe(before);
  });

  test('add then remove: the card disappears, with its step', async () => {
    const manual = await addManual(mode);
    expect(card(await feedbackOf(mode))).toHaveLength(1);
    expect((await teacher.act(fixture.IDS[mode], { action: 'archive', id: manual.id })).status).toBe(200);
    const detailed = await feedbackOf(mode);
    expect(card(detailed)).toEqual([]);
    expect(detailed.actionSteps.filter(s => s.category === 'VOCABULARY')).toEqual([]);
  });

  test('a second correction restates the card; other categories keep theirs', async () => {
    await addManual(mode);
    await addManual(mode, 'home', { ...VOCABULARY, symbol: 'REP' });
    const detailed = await feedbackOf(mode);
    expect(card(detailed)[0]).toEqual(expect.objectContaining({ issueCount: 2, explanation: expect.stringMatching(/^2 distinct issues affected this category\./) }));
    expect(card(detailed, 'GRAMMAR')[0].issueCount).toBe(3);
    expect(card(detailed, 'MECHANICS')[0].issueCount).toBe(2);
  });

  test('a category that already has a card is not doubled', async () => {
    await addManual(mode, 'park', { symbol: 'ART', category: 'GRAMMAR', message: 'Teacher note.', suggestedText: 'the park' });
    const detailed = await feedbackOf(mode);
    expect(card(detailed, 'GRAMMAR')).toHaveLength(1);
    expect(card(detailed, 'GRAMMAR')[0].issueCount).toBe(4);
  });

  test('a holistic-only category keeps its holistic card and gains the counted one', async () => {
    await SubmissionFeedback.collection.updateOne({ submissionId: fixture.IDS[mode] }, { $push: {
      'detailedFeedback.areasForImprovement': { id: 'area_content_holistic', category: 'CONTENT', title: 'Content (holistic)', evidenceKind: 'holistic', issueCount: 0, score: 10, maxScore: 20,
        explanation: 'Holistic rubric feedback; no counted local correction.', dominantSymbols: [], examples: [] },
      'detailedFeedback.actionSteps': { id: 'action_content', priority: 9, category: 'CONTENT', evidenceKind: 'holistic', action: 'Develop the main idea.', reason: 'Holistic guidance.', relatedSymbols: [], relatedCorrectionIds: [] } } });
    await addManual(mode, 'park', { symbol: 'DEV', category: 'CONTENT', message: 'Develop this.', suggestedText: 'a nearby park' });
    const detailed = await feedbackOf(mode);
    const content = detailed.areasForImprovement.filter(a => a.category === 'CONTENT');
    expect(content.map(a => a.evidenceKind || 'counted').sort()).toEqual(['counted', 'holistic']);
    expect(content.find(a => a.evidenceKind === 'holistic').score).toBe(10);
    expect(detailed.actionSteps.filter(s => s.category === 'CONTENT').map(s => s.action)).toEqual(['Develop the main idea.', 'Revise the DEV correction in the highlighted passages.']);
  });

  test('hidden marks: the card is there, with no marks anywhere in it', async () => {
    await addManual(mode);
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { showMarksToStudent: false } });
    try {
      const detailed = await feedbackOf(mode);
      expect(card(detailed)).toHaveLength(1);
      for (const area of detailed.areasForImprovement) { expect(area).not.toHaveProperty('score'); expect(area).not.toHaveProperty('maxScore'); }
    } finally { await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $unset: { showMarksToStudent: 1 } }); }
  });

  test('the correction response carries the card too', async () => {
    await addManual(mode);
    const { data } = (await list[`${mode}: ocr-corrections`]()).body;
    expect(card(data.detailedFeedback)).toHaveLength(1);
    expect(data.evaluation.areasForImprovement.filter(a => a.category === 'VOCABULARY')).toHaveLength(1);
    expect(data.statistics.vocabulary).toBe(1);
  });

  test('the PDF shows the card, and no score for it', async () => {
    const before = await pdfText(await list.pdf[mode]());
    expect(before).not.toContain('1 distinct issue affected this category');
    await addManual(mode);
    const after = await pdfText(await list.pdf[mode]());
    expect(after).toContain('1 distinct issue affected this category. The main recorded pattern is WC.');
    expect(after).toContain('Revise the WC correction in the highlighted passages.');
    expect(after).not.toMatch(/Vocabulary - (undefined|NaN|0\/0)/);
  });
});

test('the guest results page carries the card', async () => {
  await addManual('guest');
  const { data } = (await list['guest: results']()).body;
  expect(card(data.feedback.detailedFeedback)).toHaveLength(1);
});

test('hiding every correction of a category that had a card still removes it', async () => {
  const id = fixture.IDS.registered;
  const snap = (await teacher.snapshot(id)).body.data.corrections.filter(c => c.category === 'MECHANICS');
  for (const c of snap) expect((await teacher.act(id, { action: 'hide', id: c.id })).status).toBe(200);
  expect(card(await feedbackOf('registered'), 'MECHANICS')).toEqual([]);
});
