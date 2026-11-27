'use strict';
// The internal similarity index and comparison (services/similarity/internal.service.js): hashes only, never the same essay or the same
// student's essay for the same task, the brief, reference files, quotes and the task's common phrasing removed, scope by teacher or
// institution, deleted essays ignored. Synthetic generated words only.
process.env.JWT_SECRET = 'similarity-internal-secret';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const SimilarityFingerprint = require('../src/models/SimilarityFingerprint');
const Submission = require('../src/models/Submission');
const ReferenceFile = require('../src/models/ReferenceFile');
const internal = require('../src/services/similarity/internal.service');
const { words, classWithEssay, student, essay, exactEssay } = require('./helpers/similarityFixtures');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(clearDatabase);

const SETTINGS = Object.freeze({ minMatchWords: 8, excludeQuotes: true, internalScope: 'all', commonSharePercent: 30, commonMinEssays: 5 });
const ENABLED = { SIMILARITY_ENABLED: 'true' };

async function compare(submission, settings = SETTINGS) {
  const essayData = await internal.loadEssay(submission._id);
  const blocked = await internal.blockedMask(essayData, settings);
  return internal.compareInternal(essayData, blocked, settings);
}

describe('loadEssay and indexSubmission', () => {
  test('stores hashes, counts and an owner key only: no text, no email', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const sub = await essay({ ...a, studentUser: s.user, text: words('a', 60) });
    const guest = await essay({ ...a, guestEmail: 'guest.person@example.com', text: words('b', 30) });
    await internal.indexSubmission(sub._id);
    await internal.indexSubmission(guest._id);
    const fp = await SimilarityFingerprint.findOne({ submissionId: sub._id }).lean();
    expect(fp).toMatchObject({ words: 60, ownerKey: `student:${s.user._id}`, teacherId: a.teacher.user._id, assignmentId: a.assignment._id });
    expect(fp.allHashes).toHaveLength(60);
    expect(fp.hashes.length).toBeGreaterThan(0);
    expect(fp.hashes.length).toBeLessThan(60);
    const g = await SimilarityFingerprint.findOne({ submissionId: guest._id }).lean();
    expect(g.ownerKey).toMatch(/^guest:[a-f0-9]{24}$/);
    expect(JSON.stringify([fp, g])).not.toMatch(/qa1|qb1|guest\.person|example\.com/);
  });
  test('indexing again replaces the fingerprint (one per submission)', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const sub = await essay({ ...a, studentUser: s.user, text: words('a', 20) });
    await internal.indexSubmission(sub._id);
    const next = words('z', 30);
    await Submission.updateOne({ _id: sub._id }, { $set: { 'ocrPages.0.text': next, 'ocrPages.0.words': next.split(' ').map((w, i) => ({ id: `w${i}`, text: w, page: 1 })) } });
    await internal.indexSubmission(sub._id);
    expect(await SimilarityFingerprint.countDocuments({ submissionId: sub._id })).toBe(1);
    expect((await SimilarityFingerprint.findOne({ submissionId: sub._id }).lean()).words).toBe(30);
  });
  test('an exact transcript is used only when it is eligible; an ineligible one removes the old fingerprint', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const ok = await exactEssay({ ...a, studentUser: s.user, pages: [words('p', 10), words('r', 10)] });
    const loaded = await internal.loadEssay(ok._id);
    expect(loaded).toMatchObject({ eligible: true, origin: 'exact' });
    expect(loaded.tokens[10].page).toBe(1);
    const s2 = await student(a.klass, 's2');
    const bad = await exactEssay({ ...a, studentUser: s2.user, pages: [words('p', 10), words('r', 10)], eligible: false });
    await SimilarityFingerprint.create({ submissionId: bad._id, assignmentId: a.assignment._id, classId: a.klass._id, teacherId: a.teacher.user._id,
      ownerKey: 'student:x', textSha256: 'x', words: 1, indexedAt: new Date() });
    expect((await internal.loadEssay(bad._id)).eligible).toBe(false);
    expect(await internal.indexSubmission(bad._id)).toBeNull();
    expect(await SimilarityFingerprint.countDocuments({ submissionId: bad._id })).toBe(0);
  });
  test('speaking (audio) submissions are not essays', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const sub = await essay({ ...a, studentUser: s.user, text: words('a', 20), extra: { sourceKind: 'audio' } });
    expect(await internal.loadEssay(sub._id)).toBeNull();
    expect(await internal.indexSubmission(sub._id)).toBeNull();
  });
  test('onAssessmentComplete indexes only while the feature is on, and never throws', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const sub = await essay({ ...a, studentUser: s.user, text: words('a', 20) });
    await internal.onAssessmentComplete(sub._id, {});
    expect(await SimilarityFingerprint.countDocuments()).toBe(0);
    await internal.onAssessmentComplete(sub._id, ENABLED);
    expect(await SimilarityFingerprint.countDocuments()).toBe(1);
    await expect(internal.onAssessmentComplete(new mongoose.Types.ObjectId(), ENABLED)).resolves.toBeUndefined();
    await expect(internal.onAssessmentComplete('not-an-id', ENABLED)).resolves.toBeUndefined();
  });
  test('the assessment completion path calls the hook after the submission is marked complete', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/assessmentCompletion.service.js'), 'utf8');
    const marked = source.indexOf("assessmentStatus: 'complete'");
    const hook = source.indexOf('similarity/internal.service');
    expect(marked).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(marked);
  });
});

