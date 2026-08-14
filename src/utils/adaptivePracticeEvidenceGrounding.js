'use strict';

const { normalizeOcrTranscript } = require('./ocrTranscriptNormalizer');

function normalizeEvidenceForComparison(value) {
  if (typeof value !== 'string' || !value) return '';
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u00a0\u2007\u202f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function groundAdaptiveEvidence(transcript, evidence) {
  const canonicalEvidence = normalizeOcrTranscript(evidence);
  const normalizedTranscript = normalizeEvidenceForComparison(transcript);
  const normalizedEvidence = normalizeEvidenceForComparison(canonicalEvidence);
  const grounded = Boolean(normalizedEvidence) && normalizedTranscript.includes(normalizedEvidence);
  return {
    grounded,
    evidence: canonicalEvidence,
    diagnostics: {
      comparisonMode: 'nfkc-whitespace-quotes',
      transcriptLength: typeof transcript === 'string' ? transcript.length : 0,
      normalizedTranscriptLength: normalizedTranscript.length,
      evidenceLength: typeof evidence === 'string' ? evidence.length : 0,
      normalizedEvidenceLength: normalizedEvidence.length,
      candidateCount: 0
    }
  };
}

module.exports = { normalizeEvidenceForComparison, groundAdaptiveEvidence };
