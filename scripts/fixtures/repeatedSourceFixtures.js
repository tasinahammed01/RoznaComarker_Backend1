'use strict';
const sharp = require('sharp');
const { digest, inspectBytes } = require('../../src/services/repeatedSourceConsistency.service');
const { buildCanonicalSubmissionTranscript, CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../../src/utils/ocrTranscriptNormalizer');
const { normalizeCorrection, mergeCanonicalCorrections, VERSION, statistics } = require('../../src/services/correctionCanonical.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../../src/services/rubricLanguageScoring.service');
const { bindCorrections } = require('../../src/services/correctionEvidenceIdentity.service');
const { defaultLegend } = require('../../src/services/writingCorrections.service');
async function fixtures() {
  const display = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f5f5f5' } })
    .composite([{ input: Buffer.from('<svg width="800" height="600"><rect x="80" y="120" width="120" height="24" fill="#00c800"/></svg>') }])
    .png().toBuffer();
  const buffer = await sharp(display).rotate(180).jpeg({ quality: 95 }).withMetadata({ orientation: 3 }).toBuffer();
  const normalizedInputHash = digest(await sharp(buffer).rotate().toBuffer());
  const source = await inspectBytes(buffer);
  const rows = [];
  for (let index = 0; index < 5; index++) {
    const fileId = `fixture-file-${index}`;
    const submission = { _id: `fixture-run-${index}`, assignment: 'same-assignment', ocrJobId: `fixture-ocr-${index}`,
      fileContentIdentity: digest(Buffer.from(source.sha256)), files: [fileId], ocrStatus: 'completed', evaluationStatus: 'completed',
      correctionStatus: 'completed', semanticStatus: 'completed', assessmentStatus: 'complete',
      correctionSourceHash: 'fixture-corrections', correctionVersion: VERSION,
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationVersion: EVALUATION_VERSION,
      correctionGenerationConfig: { provider: 'mock-replay', model: 'captured-output', temperature: 0, topP: null, seed: null,
        promptVersion: 'fixture-prompt-v1', schemaVersion: 'fixture-schema-v1', responseFormat: 'json' },
      ocrPages: [{ fileId, pageNumber: 1, width: 800, height: 600, ocrImageWidth: 800, ocrImageHeight: 600,
        coordinateSpace: 'display-image', ocrExifOrientation: 3, sourceSha256: source.sha256,
        ocrInputSha256: normalizedInputHash,
        ocrProvider: 'mock-replay', ocrPipelineVersion: 'fixture-v1', rawText: 'blindely when blindely',
        words: ['blindely', 'when', 'blindely'].map((text, i) => ({ id: `word_${fileId}_1_${i + 1}`, text,
          paragraphIndex: 1, confidence: .98, bbox: { x: 10 + i * 25, y: 20, w: 15, h: 4 } })) }] };
    const canonical = buildCanonicalSubmissionTranscript(submission);
    const corrections = [0, 2].map(i => normalizeCorrection({ symbol: 'SP', quotedText: 'blindely', suggestedText: 'blindly',
      startChar: canonical.wordSpans[i].start, endChar: canonical.wordSpans[i].end, message: 'Check spelling.' },
    canonical.text, canonical.wordSpans, defaultLegend(), 'AI'));
    const merged = mergeCanonicalCorrections({ aiCorrections: [...corrections, { ...corrections[0], message: 'Equivalent explanation.' }] });
    submission.writingCorrections = bindCorrections(merged.corrections, canonical, submission);
    submission.correctionStatistics = statistics(submission.writingCorrections);
    rows.push({ submission, feedback: { evaluationPolicyHash: 'fixture-policy', evaluationRubricSourceHash: 'fixture-rubric',
      evaluationSourceHash: 'fixture-corrections', assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
      overallScore: 82, rubricScores: { MECHANICS: { score: 8, maxScore: 10 } } },
    loadFile: async () => ({ buffer, sourceInfo: source }), sourceSha256: source.sha256, fixtureMergeDiagnostics: merged.diagnostics });
  }
  return { rows, source, buffer };
}
module.exports = { fixtures };
