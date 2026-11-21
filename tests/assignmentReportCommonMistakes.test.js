'use strict';
// "Common mistakes" in the assignment report (Stage A, backend data): for each correction type, how many DISTINCT students made it, and a
// few anonymous example corrections, so the teacher can discuss them with the class.
// - Counts only what students see (studentCorrectionView): corrections the teacher removed are left out, edited text is used, corrections the
//   teacher added are included. The existing "Most common errors" card is unchanged (it still counts the stored AI analysis).
// - One student = the account for class members; a guest's email, as a one-way key held in memory only, for guests (several uploads of one
//   guest count once: the latest with current corrections). The email never reaches the response, the logs or the PDF.
// - Reads: the report's main read is unchanged; one extra read of the correction text (per 500 submissions); essays the teacher edited are
//   read again with their transcript, in batches of 20, at most 100 per report (beyond that: left out, partial: true, logged once).
// Synthetic data only; no AI or network call.
process.env.JWT_SECRET = 'assignment-report-common-mistakes-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/report-common-mistakes-${process.pid}`;
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
jest.mock('../src/services/email.service', () => ({}));
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi, manualValue } = require('./helpers/annotationApi');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const report = require('../src/services/assignmentReport.service');
const { renderAssignmentReportHtml } = require('../src/pdf/assignmentReportTemplate');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const GUEST_EMAIL = 'guest.student@example.com';   // the fixture guest's address
const LEGEND = { groups: [{ key: 'GRAMMAR', symbols: [{ symbol: 'AGR', label: 'Subject-Verb Agreement' }, { symbol: 'ART', label: 'Article Use' },
  { symbol: 'VF', label: 'Verb Form' }] }, { key: 'MECHANICS', symbols: [{ symbol: 'SP', label: 'Spelling' }] }] };

