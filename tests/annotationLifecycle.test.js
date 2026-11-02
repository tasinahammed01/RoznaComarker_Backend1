'use strict';
// Task 6A: annotation lifecycle (transition table), version 1 compatibility, validation and the builder's fail-closed rules,
// exercised on the deterministic fixture. Synthetic text only.
process.env.JWT_SECRET = 'annotation-lifecycle-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-lifecycle';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Submission = require('../src/models/Submission');
const policy = require('../src/services/teacherAnnotation.service');
const view = require('../src/services/studentCorrectionView.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedAnnotationFixture, regenerateCorrections, rerunOcr, AI_SPECS, WORDS } = require('./helpers/annotationFixture');
const { manualValue } = require('./helpers/annotationApi');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture;
beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => { await mongoose.connection.dropDatabase(); await seedTestPlans(); fixture = await seedAnnotationFixture({ uploadRoot }); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const load = () => Submission.findById(fixture.IDS.registered).select('+teacherAnnotations').lean();
const ai = (doc, word, symbol) => doc.writingCorrections.find(c => c.quotedText === word && (!symbol || c.symbol === symbol));
/** Applies one action through the service exactly as the controller does and persists the state. */
async function apply(body) {
  const doc = await load();
  const resolution = view.resolveOverlay(doc, doc.teacherAnnotations ?? null);
  const { sourceHash } = policy.source(doc);
  const result = policy.prepare(doc, fixture.teacher._id, { revision: policy.normalizeState(doc.teacherAnnotations).revision, sourceHash,
    requestId: crypto.randomUUID(), ...body }, { resolution });
  await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: result.state } });
  return result;
}
const attempt = body => apply(body).then(() => 'ok', error => error.code || error.message);
const studentView = async () => view.buildStudentCorrectionView(await load());

