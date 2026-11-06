'use strict';
// Draft comparison v2 (DRAFT_COMPARISON_V2_ENABLED): position-tolerant per-error tracking, the rubric-changed rule, the missing-overlay note,
// flag off = v1 payload, and no leak to students or guests. Synthetic data only.
process.env.JWT_SECRET = 'draft-comparison-v2-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/draft-comparison-v2';
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const { captureCurrentRevision } = require('../src/services/submissionRevision.service');
const { trackIssues, ITEM_CAP } = require('../src/services/draftIssueTracking.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const c = (category, symbol, quotedText, text, extra = {}) => ({ category, symbol, quotedText, suggestedText: extra.suggestedText ?? 'fix', startChar: text.indexOf(quotedText), endChar: text.indexOf(quotedText) + quotedText.length, ...extra });

describe('matching (pure)', () => {
  test('a reworded sentence without the error is fixed, with the revised sentence; an identical quote is remaining', () => {
    const prev = 'I goes to the park every day. The weather are nice.', cur = 'I go to the park every day. The weather are nice.';
    const r = trackIssues({ previousText: prev, currentText: cur,
      previousCorrections: [c('GRAMMAR', 'AGR', 'goes', prev, { suggestedText: 'go' }), c('GRAMMAR', 'AGR', 'weather are', prev)],
      currentCorrections: [c('GRAMMAR', 'AGR', 'weather are', cur)] });
    expect(r.counts).toEqual({ fixed: 1, remaining: 1, new: 0, unclear: 0 });
    expect(r.lists.fixed.items[0]).toEqual({ category: 'GRAMMAR', symbol: 'AGR', originalText: 'goes', previousSuggestion: 'go', status: 'fixed',
      revisedText: 'I go to the park every day.', explanation: 'This grammar issue no longer appears at this place in the new draft.' });
    expect(r.lists.remaining.items[0].status).toBe('remaining');
  });
  test('a reworded sentence that still has the error is remaining, not "fixed + new"', () => {
    const prev = 'Yesterday they is very happy about the trip.', cur = 'Yesterday they was really happy about the long trip.';
    const r = trackIssues({ previousText: prev, currentText: cur,
      previousCorrections: [c('GRAMMAR', 'AGR', 'they is', prev)], currentCorrections: [c('GRAMMAR', 'AGR', 'they was', cur)] });
    expect(r.counts).toEqual({ fixed: 0, remaining: 1, new: 0, unclear: 0 });
    expect(r.lists.remaining.items[0].explanation).toContain('The sentence was changed');
  });
  test('unchanged words that are simply not marked again are unclear, never fixed; a removed sentence is unclear', () => {
    const prev = 'My freind came home. Then we eated dinner together.', cur = 'My freind came home. We had a nice evening.';
    const r = trackIssues({ previousText: prev, currentText: cur,
      previousCorrections: [c('MECHANICS', 'SP', 'freind', prev), c('GRAMMAR', 'VF', 'eated', prev)], currentCorrections: [] });
    expect(r.counts).toEqual({ fixed: 0, remaining: 0, new: 0, unclear: 2 });
    expect(r.lists.unclear.items.map(i => i.explanation)).toEqual([expect.stringContaining('did not change'), expect.stringContaining('rewritten or removed')]);
  });
  test('a new error is new; two equally likely matches are unclear; lists are capped with a count of the rest', () => {
    const filler = ' Then we walked home and talked about the long and sunny afternoon together.'.repeat(12);
    const prev = `The dog run fast in the big park.${filler}`, cur = `The dog run fast in the big park. The dog run fast in the big park.${filler}`;
    const at = (text, from) => text.indexOf('run', from);
    const ambiguous = trackIssues({ previousText: prev, currentText: cur, previousCorrections: [c('GRAMMAR', 'VF', 'dog run fast', prev)],
      currentCorrections: [{ category: 'GRAMMAR', symbol: 'VF', quotedText: 'run', startChar: at(cur, 0), endChar: at(cur, 0) + 3 },
        { category: 'GRAMMAR', symbol: 'VF', quotedText: 'run', startChar: at(cur, 20), endChar: at(cur, 20) + 3 }] });
    expect(ambiguous.counts).toEqual({ fixed: 0, remaining: 0, new: 2, unclear: 1 });
    expect(ambiguous.lists.unclear.items[0].explanation).toContain('Several similar issues');
    const fresh = trackIssues({ previousText: 'All good here.', currentText: 'All good here. Me and him goes out.', previousCorrections: [],
      currentCorrections: [c('GRAMMAR', 'AGR', 'him goes', 'All good here. Me and him goes out.', { suggestedText: 'he goes' })] });
    expect(fresh.lists.new.items[0]).toEqual(expect.objectContaining({ status: 'new', suggestion: 'he goes', previousSuggestion: null }));
    const many = 'word '.repeat(400);
    const capped = trackIssues({ previousText: '', currentText: many, previousCorrections: [],
      currentCorrections: Array.from({ length: ITEM_CAP + 50 }, (_, i) => ({ category: 'MECHANICS', symbol: 'SP', quotedText: 'word', startChar: i * 5, endChar: i * 5 + 4 })) });
    expect(capped.lists.new).toEqual(expect.objectContaining({ total: 150, omitted: 50 }));
    expect(capped.lists.new.items).toHaveLength(ITEM_CAP);
    expect(capped.lists.new.items[0].status).toBe('new');
  });
});

describe('API', () => {
  const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
  let fixture, teacher;
  const studentJwt = () => signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  const asStudent = () => request(app).get(`/api/submissions/${fixture.IDS.registered}/draft-comparison`).set('Authorization', `Bearer ${studentJwt()}`);
  const asGuest = () => request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/drafts`).set('X-Guest-Token', fixture.guestToken);
  async function secondDraft(id) {
    await captureCurrentRevision(await Submission.findById(id));
    await Submission.updateOne({ _id: id }, { $set: { draftNumber: 2, fileContentIdentity: `v2-draft-2-${id}` } });
  }
  beforeAll(async () => { await connectInMemoryMongo(); });
  beforeEach(async () => {
    process.env.DRAFT_COMPARISON_V2_ENABLED = 'true';
    await mongoose.connection.dropDatabase(); await seedTestPlans(); await AnnotationAudit.createIndexes();
    fixture = await seedAnnotationFixture({ uploadRoot });
    teacher = annotationApi(app, fixture.teacher);
  });
  afterAll(async () => { delete process.env.DRAFT_COMPARISON_V2_ENABLED; await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

  test('flag off: exactly the v1 payload (no v2 fields)', async () => {
    await secondDraft(fixture.IDS.registered);
    process.env.DRAFT_COMPARISON_V2_ENABLED = 'false';
    const v1 = (await asStudent()).body.data;
    expect(v1.available).toBe(true);
    for (const key of ['comparisonVersion', 'issueDetails']) expect(v1).not.toHaveProperty(key);
    expect(v1.issues).not.toHaveProperty('unclearCount');
    expect(Object.keys(v1).sort()).toEqual(['available', 'currentDraftNumber', 'currentSubmissionId', 'currentText', 'identicalContent', 'issues',
      'issuesAvailable', 'issuesMessage', 'overall', 'previousDraftNumber', 'previousText', 'rubricCategories', 'rubricChanged', 'rubricMessage', 'summary']);
  });

  test('the teacher-effective set: a hidden correction is never "fixed" and a teacher-added one is new; lists carry no ids or offsets', async () => {
    await secondDraft(fixture.IDS.registered);
    const hidden = await teacher.find(fixture.IDS.registered, 'dont');
    expect((await teacher.act(fixture.IDS.registered, { action: 'hide', id: hidden.id })).status).toBe(200);
    expect((await teacher.act(fixture.IDS.registered, { action: 'add', value: manualValue(fixture.registered, 'park') })).status).toBe(200);
    const data = (await asStudent()).body.data;
    expect(data.comparisonVersion).toBe(2);
    const statuses = list => (list?.items || []).map(i => `${i.symbol}:${i.originalText}`);
    expect(statuses(data.issueDetails.fixed)).not.toContain(`${hidden.symbol}:dont`);
    expect(statuses(data.issueDetails.unclear)).toContain(`${hidden.symbol}:dont`);
    expect(statuses(data.issueDetails.new)).toContain('ART:park');
    expect(data.issues).toEqual(expect.objectContaining({ correctedCount: data.issueDetails.fixed.total, newIssueCount: data.issueDetails.new.total, unclearCount: data.issueDetails.unclear.total }));
    const json = JSON.stringify(data.issueDetails);
    for (const key of ['"id"', 'entryId', 'startChar', 'endChar', 'wordIds', 'Hash', 'teacher_']) expect(json).not.toContain(key);
  });

  test('rubric changed: scores stay, no improved/declined claim, summary limited', async () => {
    await secondDraft(fixture.IDS.registered);
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { evaluationRubricSourceHash: 'another-rubric' } });
    const data = (await asStudent()).body.data;
    expect(data.rubricChanged).toBe(true);
    expect(data.overall).toEqual(expect.objectContaining({ previousScore: 82, currentScore: 82, delta: null, status: 'RUBRIC_CHANGED' }));
    expect(data.summary).toEqual({ improved: false, unchanged: false, declined: false, limited: true });
  });

  test('an earlier snapshot without the teacher overlay (although the teacher changed that draft) is marked', async () => {
    await secondDraft(fixture.IDS.registered);
    await SubmissionRevision.updateMany({ sourceSubmissionId: fixture.IDS.registered }, { $unset: { teacherAnnotations: 1 } });
    await AnnotationAudit.create({ submissionId: fixture.IDS.registered, requestId: 'old-draft-change', requestHash: 'x', action: 'hide', actor: String(fixture.teacher._id),
      previousRevision: 0, newRevision: 1, draftNumber: 1, createdAt: new Date() });
    const data = (await asStudent()).body.data;
    expect(data.issuesAvailable).toBe(true);
    expect(data.issuesMessage).toContain('may include corrections your teacher hid');
  });

  test('guest link: same v2 payload, own drafts only, nothing internal', async () => {
    await secondDraft(fixture.IDS.guest);
    const res = await asGuest();
    expect(res.status).toBe(200);
    expect(res.body.data.comparisonVersion).toBe(2);
    const json = JSON.stringify(res.body);
    for (const term of ['previousSubmissionId', 'matchStrategy', 'teacherId', 'teacher@example.com', 'evaluationProvider', 'evaluationModel', 'analysisInputHash',
      'teacherAnnotations', 'teacherEvaluation', 'startChar', 'wordIds']) expect(json).not.toContain(term);
  });

  test('marks hidden from students stay hidden with v2', async () => {
    await secondDraft(fixture.IDS.registered);
    await require('../src/models/assignment.model').updateOne({ _id: fixture.IDS.assignment }, { $set: { showMarksToStudent: false } });
    const data = (await asStudent()).body.data;
    expect(data).toEqual(expect.objectContaining({ available: false, code: 'MARKS_HIDDEN' }));
    expect(data).not.toHaveProperty('issueDetails');
  });
});
