'use strict';
const crypto = require('crypto');
const sharp = require('sharp');
const { hash } = require('../utils/assessmentInputIdentity');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const { buildCanonicalCorrectionRenderModels } = require('./canonicalCorrectionRender.service');
const { annotationImageGeometry } = require('./annotationImageGeometry.service');
const { correctionFingerprint } = require('./correctionEvidenceIdentity.service');
const { buildCanonicalResultState } = require('./canonicalResultState.service');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const snippet = text => String(text || '').replace(/\s+/gu, ' ').slice(0, 64);
const normalized = text => String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const sorted = items => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function inspectBytes(buffer) {
  const sha256 = digest(buffer);
  if (buffer.subarray(0, 5).toString() === '%PDF-') return { sha256, byteIdentityVerified: true, mimeType: 'application/pdf', width: null, height: null, orientation: null };
  const m = await sharp(buffer).metadata();
  if (!['jpeg', 'png', 'webp'].includes(m.format)) throw new Error('Unsupported source media');
  return { sha256, byteIdentityVerified: true, mimeType: `image/${m.format}`, width: m.width, height: m.height, orientation: m.orientation || 1 };
}
function scoreIdentity(feedback = {}, submission = {}) {
  const scores = Object.fromEntries(Object.entries(feedback.rubricScores || {}).map(([key, item]) => [key,
    { score: item?.score ?? null, maxScore: item?.maxScore ?? null }]));
  return { evaluationStatus: submission.evaluationStatus || feedback.evaluationStatus || null,
    overallScore: feedback.overallScore ?? null, grade: feedback.grade ?? null, rubricScores: scores,
    customRubricScores: (feedback.customRubricScores?.criteria || []).map(c => ({ criterionId: c.criterionId,
      weightedPoints: c.weightedPoints, selectedLevel: c.selectedLevel })),
    canonicalResultVersion: feedback.evaluationVersion || submission.evaluationVersion || null };
}
function samplingConfig(submission) {
  // Missing historic configuration is unknown; never replace it with today's env.
  return submission.correctionGenerationConfig || { provider: submission.semanticProvider || null,
    model: submission.semanticModel || null, temperature: null, topP: null, seed: null,
    responseFormat: null, promptVersion: submission.semanticPromptVersion || null, schemaVersion: null };
}
async function snapshotRun({ submission, feedback = {}, loadFile, sourceSha256 = null, details = false }) {
  const canonical = buildCanonicalSubmissionTranscript(submission);
  const authority = buildCanonicalResultState({ submission, feedback });
  const corrections = buildCanonicalCorrectionRenderModels(submission.writingCorrections || [], canonical, submission.ocrPages || [], { submission });
  const logicalIds = new Map(); const words = []; const geometry = []; const sources = [];
  for (let index = 0; index < canonical.pages.length; index++) {
    const page = canonical.pages[index];
    const stored = (submission.ocrPages || []).find(p => String(p.fileId) === String(page.fileId) && Number(p.pageNumber || 1) === page.pageNumber) || {};
    const file = await loadFile(String(page.fileId));
    sources.push({ fileId: String(page.fileId), sha256: file?.sourceInfo?.sha256 || stored.sourceSha256 || sourceSha256,
      byteIdentityVerified: file?.sourceInfo?.byteIdentityVerified === true,
      width: file?.sourceInfo?.width ?? stored.encodedImageWidth ?? null,
      height: file?.sourceInfo?.height ?? stored.encodedImageHeight ?? null,
      mimeType: file?.sourceInfo?.mimeType || stored.sourceMimeType || null,
      exifOrientation: file?.sourceInfo?.orientation ?? stored.ocrExifOrientation ?? null,
      normalizedWidth: stored.ocrImageWidth || stored.width || null, normalizedHeight: stored.ocrImageHeight || stored.height || null,
      coordinateSpace: stored.coordinateSpace || null, provider: stored.ocrProvider || null, api: stored.ocrApi || null,
      normalizedInputSha256: stored.ocrInputSha256 || null,
      model: null, pipelineVersion: stored.ocrPipelineVersion || null, preprocessingVersion: stored.ocrPreprocessingVersion || null,
      ocrRunId: stored.ocrRunId || submission.ocrJobId || null, ocrCreatedAt: stored.ocrCreatedAt || submission.ocrUpdatedAt || null });
    geometry.push(await annotationImageGeometry(stored, loadFile) || null);
    (page.words || []).forEach((w, position) => {
      const logicalId = `${index}:${page.pageNumber}:${position}`; logicalIds.set(String(w.id), logicalId);
      const b = w.bbox || {};
      words.push({ id: String(w.id), logicalId, text: w.text, confidence: w.confidence ?? null,
        bbox: { x: b.x ?? b.x0, y: b.y ?? b.y0, w: b.w ?? b.x1 - b.x0, h: b.h ?? b.y1 - b.y0 }, polygon: w.polygon || null });
    });
  }
  const logical = ids => (ids || []).map(id => logicalIds.get(String(id)) || 'unresolved');
  const identities = corrections.map(c => ({ fingerprint: correctionFingerprint(c, canonical, submission),
    category: c.canonicalCategory || c.category || null, symbol: c.symbol, quoteHash: hash(c.quotedText || c.originalText || ''),
    suggestionHash: hash(c.suggestedText || ''), start: c.startChar, end: c.endChar }));
  const targets = corrections.map((c, i) => ({ fingerprint: identities[i].fingerprint,
    evidence: logical(c.evidenceWordIds || c.wordIds), target: logical(c.renderTarget.wordIds),
    anchors: c.renderTarget.anchors.map(a => ({ ...a, wordId: logicalIds.get(a.wordId) || 'unresolved' })),
    boxes: c.renderTarget.boxes, ranges: c.renderTarget.textRanges, source: c.renderTarget.source,
    verification: c.targetVerification || null }));
  if (!sources.length) for (const id of submission.files || (submission.file ? [submission.file] : [])) {
    const file = await loadFile(String(id)); const info = file?.sourceInfo;
    sources.push({ fileId: String(id), sha256: info?.sha256 || sourceSha256,
      byteIdentityVerified: info?.byteIdentityVerified === true, width: info?.width || null, height: info?.height || null,
      mimeType: info?.mimeType || null, exifOrientation: info?.orientation || null,
      normalizedWidth: null, normalizedHeight: null, coordinateSpace: null, provider: null, model: null });
  }
  const availableRaw = (submission.ocrPages || []).length > 0 && submission.ocrPages.every(p => typeof p.rawText === 'string');
  const projection = geometry.map(g => g ? { width: g.width, height: g.height, orientation: g.orientation,
    coordinateSpace: g.coordinateSpace, ambiguous: g.ambiguous } : null);
  const result = { runId: String(submission._id), recordKind: submission.recordKind || 'submission',
    ocrRunId: submission.ocrJobId || null, sourceSha256, bundleIdentity: submission.fileContentIdentity || null, sources,
    lifecycle: { ocrStatus: submission.ocrStatus || null, correctionStatus: submission.correctionStatus || null,
      semanticStatus: submission.semanticStatus || null, assessmentStatus: submission.assessmentStatus || null,
      completedAt: submission.assessmentCompletedAt || null },
    versions: { correction: submission.correctionVersion || null, layout: canonical.version,
      legend: submission.correctionLegendVersion || null, correctionSourceHash: submission.correctionSourceHash || null,
      semanticSourceKey: submission.semanticSourceKey || null },
    aiExecution: { attempts: (submission.semanticMetrics?.attempts || []).map(a => ({
      provider: a.provider || null, model: a.model || null, fallbackIndex: a.fallbackIndex ?? null,
      status: a.status || a.code || null })),
      persistedCanonicalFingerprint: submission.semanticMetrics?.semanticCanonicalFingerprint || null },
    evaluationModel: { provider: feedback.evaluationProvider || null, model: feedback.evaluationModel || null },
    canonicalAuthority: { comparisonBasis: 'persisted-run-state', correctionCurrent: authority.correctionCurrent,
      correctionsAvailable: authority.correctionsAvailable, correctionStage: authority.correctionStage,
      evaluationCurrent: authority.evaluationCurrent, evaluationFreshness: authority.evaluationFreshness,
      detailedFeedbackCurrent: authority.detailedFeedbackCurrent },
    policy: { assignmentIdentity: submission.assignment ? hash(String(submission.assignment)) : null, policyHash: feedback.evaluationPolicyHash || submission.evaluationPolicyHash || null,
      rubricHash: feedback.evaluationRubricSourceHash || submission.evaluationRubricSourceHash || null,
      rubricVersion: feedback.assessmentVersion || null }, modelConfiguration: samplingConfig(submission),
    ocr: { transcriptHash: digest(Buffer.from(canonical.text)), normalizedTranscriptHash: digest(Buffer.from(normalized(canonical.text))),
      rawTranscriptHash: availableRaw ? hash((submission.ocrPages || []).map(p => p.rawText)) : null,
      wordCount: words.length, wordIdsHash: hash(words.map(w => w.id)), logicalWordsHash: hash(words.map(w => [w.logicalId, w.text])),
      boxesHash: hash(words.map(w => [w.logicalId, w.bbox, w.polygon])), layoutVersion: canonical.version,
      ...(details ? { transcriptSnippet: snippet(canonical.text) } : {}), fullTranscriptAvailable: Boolean(canonical.text) },
    corrections: { count: corrections.length, dataAvailable: corrections.length > 0 || ['completed', 'partial'].includes(submission.correctionStatus),
      identityHash: hash(sorted(identities)), targetHash: hash(sorted(targets)),
      objectiveIdentityHash: hash(sorted(identities.filter(i => ['GRAMMAR', 'MECHANICS'].includes(i.category)))),
      semanticIdentityHash: hash(sorted(identities.filter(i => ['CONTENT', 'ORGANIZATION'].includes(i.category)))),
      categoryCounts: corrections.reduce((counts, c) => { counts[c.category || 'UNKNOWN'] = (counts[c.category || 'UNKNOWN'] || 0) + 1; return counts; }, {}),
      wordingHash: hash(sorted(corrections.map((c, i) => [identities[i].fingerprint, c.message || '']))),
      objectiveCount: corrections.filter(c => ['GRAMMAR', 'MECHANICS'].includes(c.category)).length,
      semanticCount: corrections.filter(c => ['CONTENT', 'ORGANIZATION'].includes(c.category)).length,
      markerCount: targets.filter(t => t.source !== 'none').length, rejectedCount: targets.filter(t => t.source === 'none').length,
      fingerprints: identities.map(i => i.fingerprint) },
    scoring: scoreIdentity(feedback, submission), geometryProjectionHash: hash({ projection,
      wordBoxes: words.map(w => [w.logicalId, w.bbox, w.polygon]) }),
    geometryAvailable: geometry.length > 0 && geometry.every(g => g && !g.ambiguous),
    availability: { rawVisionResponse: false, polygons: words.some(w => w.polygon), historicalSampling: Boolean(submission.correctionGenerationConfig),
      scoring: feedback.overallScore != null || Object.keys(feedback.rubricScores || {}).length > 0 } };
  if (details) Object.assign(result, { words, geometry, correctionDetails: corrections.map(c => ({
    id: c.id, fingerprint: correctionFingerprint(c, canonical, submission), category: c.category, symbol: c.symbol,
    originalText: snippet(c.originalText), quotedText: snippet(c.quotedText), startChar: c.startChar, endChar: c.endChar,
    modelCategory: c.modelCategory || null, canonicalCategory: c.canonicalCategory || c.category,
    categoryRemapped: Boolean(c.categoryRemapped), evidenceWordIds: c.evidenceWordIds || c.wordIds,
    visualTarget: c.visualTarget || null, renderTarget: c.renderTarget,
    bboxList: c.bboxList || [], verification: c.targetVerification || null, ocrRunId: c.ocrRunId || null,
    ocrEvidenceHash: c.ocrEvidenceHash || null, authority: c.renderTarget.source === 'none' ? 'unsupported' : 'current-ocr-evidence' })) });
  // Private complete evidence is used for comparison, never serialized into logs by default.
  Object.defineProperty(result, '_comparison', { value: { text: canonical.text, words, targets, projection } });
  return result;
}
function compareRuns(a, b, tolerance = .5) {
  const equal = (x, y) => hash(x) === hash(y);
  const sourceHashes = row => [...new Map(row.sources.map(s => [s.fileId, s.sha256])).values()];
  const aw = a._comparison.words, bw = b._comparison.words;
  const transcriptsAvailable = a.ocr.fullTranscriptAvailable && b.ocr.fullTranscriptAvailable;
  const wordsAvailable = aw.length > 0 && bw.length > 0;
  const correctionsAvailable = a.corrections.dataAvailable && b.corrections.dataAvailable;
  let maxDelta = 0;
  // Recognition text can change while all polygons remain identical. Compare
  // geometric positions independently rather than mislabeling text-only variance.
  const aligned = aw.length === bw.length;
  if (aligned) aw.forEach((w, i) => ['x', 'y', 'w', 'h'].forEach(key => { maxDelta = Math.max(maxDelta, Math.abs(w.bbox[key] - bw[i].bbox[key])); }));
  const checks = {
    sourceIdentical: a.sourceSha256 && b.sourceSha256 ? a.sourceSha256 === b.sourceSha256 : null,
    sourceBytesVerifiedIdentical: a.sources.length > 0 && b.sources.length > 0
      && a.sources.every(s => s.byteIdentityVerified) && b.sources.every(s => s.byteIdentityVerified)
      ? equal(sourceHashes(a), sourceHashes(b)) : null,
    ocrTranscriptIdentical: transcriptsAvailable ? a.ocr.transcriptHash === b.ocr.transcriptHash : null,
    rawOcrTranscriptIdentical: a.ocr.rawTranscriptHash && b.ocr.rawTranscriptHash ? a.ocr.rawTranscriptHash === b.ocr.rawTranscriptHash : null,
    normalizedOcrInputIdentical: a.sources.length > 0 && b.sources.length > 0
      && a.sources.every(s => s.normalizedInputSha256) && b.sources.every(s => s.normalizedInputSha256)
      ? equal(a.sources.map(s => s.normalizedInputSha256), b.sources.map(s => s.normalizedInputSha256)) : null,
    ocrWordIdsIdentical: wordsAvailable ? a.ocr.wordIdsHash === b.ocr.wordIdsHash : null,
    logicalWordPositionsIdentical: wordsAvailable ? a.ocr.logicalWordsHash === b.ocr.logicalWordsHash : null,
    ocrBoxesWithinTolerance: wordsAvailable ? aligned && Number.isFinite(maxDelta) && maxDelta <= tolerance : null,
    correctionSetIdentical: correctionsAvailable ? a.corrections.identityHash === b.corrections.identityHash : null,
    objectiveCorrectionSetIdentical: correctionsAvailable ? a.corrections.objectiveIdentityHash === b.corrections.objectiveIdentityHash : null,
    semanticCorrectionSetIdentical: correctionsAvailable ? a.corrections.semanticIdentityHash === b.corrections.semanticIdentityHash : null,
    correctionTargetsIdentical: correctionsAvailable ? a.corrections.targetHash === b.corrections.targetHash : null,
    canonicalAuthorityIdentical: equal(a.canonicalAuthority, b.canonicalAuthority),
    scoringIdentical: a.availability.scoring && b.availability.scoring ? equal(a.scoring, b.scoring) : null,
    geometryProjectionIdentical: a.geometryAvailable && b.geometryAvailable ? a.geometryProjectionHash === b.geometryProjectionHash : null,
    policyIdentical: a.policy.policyHash && b.policy.policyHash && a.policy.rubricHash && b.policy.rubricHash
      ? equal(a.policy, b.policy) : ['assignmentIdentity', 'policyHash', 'rubricHash'].some(key => a.policy[key] && b.policy[key]
        && a.policy[key] !== b.policy[key]) ? false : null,
    modelConfigurationIdentical: a.availability.historicalSampling && b.availability.historicalSampling
      ? equal(a.modelConfiguration, b.modelConfiguration)
      : ['provider', 'model', 'promptVersion'].some(key => a.modelConfiguration[key] && b.modelConfiguration[key]
        && a.modelConfiguration[key] !== b.modelConfiguration[key]) ? false : null
  };
  const sameVisible = checks.ocrTranscriptIdentical && checks.correctionSetIdentical && checks.correctionTargetsIdentical
    && checks.canonicalAuthorityIdentical && checks.scoringIdentical && checks.geometryProjectionIdentical === true
    && checks.sourceIdentical === true && checks.policyIdentical && checks.modelConfigurationIdentical === true;
  checks.onlyAIExplanationWordingDifferent = sameVisible && a.corrections.wordingHash !== b.corrections.wordingHash;
  const classes = [];
  if (checks.sourceIdentical === false || checks.sourceBytesVerifiedIdentical === false) classes.push('SOURCE_DIFFERENCE');
  if (checks.ocrTranscriptIdentical === false) classes.push(a.ocr.rawTranscriptHash && a.ocr.rawTranscriptHash === b.ocr.rawTranscriptHash
    ? 'OCR_NORMALIZATION_VARIANCE' : 'OCR_PROVIDER_VARIANCE');
  else if (checks.rawOcrTranscriptIdentical === false) classes.push('OCR_PROVIDER_VARIANCE');
  if (checks.sourceIdentical === true && checks.normalizedOcrInputIdentical === false) classes.push('OCR_NORMALIZATION_VARIANCE');
  if (checks.ocrWordIdsIdentical === false && checks.logicalWordPositionsIdentical === true
      && checks.ocrTranscriptIdentical === true && equal(a.sources.map(s => s.fileId), b.sources.map(s => s.fileId))) classes.push('WORD_ID_INSTABILITY');
  if (checks.correctionSetIdentical === false) classes.push('AI_CORRECTION_VARIANCE');
  if (checks.correctionSetIdentical === true && checks.correctionTargetsIdentical === false) classes.push('TARGET_RESOLUTION_VARIANCE');
  if (checks.ocrBoxesWithinTolerance === false || checks.geometryProjectionIdentical === false) classes.push('GEOMETRY_VARIANCE');
  if (checks.policyIdentical === false) classes.push('POLICY_VARIANCE');
  if (checks.modelConfigurationIdentical === false) classes.push('MODEL_CONFIGURATION_VARIANCE');
  if (checks.onlyAIExplanationWordingDifferent || (checks.ocrWordIdsIdentical === false && checks.logicalWordPositionsIdentical
      && !equal(a.sources.map(s => s.fileId), b.sources.map(s => s.fileId)))) classes.push('EXPECTED_PRESENTATION_ONLY_VARIANCE');
  const textA = a._comparison.text, textB = b._comparison.text;
  let first = 0; while (first < Math.min(textA.length, textB.length) && textA[first] === textB[first]) first++;
  return { from: a.runId, to: b.runId, checks, classifications: [...new Set(classes)],
    bboxTolerancePercent: tolerance, maximumBoxDeltaPercent: wordsAvailable && aligned && Number.isFinite(maxDelta) ? maxDelta : null,
    changedWordPositions: wordsAvailable ? aw.filter((w, i) => w.text !== bw[i]?.text).length + Math.max(0, bw.length - aw.length) : null,
    transcriptDifference: checks.ocrTranscriptIdentical !== false ? null : { offset: first, before: snippet(textA.slice(Math.max(0, first - 16))), after: snippet(textB.slice(Math.max(0, first - 16))) },
    notes: ['Raw provider responses and historical configuration may be absent; classification describes persisted differences, not proof of a provider-internal cause.',
      'Geometry comparison covers server percent axes; browser/device layout requires separate QA.'] };
}
module.exports = { digest, inspectBytes, snapshotRun, compareRuns };