// ---- The pure rules (commonMistakesOf) -----------------------------------------------------------------------------------------------
describe('commonMistakesOf: counting, thresholds, sorting, examples', () => {
  const c = (symbol, original, corrected = 'fixed', explanation = 'Because.', category = 'GRAMMAR') =>
    ({ symbol, category, quotedText: original, suggestedText: corrected, message: explanation });
  const entry = (key, corrections, at = '2026-11-10T09:00:00Z', submissionId = `${key}-sub`) => ({ key, submissionId, submittedAt: new Date(at), corrections });
  const of = (entries, options) => report.commonMistakesOf(entries, LEGEND, options);

  test('a student with the same mistake many times counts once; occurrences count every time', () => {
    const out = of([entry('u:a', [c('AGR', 'goes'), c('AGR', 'has'), c('AGR', 'runs')]), entry('u:b', [c('AGR', 'walks')])]);
    expect(out.types[0]).toEqual(expect.objectContaining({ typeCode: 'AGR', label: 'Subject-Verb Agreement', category: 'GRAMMAR', studentCount: 2,
      totalStudents: 2, occurrenceCount: 4, isCommon: true }));
  });

  test('one student with several submissions (a guest uploading twice) counts once, with the latest submission only', () => {
    const out = of([entry('g:x', [c('VF', 'old one')], '2026-11-01T09:00:00Z', 'old'), entry('g:x', [c('AGR', 'goes')], '2026-11-09T09:00:00Z', 'new'),
      entry('u:b', [c('AGR', 'has'), c('VF', 'builded')])]);
    expect(out.totalStudents).toBe(2);
    expect(out.types.find(t => t.typeCode === 'AGR').studentCount).toBe(2);
    expect(out.types.find(t => t.typeCode === 'VF').studentCount).toBe(1);   // the guest's older VF is not counted
    expect(JSON.stringify(out)).not.toContain('old one');
  });

  test('thresholds and states: fewer than 2 students; nothing shared; isCommon exactly at 2', () => {
    expect(of([entry('u:a', [c('AGR', 'goes')])])).toEqual(expect.objectContaining({ state: 'not_enough_students', totalStudents: 1, minStudents: 2, types: [] }));
    expect(of([])).toEqual(expect.objectContaining({ state: 'not_enough_students', totalStudents: 0, types: [] }));
    expect(of([entry('u:a', [c('AGR', 'goes')]), entry('u:b', [c('SP', 'teh')])])).toEqual(expect.objectContaining({ state: 'none_shared', totalStudents: 2, types: [] }));
    const ok = of([entry('u:a', [c('AGR', 'goes'), c('SP', 'teh')]), entry('u:b', [c('AGR', 'has')])]);
    expect(ok.state).toBe('ok');
    expect(ok.types.map(t => [t.typeCode, t.studentCount, t.isCommon])).toEqual([['AGR', 2, true], ['SP', 1, false]]);
    expect(ok.types.find(t => t.typeCode === 'SP').examples).toEqual([]);   // no examples for a mistake only one student made
  });

  test('sorted by students, then occurrences, then type code; the top 5 only', () => {
    const students = ['a', 'b', 'c', 'd'].map(k => `u:${k}`);
    const list = { 'u:a': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], 'u:b': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], 'u:c': ['A1', 'A2'], 'u:d': ['A1', 'A3', 'A3'] };
    const out = of(students.map(k => entry(k, list[k].map(s => c(s, `${s} ${k}`)))));
    expect(out.types.map(t => [t.typeCode, t.studentCount, t.occurrenceCount])).toEqual([['A1', 4, 4], ['A3', 3, 4], ['A2', 3, 3], ['A4', 2, 2], ['A5', 2, 2]]);
  });

  test('examples: at most 3, duplicates removed, different students first, shorter first, text cleaned and capped', () => {
    const long = 'x'.repeat(200);
    const out = of([
      entry('u:a', [c('AGR', 'He go', 'He goes'), c('AGR', 'he  GO', 'He goes'), c('AGR', 'a', 'b'), c('AGR', long, long, long)]),
      entry('u:b', [c('AGR', 'They goes', 'They go', 'Plural subject.\u0007')]),
      entry('u:c', [c('AGR', 'She have\nlived', 'She has lived', '')])]);
    const ex = out.types[0].examples;
    expect(ex).toHaveLength(3);
    // One per student first (each student's shortest), then any remaining; never the same text twice.
    expect(ex.map(e => e.original)).toEqual(['a', 'They goes', 'She have lived']);
    expect(ex[1]).toEqual({ original: 'They goes', corrected: 'They go', explanation: 'Plural subject.' });
    expect(ex[2]).toEqual({ original: 'She have lived', corrected: 'She has lived', explanation: '' });
    const capped = of([entry('u:a', [c('AGR', long, long, long)]), entry('u:b', [c('AGR', long, long, long)])]).types[0].examples[0];
    expect(capped.original.length).toBe(80);
    expect(capped.original.endsWith('…')).toBe(true);
    expect(capped.explanation.length).toBe(160);
  });

  test('an example with no replacement keeps the original and the explanation; one with no original is skipped', () => {
    const out = of([entry('u:a', [c('AGR', 'goes', '', 'Missing word.'), c('AGR', '', 'x')]), entry('u:b', [c('AGR', '   ', 'y')])]);
    expect(out.types[0].studentCount).toBe(2);
    expect(out.types[0].examples).toEqual([{ original: 'goes', corrected: '', explanation: 'Missing word.' }]);
  });

  test('examples carry only original, corrected and explanation: never a key, an id or anything else from the correction', () => {
    const out = of([entry('u:secret-student-id', [{ ...c('AGR', 'goes'), id: 'corr-secret', startChar: 3, source: 'AI' }]), entry('g:secret-guest-key', [c('AGR', 'has')])]);
    expect(Object.keys(out.types[0].examples[0]).sort()).toEqual(['corrected', 'explanation', 'original']);
    expect(JSON.stringify(out)).not.toMatch(/secret-student-id|secret-guest-key|sub|corr-secret|startChar|source/);
  });

  test('partial is passed through as given', () => {
    expect(of([], { partial: true }).partial).toBe(true);
    expect(of([]).partial).toBe(false);
  });
});