describe('transition table', () => {
  // Rows: starting state. Columns: action -> 'ok' or the refusal code. The table in the report is this table.
  const TABLE = {
    'ai-default': { hide: 'ok', archive: 'ok', edit: 'ok', restore: 'ANNOTATION_STATE_CONFLICT' },
    visible: { hide: 'ok', archive: 'ok', edit: 'ok', restore: 'ANNOTATION_STATE_CONFLICT' },
    hidden: { hide: 'ANNOTATION_STATE_CONFLICT', archive: 'ok', edit: 'ok', restore: 'ok' },
    archived: { hide: 'ANNOTATION_STATE_CONFLICT', archive: 'ANNOTATION_STATE_CONFLICT', edit: 'ANNOTATION_STATE_CONFLICT', restore: 'ok' },
  };
  const setups = {
    'ai-default': async () => {},
    visible: async id => { await apply({ action: 'hide', id }); await apply({ action: 'restore', id }); },
    hidden: async id => { await apply({ action: 'hide', id }); },
    archived: async id => { await apply({ action: 'archive', id }); },
  };
  for (const [state, row] of Object.entries(TABLE)) for (const [action, expected] of Object.entries(row)) {
    test(`${state} --${action}--> ${expected}`, async () => {
      const target = ai(await load(), 'dont');
      await setups[state](target.id);
      const body = { action, id: target.id, ...(action === 'edit' ? { value: manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS',
        message: 'Edited.', suggestedText: "don't" }) } : {}) };
      expect(await attempt(body)).toBe(expected);
    });
  }
  test('manual entries: add -> visible; hide, archive and restore follow the same table', async () => {
    const added = await apply({ action: 'add', value: manualValue(fixture.registered, 'park') });
    const id = added.auditRow.entryId;
    expect(id).toMatch(/^teacher_[0-9a-f-]{36}$/);
    expect(await attempt({ action: 'restore', id })).toBe('ANNOTATION_STATE_CONFLICT');
    expect(await attempt({ action: 'hide', id })).toBe('ok');
    expect((await studentView()).corrections.some(c => c.id === id)).toBe(false);
    expect(await attempt({ action: 'archive', id })).toBe('ok');
    expect(await attempt({ action: 'restore', id })).toBe('ok');
    expect((await studentView()).corrections.filter(c => c.id === id).map(c => c.source)).toEqual(['Teacher']);
  });
  test('`reject` (version 1 name) archives', async () => {
    const target = ai(await load(), 'dont');
    expect((await apply({ action: 'reject', id: target.id })).auditRow.action).toBe('archive');
    expect(policy.normalizeState((await load()).teacherAnnotations).entries[0].status).toBe('archived');
  });
  test('archived orphan: leaves the needs-review list, restore returns it to needs review, never to the student', async () => {
    const realy = ai(await load(), 'realy');
    await apply({ action: 'hide', id: realy.id });
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS.filter(s => s[0] !== 22) });
    const teacherView = async () => view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    const entryId = (await teacherView()).orphans[0].entryId;
    expect(await attempt({ action: 'archive', id: entryId })).toBe('ok');
    let v = await teacherView();
    expect(v.orphans).toEqual([]);
    expect(v.archivedOrphans.map(o => [o.entryId, o.status, o.reason])).toEqual([[entryId, 'archived', 'NO_MATCHING_CORRECTION']]);
    // Archived orphan table: only restore.
    for (const action of ['hide', 'archive']) expect(await attempt({ action, id: entryId })).toBe('ANNOTATION_ORPHANED');
    expect(await attempt({ action: 'edit', id: entryId, value: manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS' }) })).toBe('ANNOTATION_ORPHANED');
    expect(await attempt({ action: 'restore', id: entryId })).toBe('ok');
    v = await teacherView();
    expect(v.archivedOrphans).toEqual([]);
    expect(v.orphans.map(o => [o.entryId, o.status])).toEqual([[entryId, 'hidden']]);
    expect(v.corrections.some(c => c.quotedText === 'realy')).toBe(false);
    // Fail closed: the AI re-detects it after the restore, and it stays hidden from the student.
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS });
    v = await teacherView();
    expect(v.corrections.some(c => c.quotedText === 'realy')).toBe(false);
    expect(v.rows.filter(r => r.quotedText === 'realy').map(r => r.moderationStatus)).toEqual(['hidden']);
  });
  test('archived manual orphan: restore returns it to needs review; it is not shown while its text is gone', async () => {
    const added = await apply({ action: 'add', value: manualValue(fixture.registered, 'park', { message: 'Manual note.' }) });
    const id = added.auditRow.entryId;
    await rerunOcr({ submissionId: fixture.IDS.registered, words: WORDS.map(w => w === 'park' ? 'garden' : w), specs: AI_SPECS });
    expect(await attempt({ action: 'archive', id })).toBe('ok');
    let v = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(v.archivedOrphans.map(o => o.entryId)).toEqual([id]);
    expect(await attempt({ action: 'restore', id })).toBe('ok');
    v = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(v.orphans.map(o => [o.entryId, o.reason])).toEqual([[id, 'TEXT_NOT_FOUND']]);
    expect(v.corrections.some(c => c.message === 'Manual note.')).toBe(false);
  });
  test('a hidden entry that was edited: the teacher row has the edited text and flag; the student still gets nothing', async () => {
    const dont = ai(await load(), 'dont');
    const value = manualValue(fixture.registered, 'dont', { symbol: 'P', category: 'MECHANICS', message: 'Teacher wording.', suggestedText: "do not" });
    await apply({ action: 'edit', id: dont.id, value });
    await apply({ action: 'hide', id: dont.id });
    const teacher = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    const row = teacher.rows.find(r => r.id === dont.id);
    expect(row).toEqual(expect.objectContaining({ moderationStatus: 'hidden', teacherEdited: true, message: 'Teacher wording.', suggestedText: 'do not', symbol: 'P', quotedText: 'dont' }));
    expect(teacher.corrections.some(c => c.quotedText === 'dont')).toBe(false);
    expect(JSON.stringify(teacher.corrections)).not.toContain('Teacher wording.');
    expect(teacher.statistics).toEqual(expect.objectContaining({ mechanics: 1, total: 4 }));
    // Archived behaves the same; after an AI regenerate (new id) the row still carries the teacher's text.
    await apply({ action: 'archive', id: dont.id });
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS.map(s => s[0] === 13 ? [13, 'CAP', 'MECHANICS', "don't", 'AI again.'] : s) });
    const after = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(after.rows.filter(r => r.quotedText === 'dont').map(r => [r.moderationStatus, r.message, r.teacherEdited])).toEqual([['archived', 'Teacher wording.', true]]);
    expect(after.corrections.some(c => c.quotedText === 'dont')).toBe(false);
  });
  test('orphaned entries accept only edit (placed again) and archive', async () => {
    const realy = ai(await load(), 'realy');
    await apply({ action: 'hide', id: realy.id });
    // The AI no longer reports anything at that word: the hide has nothing to match and is listed for review.
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS.filter(s => s[0] !== 22) });
    const doc = await load();
    const teacher = view.buildStudentCorrectionView(doc, { audience: 'teacher' });
    expect(teacher.orphans.map(o => o.reason)).toEqual(['NO_MATCHING_CORRECTION']);
    const entryId = teacher.orphans[0].entryId;
    expect(await attempt({ action: 'restore', id: entryId })).toBe('ANNOTATION_ORPHANED');
    expect(await attempt({ action: 'hide', id: entryId })).toBe('ANNOTATION_ORPHANED');
    expect(await attempt({ action: 'archive', id: entryId })).toBe('ok');
  });
  test('scores are never changed by any action; substantive actions only raise the review flag', async () => {
    const Feedback = require('../src/models/SubmissionFeedback');
    const before = await Feedback.findOne({ submissionId: fixture.IDS.registered }).lean();
    const target = ai(await load(), 'goes', 'AGR');
    await apply({ action: 'hide', id: target.id });
    expect(policy.normalizeState((await load()).teacherAnnotations).scoringReviewRequired).toBe(false);
    await apply({ action: 'archive', id: target.id });
    expect(policy.normalizeState((await load()).teacherAnnotations).scoringReviewRequired).toBe(true);
    const after = await Feedback.findOne({ submissionId: fixture.IDS.registered }).lean();
    expect({ overall: after.overallScore, rubric: after.rubricScores }).toEqual({ overall: before.overallScore, rubric: before.rubricScores });
  });
});

