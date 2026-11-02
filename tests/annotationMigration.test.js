'use strict';
// Task 6A migrations: indexes (idempotent, TTLs) and version 1 -> version 2 overlays (dry run, backup, apply twice, reverse).
process.env.JWT_SECRET = 'annotation-migration-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-migration';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const policy = require('../src/services/teacherAnnotation.service');
const view = require('../src/services/studentCorrectionView.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedAnnotationFixture, rerunOcr, AI_SPECS, WORDS } = require('./helpers/annotationFixture');
const { ensureAnnotationIndexes } = require('../scripts/migrateAnnotationIndexes');
const migration = require('../scripts/migrateTeacherAnnotations');

jest.setTimeout(180000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-migration-'));
let fixture;
beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => { await mongoose.connection.dropDatabase(); await seedTestPlans(); fixture = await seedAnnotationFixture({ uploadRoot }); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('index migration', () => {
  test('creates the audit indexes and the one-year recovery-link TTL; running it twice changes nothing', async () => {
    const first = await ensureAnnotationIndexes();
    const second = await ensureAnnotationIndexes();
    expect(second).toEqual(first);
    const audit = first.annotationaudits;
    expect(audit.find(i => i.name === 'annotation_audit_request_v1')).toEqual(expect.objectContaining({ unique: true, key: { submissionId: 1, requestId: 1 } }));
    expect(audit.some(i => i.expireAfterSeconds !== undefined)).toBe(false);   // no TTL unless ANNOTATION_AUDIT_TTL_DAYS is set
    expect(first.recoverylinkaudits.find(i => i.name === 'recovery_link_audit_ttl_v1')).toEqual(expect.objectContaining({ expireAfterSeconds: 31536000 }));
  });
  test('ANNOTATION_AUDIT_TTL_DAYS adds a TTL index; invalid values add none', () => {
    // An isolated module registry loads a fresh mongoose, so the model is built again with the variable in place.
    const ttlSeconds = value => { let indexes; jest.isolateModules(() => { process.env.ANNOTATION_AUDIT_TTL_DAYS = value;
      indexes = require('../src/models/AnnotationAudit').schema.indexes(); });
      delete process.env.ANNOTATION_AUDIT_TTL_DAYS;
      return indexes.find(([, options]) => options.name === 'annotation_audit_ttl_v1')?.[1].expireAfterSeconds ?? null; };
    expect(ttlSeconds('400')).toBe(400 * 86400);
    expect(ttlSeconds('abc')).toBeNull();
    expect(ttlSeconds('-1')).toBeNull();
    expect(ttlSeconds('1.5')).toBeNull();
  });
});

/** Version 1 overlays as the pre-6A service stored them. */
async function seedVersion1() {
  const doc = await Submission.findById(fixture.IDS.registered).lean();
  const { sourceHash } = policy.source(doc);
  const pick = (word, symbol) => doc.writingCorrections.find(c => c.quotedText === word && (!symbol || c.symbol === symbol));
  const a = pick('a', 'ART'), dont = pick('dont');
  const audit = n => Array.from({ length: n }, (_, i) => ({ requestId: crypto.randomUUID(), requestHash: `h${i}`, action: 'hide',
    actor: String(fixture.teacher._id), submissionId: String(doc._id), correctionId: a.id, timestamp: '2026-09-01T00:00:00.000Z',
    previousRevision: i, newRevision: i + 1, before: null, after: null, changedFields: [], visibilityChanged: true, scoringReviewRequired: false }));
  const registered = { revision: 3, scoringReviewRequired: true, audit: audit(3), entries: [
    { id: a.id, sourceHash, status: 'hidden', value: a, original: a },
    { id: dont.id, sourceHash, status: 'visible', value: { ...dont, message: 'Teacher wording.' }, original: dont },
    { id: 'ai_ffffffffffffffff', sourceHash: 'f'.repeat(64), status: 'hidden', value: a, original: a }] };
  await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: registered } });
  // Guest: an entry made on draft 1, whose snapshot exists; the live submission is draft 2 with new OCR.
  const guest = await Submission.findById(fixture.IDS.guest).lean();
  const guestHash = policy.source(guest).sourceHash;
  const ga = guest.writingCorrections.find(c => c.quotedText === 'a');
  await Submission.updateOne({ _id: guest._id }, { $set: { teacherAnnotations: { revision: 1, entries: [{ id: ga.id, sourceHash: guestHash, status: 'hidden', value: ga, original: ga }], audit: [] } } });
  await require('../src/services/submissionRevision.service').captureCurrentRevision(await Submission.findById(guest._id));
  await SubmissionRevision.updateOne({ sourceSubmissionId: guest._id }, { $unset: { teacherAnnotations: 1 } });   // snapshot taken before 6A
  await rerunOcr({ submissionId: guest._id, words: ['Later', ...WORDS], specs: AI_SPECS.map(([w, ...r]) => [w + 1, ...r]), ocrJobId: 'job-draft-2' });
  await Submission.updateOne({ _id: guest._id }, { $set: { draftNumber: 2 } });
  return { registered, a, dont };
}
const overlays = async () => Object.fromEntries((await Submission.find({}).select('+teacherAnnotations').lean()).map(d => [String(d._id), d.teacherAnnotations]));
const studentLists = async () => Promise.all([fixture.IDS.registered, fixture.IDS.guest].map(async id =>
  (await view.loadStudentCorrectionView(await Submission.findById(id).lean())).corrections.map(c => [c.quotedText, c.message]).sort()));

