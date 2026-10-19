'use strict';
const mockDetection = jest.fn();
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockDetection })) }));
jest.mock('../src/models/File', () => ({ findById: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn().mockResolvedValue(null) }));
const fs = require('fs/promises'); const path = require('path');
const File = require('../src/models/File');
const { runOcrAndPersistForFiles } = require('../src/services/ocrPipeline.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { normalizeCorrection, mergeCanonicalCorrections } = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { bindCorrections, ocrEvidenceHash, bindingFailure, correctionFingerprint } = require('../src/services/correctionEvidenceIdentity.service');
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
const { fixtures } = require('../scripts/fixtures/repeatedSourceFixtures');
const { snapshotRun, compareRuns, digest } = require('../src/services/repeatedSourceConsistency.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');
let fixed, folder, filename;
beforeAll(async () => {
  fixed = await fixtures();
  folder = await fs.mkdtemp(path.resolve(__dirname, '../tmp/repeated-source-'));
  filename = path.join(folder, 'fixed-source.jpg'); await fs.writeFile(filename, fixed.buffer);
});
afterAll(async () => { await fs.unlink(filename); await fs.rmdir(folder); });
function providerOutput() {
  return [{ fullTextAnnotation: { text: 'blindely when blindely', pages: [{ width: 800, height: 600,
    blocks: [{ paragraphs: [{ words: ['blindely', 'when', 'blindely'].map((text, i) => ({
      symbols: [...text].map(text => ({ text, confidence: .98 })), boundingBox: { vertices: [
        { x: 80 + i * 200, y: 120 }, { x: 200 + i * 200, y: 120 },
        { x: 200 + i * 200, y: 144 }, { x: 80 + i * 200, y: 144 }] } })) }] }] }] } }];
}
test('five complete local OCR persistence / correction / render replays retain identical logical targets and source bytes', async () => {
  const results = [];
  mockDetection.mockImplementation(async () => providerOutput());
  for (let i = 0; i < 5; i++) {
    const fileId = `persisted-file-${i}`, runId = `run-${i}`;
    File.findById.mockResolvedValue({ _id: fileId, path: path.relative(path.resolve(__dirname, '..'), filename) });
    const submission = { _id: `submission-${i}`, files: [fileId], ocrJobId: runId,
      fileContentIdentity: digest(Buffer.from(fixed.source.sha256)), save: jest.fn().mockResolvedValue(null),
      constructor: { exists: jest.fn().mockResolvedValue(true), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) },
      toObject() { const result = { ...this }; delete result.constructor; delete result.save; delete result.toObject; return result; } };
    await runOcrAndPersistForFiles({ fileIds: [fileId], targetDoc: submission, jobId: runId });
    expect(submission.ocrStatus).toBe('completed');
    const canonical = buildCanonicalSubmissionTranscript(submission);
    const raw = [0, 2].map(index => ({ symbol: 'SP', category: 'GRAMMAR', quotedText: 'blindely', suggestedText: 'blindly',
      startChar: canonical.wordSpans[index].start, endChar: canonical.wordSpans[index].end, message: 'Check spelling.' }));
    const normalized = raw.map(c => normalizeCorrection(c, canonical.text, canonical.wordSpans, defaultLegend(), 'AI'));
    const merged = mergeCanonicalCorrections({ aiCorrections: [...normalized, { ...normalized[0], message: 'Another explanation.' }] });
    expect(merged.diagnostics.duplicateCount).toBe(1);
    expect(merged.corrections).toHaveLength(2);
    submission.writingCorrections = bindCorrections(merged.corrections, canonical, submission);
    submission.correctionUpdatedAt = new Date();
    const rendered = buildCanonicalCorrectionRenderModels(submission.writingCorrections, canonical, submission.ocrPages, { submission });
    expect(rendered.filter(c => c.renderTarget.source !== 'none')).toHaveLength(2);
    expect(submission.ocrPages[0]).toMatchObject({ sourceSha256: fixed.source.sha256, coordinateSpace: 'display-image',
      ocrImageWidth: 800, ocrImageHeight: 600, ocrRunId: runId, ocrProvider: 'google_vision' });
    expect(submission.ocrPages[0].ocrInputSha256).toBe(fixed.rows[0].submission.ocrPages[0].ocrInputSha256);
    const pixel = await require('sharp')(mockDetection.mock.calls.at(-1)[0].image.content)
      .extract({ left: 140, top: 132, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect(pixel[1]).toBeGreaterThan(pixel[0] + 80); expect(pixel[1]).toBeGreaterThan(pixel[2] + 80);
    results.push({ transcript: canonical.text, dimensions: [submission.ocrPages[0].width, submission.ocrPages[0].height],
      ids: canonical.wordSpans.map(s => s.wordId.replace(fileId, 'source')), coordinateSpace: submission.ocrPages[0].coordinateSpace,
      normalizedInputSha256: submission.ocrPages[0].ocrInputSha256,
      fingerprints: rendered.map(c => c.correctionFingerprint), boxes: rendered.map(c => c.renderTarget.boxes),
      logicalTargets: rendered.map(c => c.renderTarget.wordIds.map(id => id.replace(fileId, 'source'))) });
  }
  results.slice(1).forEach(result => expect(result).toEqual(results[0]));
  expect(digest(await fs.readFile(filename))).toBe(fixed.source.sha256);
  expect(mockDetection).toHaveBeenCalledTimes(5);
});
test('identical replay with stable file identity has byte-identical canonical word IDs', async () => {
  const row = fixed.rows[0];
  const ids = Array.from({ length: 5 }, () => buildCanonicalSubmissionTranscript(row.submission).wordSpans.map(s => s.wordId));
  ids.forEach(result => expect(result).toEqual(ids[0]));
});
test('five fresh-upload fixtures compare as identical targets; raw file-scoped ID changes are expected', async () => {
  const runs = await Promise.all(fixed.rows.map(row => snapshotRun(row)));
  for (const run of runs.slice(1)) {
    const compared = compareRuns(runs[0], run);
    expect(compared.checks).toMatchObject({ sourceBytesVerifiedIdentical: true, ocrTranscriptIdentical: true,
      ocrWordIdsIdentical: false, logicalWordPositionsIdentical: true, correctionSetIdentical: true,
      correctionTargetsIdentical: true, scoringIdentical: true, geometryProjectionIdentical: true });
    expect(compared.classifications).toEqual(['EXPECTED_PRESENTATION_ONLY_VARIANCE']);
    expect(run.corrections.markerCount).toBe(2);
  }
});
test('changed OCR text, geometry and shifted indexes cannot reuse bound corrections from the previous run', () => {
  const row = structuredClone(fixed.rows[0].submission);
  const old = row.writingCorrections;
  row.ocrJobId = 'different-provider-run';
  row.ocrPages[0].words.unshift({ id: `word_${row.files[0]}_1_1`, text: 'We', bbox: { x: 1, y: 1, w: 5, h: 3 } });
  row.ocrPages[0].words.forEach((w, i) => { w.id = `word_${row.files[0]}_1_${i + 1}`; });
  row.ocrPages[0].rawText = 'We blindely when blindely';
  const canonical = buildCanonicalSubmissionTranscript(row);
  expect(bindingFailure(old[0], canonical, row)).toBe('ocr_run_mismatch');
  const rendered = buildCanonicalCorrectionRenderModels(old, canonical, row.ocrPages, { submission: row });
  expect(rendered.every(c => c.renderTarget.source === 'none')).toBe(true);
  const span = canonical.wordSpans[1];
  const own = normalizeCorrection({ symbol: 'SP', quotedText: 'blindely', suggestedText: 'blindly', startChar: span.start, endChar: span.end },
    canonical.text, canonical.wordSpans, defaultLegend(), 'AI');
  const bound = bindCorrections([own], canonical, row);
  expect(buildCanonicalCorrectionRenderModels(bound, canonical, row.ocrPages, { submission: row })[0].renderTarget.wordIds).toEqual([span.wordId]);
});
test('evidence hash blocks changed text/boxes even when a legacy caller accidentally retains the same run ID', () => {
  const row = structuredClone(fixed.rows[0].submission); const old = row.writingCorrections;
  row.ocrPages[0].words[0].bbox.x = 70;
  expect(bindingFailure(old[0], buildCanonicalSubmissionTranscript(row), row)).toBe('ocr_evidence_mismatch');
  expect(old[0].ocrEvidenceHash).not.toBe(ocrEvidenceHash(buildCanonicalSubmissionTranscript(row), row));
});
test('coordinate provenance changes invalidate the bound evidence even with unchanged words and run ID', () => {
  const row = structuredClone(fixed.rows[0].submission);
  row.ocrPages[0].coordinateSpace = 'encoded-image';
  expect(bindingFailure(row.writingCorrections[0], buildCanonicalSubmissionTranscript(row), row)).toBe('ocr_evidence_mismatch');
});
test('fingerprints ignore explanation wording and upload IDs but preserve distinct occurrences and error types', () => {
  const [a, b] = fixed.rows;
  const ca = buildCanonicalSubmissionTranscript(a.submission), cb = buildCanonicalSubmissionTranscript(b.submission);
  const c = a.submission.writingCorrections[0];
  expect(correctionFingerprint({ ...c, message: 'Other prose.' }, ca, a.submission)).toBe(c.correctionFingerprint);
  expect(correctionFingerprint(b.submission.writingCorrections[0], cb, b.submission)).toBe(c.correctionFingerprint);
  expect(a.submission.writingCorrections[1].correctionFingerprint).not.toBe(c.correctionFingerprint);
  expect(correctionFingerprint({ ...c, symbol: 'WC', category: 'VOCABULARY' }, ca, a.submission)).not.toBe(c.correctionFingerprint);
});
test('structured extraction already requests temperature zero; top_p and seed are not falsely recorded as configured', () => {
  const config = getSemanticAIConfig({ AI_PRIMARY_PROVIDER: 'openrouter', AI_PRIMARY_MODEL: 'fixture-model', OPENROUTER_API_KEY: 'test-only' });
  expect(config.temperature).toBe(0); expect(config.responseFormat).toBe('json');
  expect(config).not.toHaveProperty('top_p'); expect(config).not.toHaveProperty('seed');
});
test('two plausible Vision response fixtures change OCR evidence but never inherit old-run target authority', async () => {
  async function replay(runId, output) {
    mockDetection.mockResolvedValueOnce(output);
    const fileId = 'same-file-provider-variance';
    File.findById.mockResolvedValue({ _id: fileId, path: path.relative(path.resolve(__dirname, '..'), filename) });
    const doc = { _id: runId, files: [fileId], ocrJobId: runId,
      constructor: { exists: jest.fn().mockResolvedValue(true), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) },
      toObject() { const data = { ...this }; delete data.constructor; delete data.toObject; return data; } };
    await runOcrAndPersistForFiles({ fileIds: [fileId], targetDoc: doc, jobId: runId }); return doc;
  }
  const a = await replay('provider-replay-a', providerOutput());
  const ca = buildCanonicalSubmissionTranscript(a);
  const first = ca.wordSpans[0];
  const old = bindCorrections([normalizeCorrection({ symbol: 'SP', quotedText: 'blindely', suggestedText: 'blindly',
    startChar: first.start, endChar: first.end }, ca.text, ca.wordSpans, defaultLegend(), 'AI')], ca, a);
  const alternative = providerOutput(); alternative[0].fullTextAnnotation.text = 'blindly when blindely';
  alternative[0].fullTextAnnotation.pages[0].blocks[0].paragraphs[0].words[0].symbols = [...'blindly'].map(text => ({ text, confidence: .98 }));
  const b = await replay('provider-replay-b', alternative);
  const cb = buildCanonicalSubmissionTranscript(b);
  expect(ca.text).not.toBe(cb.text);
  expect(a.ocrPages[0].sourceSha256).toBe(b.ocrPages[0].sourceSha256);
  expect(a.ocrPages[0].ocrInputSha256).toBe(b.ocrPages[0].ocrInputSha256);
  expect(buildCanonicalCorrectionRenderModels(old, cb, b.ocrPages, { submission: b })[0].renderTarget.source).toBe('none');
  const ownSpan = cb.wordSpans[2];
  const own = bindCorrections([normalizeCorrection({ symbol: 'SP', quotedText: 'blindely', suggestedText: 'blindly',
    startChar: ownSpan.start, endChar: ownSpan.end }, cb.text, cb.wordSpans, defaultLegend(), 'AI')], cb, b);
  expect(buildCanonicalCorrectionRenderModels(own, cb, b.ocrPages, { submission: b })[0].renderTarget.wordIds).toEqual([ownSpan.wordId]);
  const loadFile = async () => ({ buffer: fixed.buffer, sourceInfo: fixed.source });
  const compared = compareRuns(await snapshotRun({ submission: a, loadFile, sourceSha256: fixed.source.sha256 }),
    await snapshotRun({ submission: b, loadFile, sourceSha256: fixed.source.sha256 }));
  expect(compared.classifications).toContain('OCR_PROVIDER_VARIANCE');
  expect(compared.classifications).not.toContain('GEOMETRY_VARIANCE');
  expect(compared.checks.ocrBoxesWithinTolerance).toBe(true);
  expect(compared.changedWordPositions).toBe(1);
  expect(compared.checks.scoringIdentical).toBeNull();
});
