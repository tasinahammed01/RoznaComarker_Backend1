const { getNormalizedSubmissionTranscript, normalizeOcrTranscript } = require('../utils/ocrTranscriptNormalizer');

const RUBRIC_MAX = Object.freeze({
  CONTENT: 20,
  ORGANIZATION: 20,
  GRAMMAR: 25,
  VOCABULARY: 20,
  MECHANICS: 10,
  PRESENTATION: 5
});

const ASSESSMENT_VERSION = 'writing-rubric-100-v2';
const EVALUATION_VERSION = 'canonical-evaluation-2';

// Symbol severities are intentionally conservative. Unknown symbols get the
// default penalty so newly-added correction symbols cannot be treated as free.
const SYMBOL_SEVERITY = Object.freeze({
  GRAMMAR: Object.freeze({
    AGR: 1.35, SVA: 1.35, TENSE: 1.25, VERB: 1.2, FRAG: 1.25, RUNON: 1.25,
    WO: 1.05, PREP: 0.95, ART: 0.8, PRON: 1.0, DEFAULT: 1.0
  }),
  MECHANICS: Object.freeze({
    SP: 1.15, SPELLING: 1.15, P: 1.0, PUNCT: 1.0, CAP: 0.9, TYP: 0.7,
    SPACE: 0.65, DEFAULT: 0.85
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
  const severity = SYMBOL_SEVERITY[category] || {};
  const occurrences = new Map();
  let total = 0;
  for (const correction of categoryCorrections(corrections, category)) {
    const symbol = String(correction?.symbol || 'DEFAULT').toUpperCase();
    const key = `${symbol}:${String(correction?.quotedText || '').toLowerCase()}`;
    const seen = occurrences.get(key) || 0;
    occurrences.set(key, seen + 1);
    const repeatedFactor = seen === 0 ? 1 : Math.pow(0.72, seen);
    const confidence = Number(correction?.confidence);
    const confidenceFactor = Number.isFinite(confidence) ? Math.max(0.65, Math.min(1.1, confidence)) : 0.9;
    total += (severity[symbol] || severity.DEFAULT || 1) * repeatedFactor * confidenceFactor;
  }
  return total;
}

function scoreFromWeightedIssues({ corrections, category, maxScore, wordCount }) {
  if (!wordCount) return { score: 0, weightedPenalty: 0, density: 0, issueCount: categoryCorrections(corrections, category).length };
  const issueCount = categoryCorrections(corrections, category).length;
  const weightedPenalty = weightedIssuePenalty(corrections, category);
  const density = weightedPenalty / Math.max(120, wordCount);
  const raw = maxScore - (weightedPenalty * (maxScore === 25 ? 0.78 : 0.46)) - (density * maxScore * 3.25);
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
    comment: `Presentation score is provisional pending teacher review. Automated evidence only confirms page completeness/OCR readability (${readableCount}/${pageCount} pages readable); handwriting neatness was not evaluated.` };
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
  gradeFromOverallScore
};