describe('data migration', () => {
  test('nothing to migrate: dry run and apply are no-ops and write no backup', async () => {
    const backup = path.join(tmp, `none-${Date.now()}.jsonl`);
    expect(await migration.migrate({})).toEqual(expect.objectContaining({ mode: 'DRY_RUN', overlays: 0, candidates: 0 }));
    expect(await migration.migrate({ apply: true, backupConfirmed: true, backup })).toEqual(expect.objectContaining({ mode: 'APPLY', candidates: 0, written: 0, backup: null }));
    expect(fs.existsSync(backup)).toBe(false);
  });

  test('dry run, apply (backup first), apply again, reverse', async () => {
    const { registered } = await seedVersion1();
    const before = await overlays(), viewsBefore = await studentLists();
    const dry = await migration.migrate({});
    expect(dry).toEqual(expect.objectContaining({ mode: 'DRY_RUN', candidates: 2, entries: 4, currentDraft: 2, olderDraft: 1, draftUnknown: 1, auditRows: 3, written: 0,
      // Guest: before migration the draft-1 hide (draft unknown) also covered draft 2 (fail closed); pinned to draft 1 it no longer does.
      studentViewChanged: 1 }));
    expect(dry.reanchored + Object.values(dry.orphaned).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(await overlays()).toEqual(before);

    const backup = path.join(tmp, `run-${Date.now()}.jsonl`);
    const applied = await migration.migrate({ apply: true, backupConfirmed: true, backup });
    expect(applied).toEqual(expect.objectContaining({ candidates: 2, written: 2, skippedChanged: 0, revisionOverlaysWritten: 1, backup }));
    expect(fs.readFileSync(backup, 'utf8').trim().split('\n')).toHaveLength(2);
    const after = await overlays();
    expect(after[String(fixture.IDS.registered)]).toEqual(expect.objectContaining({ version: 2, revision: 3, scoringReviewRequired: true }));
    expect(after[String(fixture.IDS.registered)].audit).toBeUndefined();
    expect(await AnnotationAudit.countDocuments({ legacy: true })).toBe(3);
    const viewsAfter = await studentLists();
    expect(viewsAfter[0]).toEqual(viewsBefore[0]);                      // registered: exactly what the student saw before
    expect(viewsAfter[1].filter(([q]) => q === 'a')).toHaveLength(1);    // guest draft 2: the draft-1 hide no longer applies
    // ...and draft 1, as the comparison shows it, still hides it.
    const draft1 = await SubmissionRevision.findOne({ sourceSubmissionId: fixture.IDS.guest }).lean();
    expect((await view.loadStudentCorrectionView(draft1, { model: 'SubmissionRevision' })).corrections.some(c => c.quotedText === 'a')).toBe(false);
    const revision = await SubmissionRevision.findOne({ sourceSubmissionId: fixture.IDS.guest }).select('+teacherAnnotations').lean();
    expect(revision.teacherAnnotations.entries.map(e => e.status)).toEqual(['hidden']);

    const again = await migration.migrate({ apply: true, backupConfirmed: true, backup: path.join(tmp, `again-${Date.now()}.jsonl`) });
    expect(again).toEqual(expect.objectContaining({ candidates: 0, alreadyV2: 2, written: 0, backup: null }));
    expect(await AnnotationAudit.countDocuments({ legacy: true })).toBe(3);

    const reversed = await migration.migrate({ reverse: true, backupConfirmed: true, backup });
    expect(reversed).toEqual({ mode: 'REVERSE', restored: 2, skippedModifiedAfterMigration: 0, revisionOverlaysRemoved: 1, auditRowsRemoved: 3 });
    expect(await overlays()).toEqual(before);
    expect((await overlays())[String(fixture.IDS.registered)]).toEqual(registered);
    expect(await studentLists()).toEqual(viewsBefore);
  });

  test('reverse never overwrites a teacher change made after the migration', async () => {
    await seedVersion1();
    const backup = path.join(tmp, `changed-${Date.now()}.jsonl`);
    await migration.migrate({ apply: true, backupConfirmed: true, backup });
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $inc: { 'teacherAnnotations.revision': 1 } });
    const reversed = await migration.migrate({ reverse: true, backupConfirmed: true, backup });
    expect(reversed).toEqual(expect.objectContaining({ restored: 1, skippedModifiedAfterMigration: 1 }));
    expect((await overlays())[String(fixture.IDS.registered)].version).toBe(2);
  });

  test('command line: apply and reverse need --backup-confirmed; reverse needs the backup file', () => {
    expect(migration.parseCliArgs([])).toEqual({ apply: false, reverse: false, backupConfirmed: false, backup: null });
    expect(() => migration.parseCliArgs(['--apply'])).toThrow('BACKUP_CONFIRMATION_REQUIRED');
    expect(() => migration.parseCliArgs(['--reverse', '--backup-confirmed'])).toThrow('BACKUP_FILE_REQUIRED');
    expect(() => migration.parseCliArgs(['--apply', '--reverse', '--backup-confirmed'])).toThrow('APPLY_AND_REVERSE');
    expect(() => migration.parseCliArgs(['--force'])).toThrow('UNKNOWN_CLI_ARGUMENT');
  });
});