// ---- From the database: what students see, guests, privacy, reads --------------------------------------------------------------------
describe('the report from the database', () => {
  let fixture, teacher;
  beforeAll(async () => { await connectInMemoryMongo(); });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase(); await seedTestPlans(); await AnnotationAudit.createIndexes();
    fixture = await seedAnnotationFixture({ uploadRoot });
    teacher = annotationApi(app, fixture.teacher);
    jest.restoreAllMocks();
  });
  afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
  const load = () => report.loadAssignmentReport({ teacherId: fixture.teacher._id, assignmentId: fixture.assignment._id });
  const typeOf = (r, code) => r.commonMistakes.types.find(t => t.typeCode === code);
  const find = (id, word, symbol) => teacher.find(id, word, symbol);

  test('both students made each mistake: counts, labels and anonymous examples; the existing "Most common errors" numbers are unchanged', async () => {
    const r = await load();
    expect(r.commonMistakes).toEqual(expect.objectContaining({ basis: 'visible_corrections', state: 'ok', totalStudents: 2, minStudents: 2, partial: false }));
    expect(r.commonMistakes.types.map(t => [t.typeCode, t.studentCount, t.occurrenceCount, t.isCommon])).toEqual([['AGR', 2, 4, true], ['SP', 2, 4, true], ['ART', 2, 2, true]]);
    expect(typeOf(r, 'AGR')).toEqual(expect.objectContaining({ label: 'Subject–Verb Agreement', category: 'GRAMMAR', totalStudents: 2 }));
    expect(typeOf(r, 'ART').examples).toEqual([{ original: 'a', corrected: 'an', explanation: 'Use "an" before a vowel sound.' }]);
    expect(r.errors.symbols.map(s => [s.symbol, s.count])).toEqual([['AGR', 4], ['SP', 4], ['ART', 2]]);
  });

  test('a correction the teacher removed is not counted; the existing card still counts it', async () => {
    expect((await teacher.act(fixture.IDS.guest, { action: 'hide', id: (await find(fixture.IDS.guest, 'a', 'ART')).id })).status).toBe(200);
    const r = await load();
    expect(typeOf(r, 'ART')).toEqual(expect.objectContaining({ studentCount: 1, occurrenceCount: 1, isCommon: false, examples: [] }));
    expect(r.errors.symbols.find(s => s.symbol === 'ART').count).toBe(2);
  });

  test('archived (removed) corrections are left out the same way', async () => {
    const id = (await find(fixture.IDS.registered, 'a', 'ART')).id;
    expect((await teacher.act(fixture.IDS.registered, { action: 'archive', id })).status).toBe(200);
    expect(typeOf(await load(), 'ART').studentCount).toBe(1);
  });

  test('edited text is what the examples show; a correction the teacher added is counted', async () => {
    const dont = await find(fixture.IDS.registered, 'dont', 'SP');
    expect((await teacher.act(fixture.IDS.registered, { action: 'edit', id: dont.id, value: { ...manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS',
      suggestedText: 'do not', message: 'Teacher wording.' }) } })).status).toBe(200);
    for (const [id, doc] of [[fixture.IDS.registered, fixture.registered], [fixture.IDS.guest, fixture.guest]]) {
      expect((await teacher.act(id, { action: 'add', value: manualValue(doc, 'park', { symbol: 'VF', category: 'GRAMMAR', suggestedText: 'parks', message: 'Teacher added.' }) })).status).toBe(200);
    }
    const r = await load();
    expect(typeOf(r, 'SP').examples).toEqual(expect.arrayContaining([{ original: 'dont', corrected: 'do not', explanation: 'Teacher wording.' }]));
    expect(typeOf(r, 'VF')).toEqual(expect.objectContaining({ studentCount: 2, occurrenceCount: 2, isCommon: true,
      examples: [{ original: 'park', corrected: 'parks', explanation: 'Teacher added.' }] }));
  });

  test('the section has no student name, email, student id or submission id; the guest email is not in the response, the logs or the PDF HTML', async () => {
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'metric']) jest.spyOn(logger, level).mockImplementation(entry => { lines.push(JSON.stringify(entry)); });
    await teacher.act(fixture.IDS.guest, { action: 'hide', id: (await find(fixture.IDS.guest, 'dont', 'SP')).id });   // forces the edited path too
    const res = await request(app).get(`/api/assignments/${fixture.assignment._id}/report`)
      .set('Authorization', `Bearer ${signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid })}`);
    expect(res.status).toBe(200);
    const section = JSON.stringify(res.body.data.commonMistakes);
    for (const secret of ['Guest Student', '"Student"', String(fixture.IDS.registered), String(fixture.IDS.guest), String(fixture.IDS.student), '@'])
      expect(section).not.toContain(secret);
    const html = renderAssignmentReportHtml(res.body.data);
    for (const where of [JSON.stringify(res.body), lines.join('\n'), html]) {
      expect(where).not.toContain(GUEST_EMAIL);
      expect(where).not.toMatch(/normalizedEmail/);
    }
  });

  test('reads: the main read is unchanged, then exactly one read of the correction text (no sort, exact fields), and no transcript read when nothing was edited', async () => {
    const real = Submission.find.bind(Submission), queries = [];
    jest.spyOn(Submission, 'find').mockImplementation((...args) => { const q = real(...args); queries.push(q); return q; });
    await load();
    expect(queries).toHaveLength(2);
    expect(Object.keys(queries[0].projection()).sort()).toEqual([...report.SUBMISSION_FIELDS].sort());
    expect(Object.keys(queries[1].projection()).sort()).toEqual([...report.CORRECTION_TEXT_FIELDS].sort());
    expect(report.CORRECTION_TEXT_FIELDS).toEqual(['_id', 'draftNumber', 'teacherAnnotations', 'guest.normalizedEmail', 'writingCorrections.id',
      'writingCorrections.symbol', 'writingCorrections.category', 'writingCorrections.quotedText', 'writingCorrections.suggestedText',
      'writingCorrections.message', 'writingCorrections.source']);
    for (const q of queries) expect(q.getOptions().sort).toBeUndefined();
    for (const heavy of ['ocrPages', 'ocrData', 'transcriptText', 'combinedOcrText', 'transcriptPages', 'writingCorrections'])
      expect(Object.prototype.hasOwnProperty.call(queries[1].projection(), heavy)).toBe(false);
  });

  // Many edited essays: copies of the fixture's registered essay after the teacher hid one correction, each a separate guest.
  async function editedCopies(n, { sameGuest = false } = {}) {
    await teacher.act(fixture.IDS.registered, { action: 'hide', id: (await find(fixture.IDS.registered, 'a', 'ART')).id });
    const source = await Submission.collection.findOne({ _id: fixture.IDS.registered });
    const feedback = await SubmissionFeedback.collection.findOne({ submissionId: fixture.IDS.registered });
    const copies = [];
    for (let i = 0; i < n; i++) {
      const _id = new mongoose.Types.ObjectId();
      const { student: _student, ...rest } = source;
      copies.push({ ...rest, _id, submissionMode: 'guest', submittedAt: new Date(Date.UTC(2026, 9, 2, 0, i)),
        guest: { displayName: `Copy ${i}`, normalizedEmail: sameGuest ? 'same.guest@example.com' : `copy${i}@example.com` } });
      await SubmissionFeedback.collection.insertOne({ ...feedback, _id: new mongoose.Types.ObjectId(), submissionId: _id, submissionMode: 'guest', studentId: undefined });
    }
    await Submission.collection.insertMany(copies);
    return copies;
  }
  function spyReads() {
    const real = Submission.find.bind(Submission), queries = [];
    jest.spyOn(Submission, 'find').mockImplementation((...args) => { const q = real(...args); queries.push(q); return q; });
    return queries;
  }

  test('edited essays are read with their transcript in batches of 20 (exact fields, no sort); only those', async () => {
    await editedCopies(44);   // + the edited original = 45 edited essays
    const queries = spyReads();
    const r = await load();
    const transcriptReads = queries.slice(2);
    expect(transcriptReads.map(q => q.getFilter()._id.$in.length)).toEqual([20, 20, 5]);
    for (const q of transcriptReads) {
      expect(Object.keys(q.projection()).sort()).toEqual([...report.EDITED_FIELDS].sort());
      expect(q.getOptions().sort).toBeUndefined();
    }
    expect(r.commonMistakes.partial).toBe(false);
    expect(r.commonMistakes.totalStudents).toBe(46);
    expect(typeOf(r, 'ART').studentCount).toBe(1);   // the 45 edited essays hid their ART; only the guest's remains
    expect(JSON.stringify(r)).not.toMatch(/"words"|ocrPages|transcriptText/);
  });

  test('more than 100 edited essays: those beyond the cap are left out (never counted with removed corrections), partial: true, logged once', async () => {
    await editedCopies(104);   // 105 edited essays
    const warnings = [];
    jest.spyOn(logger, 'warn').mockImplementation(entry => { warnings.push(entry); });
    const queries = spyReads();
    const r = await load();
    expect(queries.slice(2).map(q => q.getFilter()._id.$in.length)).toEqual([20, 20, 20, 20, 20]);
    expect(r.commonMistakes.partial).toBe(true);
    expect(r.commonMistakes.totalStudents).toBe(101);   // 100 edited + the guest; the 5 left out are not counted at all
    const capped = warnings.filter(w => w.event === 'assignment_report_common_mistakes_partial');
    expect(capped).toEqual([{ event: 'assignment_report_common_mistakes_partial', code: 'COMMON_MISTAKES_EDITED_CAP', assignmentId: String(fixture.assignment._id),
      edited: 105, cap: 100 }]);
  });

  test('several uploads by one guest count once (the latest), by a one-way key of the email', async () => {
    await editedCopies(3, { sameGuest: true });
    const r = await load();
    expect(r.commonMistakes.totalStudents).toBe(3);   // the class member, the fixture guest, and the three copies as one guest
  });
});
