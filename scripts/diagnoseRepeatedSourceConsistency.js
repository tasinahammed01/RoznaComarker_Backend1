'use strict';
// Read-only: native collection reads, autoIndex/autoCreate disabled, no provider calls.
const fs = require('fs/promises');
const path = require('path');
const { digest, inspectBytes, snapshotRun, compareRuns } = require('../src/services/repeatedSourceConsistency.service');
const ROOT = path.resolve(__dirname, '..');
const SAFE_MEDIA = /\.(?:jpe?g|png|webp|pdf)$/iu;
function parseArgs(args) {
  const options = { details: args.includes('--details'), fixtures: args.includes('--fixtures'), all: args.includes('--all-duplicates') };
  for (const name of ['sha256', 'file']) {
    const at = args.indexOf(`--${name}`);
    if (at >= 0) { if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error('Missing argument'); options[name] = args[at + 1]; }
  }
  if ([options.fixtures, options.all, Boolean(options.sha256), Boolean(options.file)].filter(Boolean).length !== 1) throw new Error('Choose exactly one diagnostic scope');
  if (options.sha256 && !/^[a-f\d]{64}$/iu.test(options.sha256)) throw new Error('Invalid SHA-256');
  if (options.sha256) options.sha256 = options.sha256.toLowerCase();
  return options;
}
async function loadStoredFile(file) {
  if (!file?.path || !SAFE_MEDIA.test(file.path)) return { ...file, sourceInfo: null };
  const absolute = path.resolve(ROOT, file.path);
  if (!absolute.startsWith(ROOT + path.sep)) return { _id: file._id, unavailable: true };
  try {
    // realpath also rejects symlink/junction escapes from the permitted media root.
    const real = await fs.realpath(absolute);
    if (!real.startsWith(ROOT + path.sep)) return { _id: file._id, unavailable: true };
    const buffer = await fs.readFile(real);
    return { ...file, buffer, sourceInfo: await inspectBytes(buffer) };
  } catch { return { ...file, sourceInfo: null, unavailable: true }; }
}
const projection = { _id: 1, sourceSubmissionId: 1, draftNumber: 1, assignment: 1, file: 1, files: 1,
  fileContentIdentity: 1, fileOrder: 1, ocrPages: 1, combinedOcrText: 1, transcriptText: 1, ocrText: 1,
  ocrJobId: 1, ocrStatus: 1, ocrUpdatedAt: 1, writingCorrections: 1, correctionUpdatedAt: 1,
  correctionOcrJobId: 1, correctionOcrEvidenceHash: 1, correctionTranscriptLayoutVersion: 1,
  correctionStatus: 1, correctionVersion: 1, correctionSourceHash: 1, correctionLegendVersion: 1,
  semanticStatus: 1, semanticSourceKey: 1, semanticMetrics: 1, assessmentStatus: 1, assessmentCompletedAt: 1,
  correctionGenerationConfig: 1, semanticProvider: 1, semanticModel: 1, semanticPromptVersion: 1,
  evaluationStatus: 1, evaluationVersion: 1, evaluationPolicyHash: 1, evaluationRubricSourceHash: 1, feedbackSnapshot: 1 };