describe('compareInternal', () => {
  async function pair({ sharedText = words('s', 20), otherClass = true, otherText } = {}) {
    const a = await classWithEssay({ label: 'a' });
    const b = otherClass ? await classWithEssay({ label: 'b' }) : a;
    const sa = await student(a.klass, 'sa');
    const sb = await student(b.klass, 'sb');
    const mine = await essay({ ...a, studentUser: sa.user, text: `${words('a', 30)} ${sharedText} ${words('a', 30, 30)}` });
    const theirs = await essay({ ...b, studentUser: sb.user, text: otherText || `${words('b', 10)} ${sharedText} ${words('b', 10, 10)}` });
    await internal.indexSubmission(theirs._id);
    await internal.indexSubmission(mine._id);
    return { a, b, mine, theirs, sa, sb };
  }

  test('finds a 20-word passage in another teacher\'s essay, with its spans on this essay', async () => {
    const { mine, theirs, b } = await pair();
    const sources = await compare(mine);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'internal', refSubmissionId: theirs._id, refTeacherId: b.teacher.user._id, sameStudent: false });
    expect(sources[0].spans.map(s => [s.wordStart, s.wordEnd])).toEqual([[30, 50]]);
  });
  test('never the essay itself; nothing shared, nothing found', async () => {
    const a = await classWithEssay();
    const s = await student(a.klass);
    const only = await essay({ ...a, studentUser: s.user, text: words('a', 40) });
    await internal.indexSubmission(only._id);
    expect(await compare(only)).toEqual([]);
  });
  test('the same student (same guest email) on the same task is not a source; on another task it is, marked sameStudent', async () => {
    const a = await classWithEssay();
    const shared = words('s', 20);
    const first = await essay({ ...a, guestEmail: 'same@example.com', text: `${words('a', 10)} ${shared}` });
    const second = await essay({ ...a, guestEmail: 'same@example.com', text: `${words('b', 10)} ${shared}` });
    await internal.indexSubmission(first._id);
    await internal.indexSubmission(second._id);
    expect(await compare(second)).toEqual([]);
    const other = await classWithEssay({ teacher: a.teacher, label: 'other-task' });
    const third = await essay({ klass: other.klass, assignment: other.assignment, guestEmail: 'same@example.com', text: `${words('c', 10)} ${shared}` });
    await internal.indexSubmission(third._id);
    const sources = await compare(third);
    expect(sources).toHaveLength(2);
    expect(sources.every(x => x.sameStudent)).toBe(true);
  });
  test('words of the brief or of a reference file are not matches', async () => {
    const brief = words('brief', 20);
    const a = await classWithEssay({ instructions: brief });
    const sa = await student(a.klass, 'sa');
    const sb = await student(a.klass, 'sb');
    const mine = await essay({ ...a, studentUser: sa.user, text: `${words('a', 20)} ${brief} ${words('a', 20, 20)}` });
    const theirs = await essay({ ...a, studentUser: sb.user, text: `${words('b', 20)} ${brief}` });
    await internal.indexSubmission(theirs._id);
    expect(await compare(mine)).toEqual([]);
    const refText = words('ref', 20);
    const refBase = { owner: a.teacher.user._id, class: a.klass._id, file: new mongoose.Types.ObjectId(), originalName: 'notes.pdf', kind: 'pdf',
      sizeBytes: 10, status: 'ready' };
    await ReferenceFile.create({ ...refBase, scope: 'assignment', assignment: a.assignment._id, requestId: 'r1', text: refText,
      activeSlot: `assignment:${a.assignment._id}:0` });
    // a removed file (no active slot) and another class's file do not count
    const goneText = words('gone', 20);
    await ReferenceFile.create({ ...refBase, scope: 'class', requestId: 'r2', text: goneText });
    const mine2 = await essay({ ...a, studentUser: (await student(a.klass, 'sc')).user, text: `${words('c', 20)} ${refText}` });
    const theirs2 = await essay({ ...a, studentUser: (await student(a.klass, 'sd')).user, text: `${words('d', 20)} ${refText}` });
    await internal.indexSubmission(theirs2._id);
    expect(await compare(mine2)).toEqual([]);
    const mine3 = await essay({ ...a, studentUser: (await student(a.klass, 'se')).user, text: `${words('e', 20)} ${goneText}` });
    const theirs3 = await essay({ ...a, studentUser: (await student(a.klass, 'sf')).user, text: `${words('f', 20)} ${goneText}` });
    await internal.indexSubmission(theirs3._id);
    expect(await compare(mine3)).toHaveLength(1);
  });
  test('quoted words are not matches while quotes are excluded (the default), and are when the setting is off', async () => {
    const quoted = `“${words('s', 20)}”`;
    const { mine } = await pair({ sharedText: quoted });
    expect(await compare(mine)).toEqual([]);
    expect(await compare(mine, { ...SETTINGS, excludeQuotes: false })).toHaveLength(1);
  });
  test('phrasing in 30% or more of the task\'s essays (at least 5 essays) is common, not a match; below 5 essays it still counts', async () => {
    const a = await classWithEssay();
    const common = words('c', 12);
    const subs = [];
    for (let i = 0; i < 4; i++) {
      const s = await student(a.klass, `s${i}`);
      subs.push(await essay({ ...a, studentUser: s.user, text: `${words(`e${i}`, 15)} ${common} ${words(`e${i}`, 15, 15)}` }));
    }
    for (const sub of subs) await internal.indexSubmission(sub._id);
    expect(await compare(subs[0])).toHaveLength(3);            // 4 essays: below the minimum of 5, still matches
    const s = await student(a.klass, 's4');
    subs.push(await essay({ ...a, studentUser: s.user, text: `${words('e4', 15)} ${common}` }));
    await internal.indexSubmission(subs[4]._id);
    expect(await compare(subs[0])).toEqual([]);                // 5 of 5 essays: common phrasing for this task
  });
  test('scope own: only the teacher\'s own classes; institution: the same institution only', async () => {
    const { mine } = await pair();
    expect(await compare(mine, { ...SETTINGS, internalScope: 'own' })).toEqual([]);
    const inst = new mongoose.Types.ObjectId();
    const a = await classWithEssay({ institutionId: inst, label: 'ia' });
    const b = await classWithEssay({ institutionId: inst, label: 'ib' });
    const c = await classWithEssay({ institutionId: new mongoose.Types.ObjectId(), label: 'ic' });
    const shared = words('s', 20);
    const x = await essay({ ...a, studentUser: (await student(a.klass, 'x')).user, text: `${words('x', 10)} ${shared}` });
    const y = await essay({ ...b, studentUser: (await student(b.klass, 'y')).user, text: `${words('y', 10)} ${shared}` });
    const z = await essay({ ...c, studentUser: (await student(c.klass, 'z')).user, text: `${words('z', 10)} ${shared}` });
    for (const sub of [x, y, z]) await internal.indexSubmission(sub._id);
    const found = await compare(x, { ...SETTINGS, internalScope: 'institution' });
    expect(found.map(f => String(f.refSubmissionId))).toEqual([String(y._id)]);
  });
  test('an essay that was deleted is ignored and its fingerprint removed', async () => {
    const { mine, theirs } = await pair();
    await Submission.deleteOne({ _id: theirs._id });
    expect(await compare(mine)).toEqual([]);
    expect(await SimilarityFingerprint.countDocuments({ submissionId: theirs._id })).toBe(0);
  });
  test('sources are ordered by matched words and capped', async () => {
    const a = await classWithEssay();
    const sa = await student(a.klass, 'sa');
    const mine = await essay({ ...a, studentUser: sa.user, text: `${words('s', 40)}` });
    const b = await classWithEssay({ label: 'b' });
    const small = await essay({ ...b, studentUser: (await student(b.klass, 'sb')).user, text: words('s', 10) });
    const big = await essay({ ...b, studentUser: (await student(b.klass, 'sc')).user, text: words('s', 30) });
    for (const sub of [small, big]) await internal.indexSubmission(sub._id);
    const sources = await compare(mine);
    expect(sources.map(s => String(s.refSubmissionId))).toEqual([String(big._id), String(small._id)]);
    expect(internal.MAX_INTERNAL_SOURCES).toBe(20);
  });
});

