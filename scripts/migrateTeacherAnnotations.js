'use strict';
// Task 6A data migration: version 1 teacher overlays -> version 2 (anchored entries, audit in the AnnotationAudit collection).
// The application already reads version 1 overlays correctly (teacherAnnotation.service normalizeState), so this migration is not
// required for correctness; it pins each entry to its draft, adds text context to anchors (better re-anchoring after an OCR re-run)
// and moves the embedded audit trail out of the submission document.
//
//   npm run migrate:teacher-annotations                                   dry run: counts only, no writes
//   npm run migrate:teacher-annotations -- --apply --backup-confirmed     backup file first, then convert
//   npm run migrate:teacher-annotations -- --reverse --backup-confirmed --backup=<file>   restore from that backup
//
// Idempotent: converted overlays (version 2) are skipped, audit rows are upserted. Race-safe: a submission is written only if its
// overlay is still the one that was read. The backup is JSON lines {submissionId, teacherAnnotations, revisionOverlays} and holds
// teacher and student text: keep it on the database host, restricted, and delete it once the migration is verified. Output: counts only.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const ALLOWED = /^--(apply|reverse|backup-confirmed|backup=.+)$/;
function parseCliArgs(argv = []) {
  if (argv.some(a => !ALLOWED.test(a)) || new Set(argv).size !== argv.length) throw new Error('UNKNOWN_CLI_ARGUMENT');
  const apply = argv.includes('--apply'), reverse = argv.includes('--reverse');
  const backupConfirmed = argv.includes('--backup-confirmed');
  const backup = argv.find(a => a.startsWith('--backup='))?.slice(9) || null;
  if (apply && reverse) throw new Error('APPLY_AND_REVERSE');
  if ((apply || reverse) && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  if (reverse && !backup) throw new Error('BACKUP_FILE_REQUIRED');
  return { apply, reverse, backupConfirmed, backup };
}

const models = () => ({ Submission: require('../src/models/Submission'), SubmissionRevision: require('../src/models/SubmissionRevision'),
  AnnotationAudit: require('../src/models/AnnotationAudit') });
const evidenceOf = doc => {
  const canonical = require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript(doc);
  return { canonical, hash: require('../src/services/correctionEvidenceIdentity.service').ocrEvidenceHash(canonical, doc) };
};

/** Version 1 overlay of one submission -> { state (version 2), revisionStates: Map(draftNumber -> state), tally }. Pure. */
function convert(doc, revisions) {
  const { normalizeState } = require('../src/services/teacherAnnotation.service');
  const anchors = require('../src/services/annotationAnchor.service');
  const state = normalizeState(doc.teacherAnnotations);
  const { canonical, hash } = evidenceOf(doc);
  const draftNumber = Math.max(1, Number(doc.draftNumber) || 1);
  const older = revisions.filter(r => Number(r.draftNumber) < draftNumber).map(r => ({ draftNumber: Number(r.draftNumber), hash: evidenceOf(r).hash }));
  const tally = { entries: state.entries.length, currentDraft: 0, olderDraft: 0, draftUnknown: 0 };
  const withContext = anchor => anchor && canonical.text.slice(anchor.startChar, anchor.endChar) === anchor.quotedText
    ? anchors.capture(anchor, canonical, hash) : anchor;
  const revisionStates = new Map();
  for (const entry of state.entries) {
    const entryHash = entry.anchor?.sourceHash ?? entry.valueAnchor?.sourceHash;
    const previous = older.find(r => r.hash === entryHash);
    if (entryHash === hash) {
      Object.assign(entry, { draftNumber, anchor: withContext(entry.anchor), ...(entry.valueAnchor ? { valueAnchor: withContext(entry.valueAnchor) } : {}) });
      delete entry.legacy; tally.currentDraft += 1;
    } else if (previous) {
      entry.draftNumber = previous.draftNumber; delete entry.legacy; tally.olderDraft += 1;
      const list = revisionStates.get(previous.draftNumber) || [];
      list.push(entry); revisionStates.set(previous.draftNumber, list);
    } else tally.draftUnknown += 1;
  }
  const v2 = { version: 2, revision: state.revision, scoringReviewRequired: Boolean(state.scoringReviewRequired), entries: state.entries, recent: [] };
  return { state: v2, legacyAudit: state.legacyAudit || [],
    revisionStates: new Map([...revisionStates].map(([n, entries]) => [n, { ...v2, entries }])), tally };
}

async function migrate({ apply = false, reverse = false, backupConfirmed = false, backup = null, now = new Date() } = {}) {
  if ((apply || reverse) && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  if (reverse) return reverseFrom(backup);
  const { Submission, SubmissionRevision, AnnotationAudit } = models();
  const report = { mode: apply ? 'APPLY' : 'DRY_RUN', overlays: 0, alreadyV2: 0, candidates: 0, entries: 0, currentDraft: 0, olderDraft: 0,
    draftUnknown: 0, reanchored: 0, orphaned: {}, studentViewChanged: 0, auditRows: 0, written: 0, skippedChanged: 0, revisionOverlaysWritten: 0, backup: null };
  const cursor = Submission.find({ teacherAnnotations: { $exists: true, $ne: null } }).select('+teacherAnnotations').lean().cursor();
  let out = null;
  for await (const doc of cursor) {
    report.overlays += 1;
    if (doc.teacherAnnotations?.version === 2) { report.alreadyV2 += 1; continue; }
    report.candidates += 1;
    const revisions = await SubmissionRevision.find({ sourceSubmissionId: doc._id }).select('+teacherAnnotations').lean();
    const { state, legacyAudit, revisionStates, tally } = convert(doc, revisions);
    for (const key of ['entries', 'currentDraft', 'olderDraft', 'draftUnknown']) report[key] += tally[key];
    const { resolveOverlay } = require('../src/services/studentCorrectionView.service');
    const resolution = resolveOverlay(doc, state);
    const active = state.entries.filter(e => e.draftNumber == null || e.draftNumber === Math.max(1, Number(doc.draftNumber) || 1)).length;
    report.reanchored += active - resolution.orphans.length;
    for (const o of resolution.orphans) report.orphaned[o.reason] = (report.orphaned[o.reason] || 0) + 1;
    // Pinning entries to their draft can change what students see (an earlier draft's hide no longer covers a later draft): counted.
    const shown = r => JSON.stringify(r.visible.map(c => [String(c.id), c.message]).sort());
    if (shown(resolveOverlay(doc, doc.teacherAnnotations)) !== shown(resolution)) report.studentViewChanged += 1;
    report.auditRows += legacyAudit.length;
    if (!apply) continue;
    if (!out) {
      report.backup = backup || path.resolve(`teacher-annotations-backup-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`);
      out = fs.openSync(report.backup, 'wx', 0o600);
    }
    const revisionTargets = revisions.filter(r => revisionStates.has(Number(r.draftNumber)) && r.teacherAnnotations == null);
    fs.writeSync(out, `${JSON.stringify({ submissionId: String(doc._id), teacherAnnotations: doc.teacherAnnotations,
      revisionOverlays: revisionTargets.map(r => String(r._id)) })}\n`);
    fs.fsyncSync(out);
    const written = await Submission.updateOne({ _id: doc._id, 'teacherAnnotations.revision': doc.teacherAnnotations.revision,
      'teacherAnnotations.version': { $exists: false } }, { $set: { teacherAnnotations: state } });
    if (!written.modifiedCount) { report.skippedChanged += 1; continue; }
    report.written += 1;
    for (const r of revisionTargets) {
      const done = await SubmissionRevision.updateOne({ _id: r._id, teacherAnnotations: { $exists: false } }, { $set: { teacherAnnotations: revisionStates.get(Number(r.draftNumber)) } });
      report.revisionOverlaysWritten += done.modifiedCount;
    }
    if (legacyAudit.length) await AnnotationAudit.bulkWrite(legacyAudit.map(row => ({ updateOne: { filter: { submissionId: doc._id, requestId: row.requestId },
      update: { $setOnInsert: { submissionId: doc._id, classId: doc.class || null, requestId: row.requestId, requestHash: row.requestHash || 'legacy',
        action: row.action, actor: String(row.actor), entryId: row.correctionId || null, correctionId: row.correctionId || null,
        previousRevision: row.previousRevision, newRevision: row.newRevision, before: row.before ?? null, after: row.after ?? null,
        changedFields: row.changedFields || [], visibilityChanged: Boolean(row.visibilityChanged), scoringReviewRequired: Boolean(row.scoringReviewRequired),
        legacy: true, createdAt: new Date(row.timestamp || 0) } }, upsert: true } })), { ordered: false });
  }
  if (out) fs.closeSync(out);
  return report;
}

/** Restores version 1 overlays from a backup, only where the overlay is still exactly what the migration wrote. */
async function reverseFrom(file) {
  const { Submission, SubmissionRevision, AnnotationAudit } = models();
  const report = { mode: 'REVERSE', restored: 0, skippedModifiedAfterMigration: 0, revisionOverlaysRemoved: 0, auditRowsRemoved: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const { submissionId, teacherAnnotations, revisionOverlays } = JSON.parse(line);
    const current = await Submission.findById(submissionId).select('+teacherAnnotations').lean();
    // A teacher change after the migration moved the revision on: restoring would lose it.
    if (current?.teacherAnnotations?.version !== 2 || current.teacherAnnotations.revision !== teacherAnnotations.revision) { report.skippedModifiedAfterMigration += 1; continue; }
    await Submission.updateOne({ _id: submissionId, 'teacherAnnotations.version': 2, 'teacherAnnotations.revision': teacherAnnotations.revision },
      { $set: { teacherAnnotations } });
    report.restored += 1;
    report.revisionOverlaysRemoved += (await SubmissionRevision.updateMany({ _id: { $in: revisionOverlays } }, { $unset: { teacherAnnotations: 1 } })).modifiedCount;
    report.auditRowsRemoved += (await AnnotationAudit.deleteMany({ submissionId, legacy: true })).deletedCount;
  }
  return report;
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    console.log(options.apply ? 'MODE=APPLY\nBACKUP_CONFIRMED=true' : options.reverse ? 'MODE=REVERSE\nBACKUP_CONFIRMED=true' : 'MODE=DRY_RUN');
    require('dotenv').config({ quiet: true });
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await migrate(options), null, 2));
  } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main();
module.exports = { parseCliArgs, convert, migrate };
