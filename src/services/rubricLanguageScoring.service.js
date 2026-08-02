const { getNormalizedSubmissionTranscript, normalizeOcrTranscript } = require('../utils/ocrTranscriptNormalizer');

const RUBRIC_MAX = Object.freeze({
  CONTENT: 20,
  ORGANIZATION: 20,
  GRAMMAR: 25,
  VOCABULARY: 20,
  MECHANICS: 10,
  PRESENTATION: 5
});

const ASSESSMENT_VERSION = 'writing-rubric-100-v4-legend-deductions';
const EVALUATION_VERSION = 'canonical-evaluation-7-conclusion-evidence';

// Symbol severities are intentionally conservative. Unknown symbols get the
// default penalty so newly-added correction symbols cannot be treated as free.
const SYMBOL_SEVERITY = Object.freeze({
  GRAMMAR: Object.freeze({
    AGR: 1.35, SVA: 1.35, T: 1.25, TENSE: 1.25, VF: 1.2, VERB: 1.2,
    FRAG: 1.25, RO: 1.25, RUNON: 1.25,
    WO: 1.05, PREP: 0.95, ART: 0.8, PRON: 1.0, DEFAULT: 1.0
  }),
  MECHANICS: Object.freeze({
    SP: 1.15, SPELLING: 1.15, P: 1.0, PUNCT: 1.0, CAP: 0.9, TYP: 0.7,
    SPC: 0.65, SPACE: 0.65, FMT: 0.7, DEFAULT: 0.85
  })
});

const roundToHalf = (value) => Math.round((Number(value) || 0) * 2) / 2;
const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

function normalizedTranscript(submission, transcriptText) {
  return normalizeOcrTranscript(transcriptText || getNormalizedSubmissionTranscript(submission || {}));
}

function categoryCorrections(corrections, category) {
  return (Array.isArray(corrections) ? corrections : []).filter((item) => item?.category === category);
}

function weightedIssuePenalty(corrections, category) {
  return categoryCorrections(corrections, category).reduce((total, correction) => {
    const applied = Number(correction?.appliedDeduction);
    if (Number.isFinite(applied) && applied >= 0) return total + applied;
    const base = Number(correction?.defaultDeduction);
    return total + (Number.isFinite(base) && base >= 0 ? base : 0);
  }, 0);
}

function scoringAudit({ corrections, category, maxScore, wordCount }) {
  const groups = new Map();
  for (const correction of categoryCorrections(corrections, category)) {
    const symbol = String(correction?.symbol || 'DEFAULT').toUpperCase();
    const key = `${symbol}:CANONICAL_PATTERN`;
    const group = groups.get(key) || { key, symbol, ruleId: null, count: 0,
      severityWeight: Number(correction?.defaultDeduction) || 0, weightedPenalty: 0 };
    const factor = Number.isFinite(Number(correction?.repetitionFactor)) ? Number(correction.repetitionFactor) : 1;
    group.count += 1;
    group.weightedPenalty += group.severityWeight * factor;
    groups.set(key, group);
  }
  const weightedPenalty = [...groups.values()].reduce((sum, group) => sum + group.weightedPenalty, 0);
  const density = wordCount ? weightedPenalty / Math.max(120, wordCount) : 0;
  const baseDeduction = Math.min(maxScore * 0.75, weightedPenalty);
  const densityDeduction = 0;
  const unclampedScore = maxScore - baseDeduction - densityDeduction;
  return { category, wordCount, issueCount: categoryCorrections(corrections, category).length,
    groups: [...groups.values()], weightedPenalty, density, baseDeduction, densityDeduction,
    unclampedScore, score: scoreFromWeightedIssues({ corrections, category, maxScore, wordCount }).score };
}

function scoreFromWeightedIssues({ corrections, category, maxScore, wordCount }) {
  if (!wordCount) return { score: 0, weightedPenalty: 0, density: 0, issueCount: categoryCorrections(corrections, category).length };
  const issueCount = categoryCorrections(corrections, category).length;
  const weightedPenalty = weightedIssuePenalty(corrections, category);
  const density = weightedPenalty / Math.max(120, wordCount);
  const raw = maxScore - Math.min(maxScore * 0.75, weightedPenalty);
  let score = roundToHalf(clamp(raw, maxScore));
  if (issueCount > 0) score = Math.min(score, maxScore - 0.5);
  return { score, weightedPenalty, density, issueCount };
}

function languageComment(label, count, score, maxScore, density) {
  if (count === 0) return `0 ${label} issues detected. No validated ${label} errors were found in the canonical corrections.`;
  const ratio = score / maxScore;
  const issueText = `${count} ${label} issue${count === 1 ? '' : 's'} detected`;
  if (ratio >= 0.88 && count <= 3) return `${issueText}. Overall control is strong, with limited revision needed.`;
  if (ratio >= 0.75) return `${issueText}. Accuracy is generally controlled, but the recorded patterns should be revised.`;
  if (ratio >= 0.55) return `${issueText}. Several repeated patterns affect clarity and should be corrected.`;
  return `${issueText}. Frequent high-impact errors significantly affect readability.`;
}

function scoreGrammar({ corrections, wordCount }) {
  const result = scoreFromWeightedIssues({ corrections, category: 'GRAMMAR', maxScore: RUBRIC_MAX.GRAMMAR, wordCount });
  return { score: result.score, maxScore: RUBRIC_MAX.GRAMMAR, issueCount: result.issueCount,
    comment: languageComment('grammar', result.issueCount, result.score, RUBRIC_MAX.GRAMMAR, result.density) };
}

function scoreMechanics({ corrections, wordCount }) {
  const result = scoreFromWeightedIssues({ corrections, category: 'MECHANICS', maxScore: RUBRIC_MAX.MECHANICS, wordCount });
  return { score: result.score, maxScore: RUBRIC_MAX.MECHANICS, issueCount: result.issueCount,
    comment: languageComment('mechanics', result.issueCount, result.score, RUBRIC_MAX.MECHANICS, result.density) };
}

function scorePresentation(submission) {
  const pages = Array.isArray(submission?.ocrPages) ? submission.ocrPages : [];
  const readable = pages.filter((page) => String(page?.text || '').trim().length > 50).length;
  const pageCount = pages.length || (String(submission?.ocrText || submission?.transcriptText || '').trim() ? 1 : 0);
  const readableCount = readable || (pageCount && String(submission?.ocrText || submission?.transcriptText || '').trim().length > 50 ? 1 : 0);
  const ratio = pageCount ? readableCount / pageCount : 0;
  const score = pageCount ? roundToHalf(clamp(RUBRIC_MAX.PRESENTATION * (ratio >= 0.95 ? 0.9 : ratio >= 0.67 ? 0.75 : 0.5), RUBRIC_MAX.PRESENTATION)) : 0;
  return { score, maxScore: RUBRIC_MAX.PRESENTATION, issueCount: 0,
    comment: `Automated Presentation & Submission Quality score included in the overall result: page completeness/OCR readability only (${readableCount}/${pageCount} pages readable). Handwriting neatness was not scored and requires teacher review.` };
}

function gradeFromOverallScore(overallScore) {
  const score = clamp(overallScore, 100);
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

module.exports = {
  ASSESSMENT_VERSION,
  EVALUATION_VERSION,
  RUBRIC_MAX,
  SYMBOL_SEVERITY,
  countWords,
  normalizedTranscript,
  scoreGrammar,
  scoreMechanics,
  scorePresentation,
  weightedIssuePenalty,
  scoreFromWeightedIssues,
  scoringAudit,
  gradeFromOverallScore
};