describe('scripts/backfillSimilarityFingerprints.js', () => {
  const { backfill, main } = require('../scripts/backfillSimilarityFingerprints');
  test('indexes marked essays only (not unmarked, not speaking), counts only; a dry run writes nothing; a limit stops early', async () => {
    const a = await classWithEssay();
    const make = async (label, extra) => essay({ ...a, studentUser: (await student(a.klass, label)).user, text: words(label, 20), extra });
    await make('m1', { assessmentStatus: 'complete' });
    await make('m2', { assessmentStatus: 'complete' });
    await make('u1', {});
    await make('au', { assessmentStatus: 'complete', sourceKind: 'audio' });
    expect(await backfill({ dryRun: true })).toEqual({ scanned: 2, indexed: 0, skipped: 0, failed: 0 });
    expect(await SimilarityFingerprint.countDocuments()).toBe(0);
    expect(await backfill({ limit: 1 })).toEqual({ scanned: 1, indexed: 1, skipped: 0, failed: 0 });
    expect(await backfill()).toEqual({ scanned: 2, indexed: 2, skipped: 0, failed: 0 });
    expect(await SimilarityFingerprint.countDocuments()).toBe(2);
  });
  test('main refuses to run without MONGO_URI or with a bad limit', async () => {
    const saved = process.env.MONGO_URI; delete process.env.MONGO_URI;
    try { await expect(main([])).rejects.toThrow('MONGO_URI is required'); } finally { if (saved !== undefined) process.env.MONGO_URI = saved; }
    process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:1/none';
    await expect(main(['--limit=0'])).rejects.toThrow('--limit must be a positive number');
    if (saved === undefined) delete process.env.MONGO_URI; else process.env.MONGO_URI = saved;
  });
});