describe('validation (field whitelist, category whitelist, span bounds, length caps)', () => {
  const edit = async (patch, body = {}) => {
    const target = ai(await load(), 'dont');
    return attempt({ action: 'edit', id: target.id, value: { ...manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS' }), ...patch }, ...body });
  };
  test.each([
    ['unknown value field', { bboxList: [{ x: 0 }] }, 'ANNOTATION_INVALID_FIELDS'],
    ['symbol not in the legend', { symbol: 'XYZ' }, 'ANNOTATION_INVALID_CATEGORY'],
    ['category that does not own the symbol', { category: 'GRAMMAR' }, 'ANNOTATION_INVALID_CATEGORY'],
    ['message over 2000 characters', { message: 'x'.repeat(2001) }, 'ANNOTATION_INVALID_TEXT'],
    ['suggestion over 2000 characters', { suggestedText: 'x'.repeat(2001) }, 'ANNOTATION_INVALID_TEXT'],
    ['blank message', { message: '   ' }, 'ANNOTATION_INVALID_TEXT'],
    ['control character', { message: 'bad\u0007bell' }, 'ANNOTATION_INVALID_TEXT'],
    ['quote that is not the transcript text', { quotedText: 'WRONG' }, 'ANNOTATION_INVALID_SPAN'],
    ['end before start', { endChar: 0 }, 'ANNOTATION_INVALID_SPAN'],
    ['span beyond the page', { startChar: 0, endChar: 100000 }, 'ANNOTATION_INVALID_SPAN'],
    ['non-integer offsets', { startChar: 1.5 }, 'ANNOTATION_INVALID_SPAN'],
    ['unknown file', { fileId: 'ffffffffffffffffffffffff' }, 'ANNOTATION_INVALID_SPAN'],
  ])('%s', async (_label, patch, code) => { expect(await edit(patch)).toBe(code); });
  test.each([
    ['unknown body field', { extra: 1 }, 'ANNOTATION_INVALID_FIELDS'],
    ['unknown action', { action: 'delete' }, 'ANNOTATION_INVALID_REQUEST'],
    ['malformed request id', { requestId: 'abc' }, 'ANNOTATION_INVALID_REQUEST'],
    ['non-integer revision', { revision: '0' }, 'ANNOTATION_INVALID_REQUEST'],
    ['stale revision', { revision: 5 }, 'ANNOTATION_REVISION_CONFLICT'],
    ['stale source', { sourceHash: 'x'.repeat(64) }, 'ANNOTATION_REVISION_CONFLICT'],
    ['payload over 16 kB', { value: { message: 'x'.repeat(17000) } }, 'ANNOTATION_PAYLOAD_TOO_LARGE'],
  ])('%s', async (_label, body, code) => { expect(await edit({}, body)).toBe(code); });
  test('a value on hide is refused; an unknown id is 404', async () => {
    const target = ai(await load(), 'dont');
    expect(await attempt({ action: 'hide', id: target.id, value: {} })).toBe('ANNOTATION_INVALID_FIELDS');
    expect(await attempt({ action: 'hide', id: 'ai_0000000000000000' })).toBe('ANNOTATION_NOT_FOUND');
  });
  test('text is stored raw (escaped only when rendered) and client geometry is never accepted', async () => {
    const html = '<img src=x onerror=alert(1)>Use the article';
    await apply({ action: 'add', value: manualValue(fixture.registered, 'park', { message: html }) });
    const shown = (await studentView()).corrections.find(c => c.source === 'Teacher');
    expect(shown.message).toBe(html);
    expect(shown.bboxList).toEqual([]);
    expect(shown.wordIds).toEqual([`word_${fixture.IDS.fileRegistered}_1_5`]);
  });
});

describe('version 1 overlays (stored before Task 6A)', () => {
  test('are read, applied and upgraded on the next write, with the old history kept', async () => {
    const doc = await load();
    const { sourceHash } = policy.source(doc);
    const target = ai(doc, 'a', 'ART');
    const v1 = { revision: 1, scoringReviewRequired: false,
      entries: [{ id: target.id, sourceHash, status: 'hidden', value: target, original: target }],
      audit: [{ requestId: crypto.randomUUID(), requestHash: 'h', action: 'hide', actor: String(fixture.teacher._id), correctionId: target.id,
        timestamp: '2026-09-01T00:00:00.000Z', previousRevision: 0, newRevision: 1, before: null, after: null, changedFields: [] }] };
    await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: v1 } });
    expect((await studentView()).corrections.some(c => c.id === target.id)).toBe(false);
    const state = policy.normalizeState(v1);
    expect(state.entries[0]).toEqual(expect.objectContaining({ kind: 'ai', status: 'hidden', targetId: target.id, legacy: true }));
    expect(state.legacyAudit).toHaveLength(1);
    const result = await apply({ action: 'restore', id: target.id });
    expect(result.state.version).toBe(2);
    expect(result.legacyAudit).toHaveLength(1);
    expect((await load()).teacherAnnotations.audit).toBeUndefined();
  });
  test('`rejected` reads as archived', () => {
    expect(policy.normalizeState({ revision: 1, entries: [{ id: 'ai_1', sourceHash: 'h', status: 'rejected', value: { startChar: 0, endChar: 1 } }] })
      .entries[0].status).toBe('archived');
  });
});