async function diagnoseDatabase(db, options) {
  const fileMap = new Map(); let unreadableSources = 0;
  for await (const file of db.collection('files').find({ type: 'submissions', sourceFileId: { $exists: false } },
    { projection: { _id: 1, path: 1 }, maxTimeMS: 15000 })) {
    const loaded = await loadStoredFile(file); if (!loaded.sourceInfo) unreadableSources++;
    // Retain metadata only; media is re-read only for matching output groups.
    fileMap.set(String(file._id), { ...file, sourceInfo: loaded.sourceInfo });
  }
  const groups = new Map();
  // Legacy single-image records retain SHA256(hex(rawSHA256)), even if deletion
  // removed their File. Link that identity to known source bytes, not a second group.
  const singleFileBundles = new Map();
  for (const file of fileMap.values()) if (file.sourceInfo?.sha256) {
    const raw = file.sourceInfo.sha256; singleFileBundles.set(digest(Buffer.from(raw)), raw);
  }
  if (options.sha256) singleFileBundles.set(digest(Buffer.from(options.sha256)), options.sha256);
  let catalogRunsScanned = 0, unidentifiableRuns = 0;
  for (const collection of ['submissions', 'submissionrevisions']) {
    for await (const row of db.collection(collection).find({}, { projection: { _id: 1, sourceSubmissionId: 1, draftNumber: 1,
      ocrJobId: 1, files: 1, file: 1, fileContentIdentity: 1, 'ocrPages.sourceSha256': 1 }, maxTimeMS: 15000 })) {
      catalogRunsScanned++;
      const hashes = new Set((row.files?.length ? row.files : row.file ? [row.file] : []).map(id => fileMap.get(String(id))?.sourceInfo?.sha256).filter(Boolean));
      for (const page of row.ocrPages || []) if (page.sourceSha256) hashes.add(page.sourceSha256);
      if (!hashes.size && row.fileContentIdentity) hashes.add(singleFileBundles.get(row.fileContentIdentity) || `bundle:${row.fileContentIdentity}`);
      if (!hashes.size) unidentifiableRuns++;
      for (const key of hashes) {
        if (options.sha256 && key !== options.sha256 && key !== `bundle:${digest(Buffer.from(options.sha256))}`) continue;
        const group = groups.get(key) || new Map();
        const processingIdentity = `${row.sourceSubmissionId || row._id}:${row.ocrJobId || row.draftNumber || 1}`;
        if (!group.has(processingIdentity)) group.set(processingIdentity, { collection, id: row._id });
        groups.set(key, group);
      }
    }
  }
  const reports = [];
  for (const [key, references] of groups) {
    if (options.all && references.size < 2) continue;
    const snapshots = [];
    for (const { collection, id } of references.values()) {
      const submission = await db.collection(collection).findOne({ _id: id }, { projection });
      submission.recordKind = collection;
      const feedback = collection === 'submissionrevisions' ? submission.feedbackSnapshot || {}
        : await db.collection('submissionfeedbacks').findOne({ submissionId: id }, { projection: {
          evaluationPolicyHash: 1, evaluationRubricSourceHash: 1, evaluationVersion: 1, assessmentVersion: 1,
          evaluationStatus: 1, evaluationProvider: 1, evaluationModel: 1, evaluationSourceHash: 1,
          detailedFeedback: 1, detailedFeedbackSourceHash: 1, overriddenByTeacher: 1,
          overallScore: 1, grade: 1, rubricScores: 1, customRubricScores: 1 } }) || {};
      const loaded = new Map();
      const loadFile = async fileId => {
        if (!loaded.has(fileId)) {
          const file = fileMap.get(fileId) || await db.collection('files').findOne({ _id: new (require('mongoose').Types.ObjectId)(fileId) }, { projection: { _id: 1, path: 1 } });
          loaded.set(fileId, await loadStoredFile(file));
        }
        return loaded.get(fileId);
      };
      snapshots.push(await snapshotRun({ submission, feedback, loadFile, sourceSha256: key.startsWith('bundle:') ? null : key, details: options.details }));
    }
    reports.push({ sourceSha256: key.startsWith('bundle:') ? null : key,
      sourceIdentityKind: key.startsWith('bundle:') ? 'ordered-file-hashes-only' : 'source-sha256',
      bundleIdentity: key.startsWith('bundle:') ? key.slice(7) : null, matchingRuns: snapshots.length, runs: snapshots,
      comparisons: snapshots.slice(1).map(snapshot => compareRuns(snapshots[0], snapshot)) });
  }
  return { mode: 'persisted-read-only', unreadableSources, catalogRunsScanned, unidentifiableRuns,
    catalogComplete: unreadableSources === 0 && unidentifiableRuns === 0,
    duplicateGroups: reports.filter(r => r.matchingRuns > 1).length,
    reports, limitations: ['Deleted submissions/files cannot be reconstructed by this script; available revisions are included and duplicate processing-run references are collapsed.',
      'Missing original files leave byte identity unverified. Bundle identities are not raw source SHA-256.',
      'Full text is compared in memory. Default output contains hashes/counts and bounded snippets; --details adds word/target evidence.'] };
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.fixtures) {
    const { rows, source } = await require('./fixtures/repeatedSourceFixtures').fixtures();
    const runs = await Promise.all(rows.map(row => snapshotRun({ ...row, details: options.details })));
    const unsafeRuns = await Promise.all(rows.map(row => snapshotRun({ ...row,
      submission: { ...row.submission, ocrJobId: 'superseding-run' } })));
    const expectedMarkers = rows.reduce((n, row) => n + row.submission.writingCorrections.length, 0);
    console.log(JSON.stringify({ mode: 'synthetic-fixtures', source, matchingRuns: runs.length, runs,
      metrics: { expectedValidMarkers: expectedMarkers, retainedValidMarkers: runs.reduce((n, run) => n + run.corrections.markerCount, 0),
        equivalentDuplicatesRemoved: rows.reduce((n, row) => n + row.fixtureMergeDiagnostics.duplicateCount, 0),
        unsafeCrossRunMarkersAttempted: expectedMarkers, unsafeCrossRunMarkersRendered: unsafeRuns.reduce((n, run) => n + run.corrections.markerCount, 0) },
      comparisons: runs.slice(1).map(run => compareRuns(runs[0], run)) }, null, 2)); return;
  }
  let localSource = null;
  if (options.file) {
    if (!SAFE_MEDIA.test(options.file)) throw new Error('Source must be a supported image/PDF');
    localSource = await inspectBytes(await fs.readFile(options.file)); options.sha256 = localSource.sha256;
  }
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  let connected = false;
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    console.log(JSON.stringify({ localSource, ...await diagnoseDatabase(mongoose.connection.db, options) }, null, 2));
  } catch {
    console.log(JSON.stringify({ mode: 'persisted-read-only', databaseAvailable: connected, localSource,
      errorCode: connected ? 'DIAGNOSTIC_READ_FAILED' : 'DATABASE_UNAVAILABLE', liveRunCount: null,
      reason: 'Stored run evidence unavailable; no live consistency verdict can be established.' })); process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Read-only consistency diagnosis stopped. Check the scope and source availability. No provider calls or database writes are performed.'); process.exitCode = 1; });
module.exports = { parseArgs, loadStoredFile, diagnoseDatabase, main };
