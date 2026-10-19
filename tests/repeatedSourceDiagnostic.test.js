'use strict';
const fs = require('fs/promises'); const path = require('path');
const { fixtures } = require('../scripts/fixtures/repeatedSourceFixtures');
const { parseArgs, diagnoseDatabase } = require('../scripts/diagnoseRepeatedSourceConsistency');
const { snapshotRun, compareRuns, digest } = require('../src/services/repeatedSourceConsistency.service');
let fixed, folder, sourcePath;
beforeAll(async () => {
  fixed = await fixtures(); folder = await fs.mkdtemp(path.resolve(__dirname, '../tmp/repeated-diagnostic-'));
  sourcePath = path.join(folder, 'fixed-source.jpg'); await fs.writeFile(sourcePath, fixed.buffer);
});
afterAll(async () => { await fs.unlink(sourcePath); await fs.rmdir(folder); });
test('diagnostic accepts hash/file/all-duplicates and rejects ambiguous/invalid scope', () => {
  expect(parseArgs(['--sha256', 'a'.repeat(64)]).sha256).toBe('a'.repeat(64));
  expect(parseArgs(['--file', 'source.jpg']).file).toBe('source.jpg');
  expect(parseArgs(['--all-duplicates']).all).toBe(true);
  for (const args of [[], ['--file'], ['--sha256', 'invalid'], ['--file', 'a.jpg', '--all-duplicates']]) expect(() => parseArgs(args)).toThrow();
});
function readOnlyDatabase({ legacyBundle = false } = {}) {
  const records = {
    files: fixed.rows.map(row => ({ _id: row.submission.files[0], type: 'submissions', path: path.relative(path.resolve(__dirname, '..'), sourcePath) })),
    submissions: fixed.rows.map(row => ({ ...row.submission, guest: { normalizedEmail: 'private@example.invalid' }, student: 'PRIVATE-STUDENT' })),
    submissionrevisions: [], submissionfeedbacks: fixed.rows.map(row => ({ ...row.feedback, submissionId: row.submission._id }))
  };
  if (legacyBundle) records.submissions.push({ _id: 'legacy-run', files: ['012345678901234567890123'],
    fileContentIdentity: fixed.rows[0].submission.fileContentIdentity, ocrJobId: 'legacy-run', ocrPages: [] },
  { _id: 'unidentifiable-run', files: [], ocrPages: [] });
  const reads = [];
  const db = { collection: name => new Proxy({}, { get(_, operation) {
    if (!['find', 'findOne'].includes(operation)) throw new Error('Diagnostic attempted a non-read operation');
    return (filter = {}) => {
      reads.push([name, operation]);
      const rows = (records[name] || []).filter(row => Object.entries(filter).every(([key, value]) =>
        ['_id', 'submissionId'].includes(key) ? String(row[key]) === String(value) : row[key] === value || typeof value === 'object'));
      return operation === 'findOne' ? Promise.resolve(rows[0] || null) : (async function* () { yield* rows; })();
    };
  } }) };
  return { db, reads };
}
test.each([{ all: true }, { sha256: 'use-fixed-hash' }])('read-only duplicate catalog finds five actual byte-identical runs: %j', async options => {
  const { db, reads } = readOnlyDatabase();
  const report = await diagnoseDatabase(db, { ...options, ...(options.sha256 ? { sha256: fixed.source.sha256 } : {}) });
  expect(report.duplicateGroups).toBe(1); expect(report.reports[0].matchingRuns).toBe(5);
  expect(report.reports[0].sourceSha256).toBe(fixed.source.sha256);
  expect(report.reports[0].comparisons.every(c => c.checks.sourceBytesVerifiedIdentical && c.checks.correctionTargetsIdentical)).toBe(true);
  expect(reads.length).toBeGreaterThan(5);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain('private@example'); expect(serialized).not.toContain('PRIVATE-STUDENT');
  expect(serialized).not.toContain('word_fixture-file-'); // default output does not dump full word evidence
  expect(digest(await fs.readFile(sourcePath))).toBe(fixed.source.sha256);
});
test('legacy single-file bundle identities join the known source group without claiming missing bytes were verified', async () => {
  const { db } = readOnlyDatabase({ legacyBundle: true });
  const report = await diagnoseDatabase(db, { all: true });
  expect(report.reports).toHaveLength(1); expect(report.reports[0].matchingRuns).toBe(6);
  expect(report.reports[0].runs.find(r => r.runId === 'legacy-run').sources[0].byteIdentityVerified).toBe(false);
  expect(report.unidentifiableRuns).toBe(1); expect(report.catalogComplete).toBe(false);
});
test('wording-only, objective correction, policy, model, and geometry variants are independently classified', async () => {
  const row = fixed.rows[0]; const base = await snapshotRun(row);
  async function variant(mutate) {
    const other = { ...row, submission: structuredClone(row.submission), feedback: structuredClone(row.feedback) };
    mutate(other); return compareRuns(base, await snapshotRun(other));
  }
  const prose = await variant(other => { other.submission.writingCorrections[0].message = 'Different explanation.'; });
  expect(prose.checks.onlyAIExplanationWordingDifferent).toBe(true);
  expect(prose.classifications).toEqual(['EXPECTED_PRESENTATION_ONLY_VARIANCE']);
  expect((await variant(other => { other.submission.writingCorrections.pop(); })).classifications).toContain('AI_CORRECTION_VARIANCE');
  expect((await variant(other => { other.feedback.evaluationPolicyHash = 'other-policy'; })).classifications).toContain('POLICY_VARIANCE');
  expect((await variant(other => { other.submission.correctionGenerationConfig.model = 'other-model'; })).classifications).toContain('MODEL_CONFIGURATION_VARIANCE');
  expect((await variant(other => { other.submission.ocrPages[0].words[0].bbox.x += 5; })).classifications).toContain('GEOMETRY_VARIANCE');
});
test('missing run evidence is reported as unknown rather than identical', async () => {
  const row = { submission: { _id: 'pending', files: [], ocrPages: [], writingCorrections: [] }, loadFile: async () => null };
  const a = await snapshotRun(row), b = await snapshotRun(row);
  expect(compareRuns(a, b).checks).toMatchObject({ sourceIdentical: null, sourceBytesVerifiedIdentical: null,
    ocrTranscriptIdentical: null, ocrWordIdsIdentical: null, correctionSetIdentical: null,
    geometryProjectionIdentical: null, scoringIdentical: null, modelConfigurationIdentical: null });
});