describe('builder: fail closed', () => {
  test('a submission whose overlay was not loaded is refused, never treated as "no overlay"', async () => {
    const plain = await Submission.findById(fixture.IDS.registered).lean();
    expect(() => view.buildStudentCorrectionView(plain)).toThrow('ANNOTATION_OVERLAY_NOT_LOADED');
    const document = await Submission.findById(fixture.IDS.registered);
    expect(() => view.buildStudentCorrectionView(document)).toThrow('ANNOTATION_OVERLAY_NOT_LOADED');
    expect(view.buildStudentCorrectionView(await Submission.findById(fixture.IDS.registered).select('+teacherAnnotations')).changed).toBe(false);
  });
  test('no entry changes the visible set: the same submission object and persisted statistics come back', async () => {
    const doc = await load();
    const target = ai(doc, 'dont');
    await apply({ action: 'hide', id: target.id }); await apply({ action: 'restore', id: target.id });
    const reloaded = await load();
    const v = view.buildStudentCorrectionView(reloaded);
    expect(v.changed).toBe(false);
    expect(v.corrections).toBe(reloaded.writingCorrections);
    expect(v.statistics).toBe(reloaded.correctionStatistics);
  });
  test('a hidden correction re-detected by a regenerate that changes EVERY id (version bump) stays hidden', async () => {
    const target = ai(await load(), 'a', 'ART');
    await apply({ action: 'hide', id: target.id });
    const canonical = require('../src/services/correctionCanonical.service');
    const version = canonical.VERSION;
    try { canonical.VERSION = `${version}-bumped`; await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS }); }
    finally { canonical.VERSION = version; }
    const doc = await load();
    expect(doc.writingCorrections.some(c => c.id === target.id)).toBe(false);
    const v = view.buildStudentCorrectionView(doc);
    expect(v.corrections.filter(c => c.quotedText === 'a')).toEqual([]);
    expect(v.statistics).toEqual(expect.objectContaining({ grammar: 2, total: 4 }));
  });
  test('a hidden entry overlapping two regenerated corrections suppresses both (fail closed, any category)', async () => {
    const target = ai(await load(), 'a', 'ART');
    await apply({ action: 'hide', id: target.id });
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: [...AI_SPECS.filter(s => s[0] !== 9),
      [[9, 10], 'ART', 'GRAMMAR', 'an apple', 'Article.'], [9, 'WC', 'VOCABULARY', 'one', 'Word choice.']] });
    const v = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(v.corrections.filter(c => c.startChar <= target.startChar && c.endChar >= target.endChar)).toEqual([]);
    expect(v.rows.filter(r => r.moderationStatus === 'hidden')).toHaveLength(2);
  });
  test('a teacher edit survives a regenerate and keeps its text; two edits claiming one correction are both orphaned', async () => {
    const dont = ai(await load(), 'dont');
    const value = manualValue(fixture.registered, 'dont', { symbol: 'SP', category: 'MECHANICS', message: 'Teacher wording.', suggestedText: "don't" });
    await apply({ action: 'edit', id: dont.id, value });
    await regenerateCorrections({ submissionId: fixture.IDS.registered, specs: AI_SPECS.map(s => s[0] === 13 ? [13, 'P', 'MECHANICS', "don't", 'AI wording.'] : s) });
    let v = view.buildStudentCorrectionView(await load());
    expect(v.corrections.filter(c => c.quotedText === 'dont').map(c => [c.message, c.teacherEdited])).toEqual([['Teacher wording.', true]]);
    // A second edit entry on the same span (e.g. made on another regenerate's id) conflicts with the first.
    const doc = await load();
    const state = policy.normalizeState(doc.teacherAnnotations);
    state.entries.push({ ...state.entries[0], id: 'ann_conflict', targetId: 'ai_gone', anchor: { ...state.entries[0].anchor, sourceHash: 'old' } });
    await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: state } });
    v = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(v.orphans.map(o => o.reason).sort()).toEqual(['CONFLICT', 'CONFLICT']);
    expect(v.corrections.filter(c => c.quotedText === 'dont').map(c => c.message)).toEqual(['AI wording.']);
  });
  test('legacy entries on a later draft: suppressions still apply, edits are orphaned (draft unknown)', async () => {
    const doc = await load();
    const hidden = ai(doc, 'a', 'ART'), edited = ai(doc, 'dont');
    const v1 = { revision: 2, entries: [{ id: hidden.id, sourceHash: 'older-evidence', status: 'hidden', value: hidden, original: hidden },
      { id: edited.id, sourceHash: 'older-evidence', status: 'visible', value: { ...edited, message: 'Legacy edit.' }, original: edited }] };
    await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: v1, draftNumber: 2 } });
    const v = view.buildStudentCorrectionView(await load(), { audience: 'teacher' });
    expect(v.corrections.some(c => c.quotedText === 'a')).toBe(false);
    expect(v.corrections.find(c => c.quotedText === 'dont').message).toBe('Missing apostrophe.');
    expect(v.orphans.map(o => o.reason)).toEqual(['LEGACY_DRAFT_UNKNOWN']);
  });
});

describe('student payload restatement', () => {
  test('examples, symbols, counts and the deterministic sentences follow the visible set; hidden ids vanish everywhere', async () => {
    const target = ai(await load(), 'a', 'ART');
    await apply({ action: 'hide', id: target.id });
    const v = view.buildStudentCorrectionView(await load());
    const Feedback = require('../src/models/SubmissionFeedback');
    const feedback = await Feedback.findOne({ submissionId: fixture.IDS.registered }).lean();
    const grammarBefore = feedback.detailedFeedback.areasForImprovement.find(a => a.category === 'GRAMMAR');
    expect(grammarBefore.examples.map(e => e.correctionId)).toContain(target.id);
    const out = view.studentPayload({ detailedFeedback: feedback.detailedFeedback, scoringAudit: feedback.scoringAudit }, v);
    const grammar = out.detailedFeedback.areasForImprovement.find(a => a.category === 'GRAMMAR');
    expect(grammar.issueCount).toBe(2);
    expect(grammar.dominantSymbols).toEqual(['AGR']);
    expect(grammar.explanation).toBe('2 distinct issues affected this category. The main recorded pattern is AGR.');
    expect(grammar.examples.map(e => e.correctionId)).not.toContain(target.id);
    const step = out.detailedFeedback.actionSteps.find(s => s.category === 'GRAMMAR');
    expect(step.action).toBe('Revise the AGR corrections in the highlighted passages.');
    expect(step.reason).toBe('2 canonical grammar issues currently affect this category.');
    expect(JSON.stringify(out)).not.toContain(target.id);
    expect(JSON.stringify(out)).not.toContain('before a vowel sound');
  });
  test('a category whose every correction is hidden loses its area and action step', async () => {
    const doc = await load();
    for (const c of doc.writingCorrections.filter(c => c.category === 'MECHANICS')) await apply({ action: 'hide', id: c.id });
    const v = view.buildStudentCorrectionView(await load());
    const feedback = await require('../src/models/SubmissionFeedback').findOne({ submissionId: fixture.IDS.registered }).lean();
    const out = view.studentPayload({ detailedFeedback: feedback.detailedFeedback }, v);
    expect(out.detailedFeedback.areasForImprovement.map(a => a.category)).toEqual(['GRAMMAR']);
    expect(out.detailedFeedback.actionSteps.map(a => a.category)).toEqual(['GRAMMAR']);
  });
});
