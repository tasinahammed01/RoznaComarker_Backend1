const { getNormalizedSubmissionTranscript, normalizeOcrTranscript } = require('../utils/ocrTranscriptNormalizer');

const RUBRIC_MAX = Object.freeze({
  CONTENT: 20,
  ORGANIZATION: 20,
  GRAMMAR: 25,
  VOCABULARY: 20,
  MECHANICS: 10,
  PRESENTATION: 5
});

const ASSESSMENT_VERSION = 'writing-rubric-100-v5-teacher-policy';
const EVALUATION_VERSION = 'canonical-evaluation-9-fixed-skill-isolation';
const SCORING_AUDIT_VERSION = 'canonical-scoring-audit-v1';
const STRICTNESS_THRESHOLDS = Object.freeze({
  friendly: Object.freeze({ multiplier: 0.60, lowImpactTolerance: 2.0, maxDeductionRatio: 0.35 }),
  balanced: Object.freeze({ multiplier: 0.80, lowImpactTolerance: 1.0, maxDeductionRatio: 0.50 }),
  strict: Object.freeze({ multiplier: 1.15, lowImpactTolerance: 0, maxDeductionRatio: 0.78 })
});

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
const auditNumber = (value) => Math.round((Number(value) || 0) * 1000000) / 1000000;
const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

function normalizedTranscript(submission, transcriptText) {
  return normalizeOcrTranscript(transcriptText || getNormalizedSubmissionTranscript(submission || {}));
}

function categoryCorrections(corrections, category) {
  return (Array.isArray(corrections) ? corrections : []).filter((item) => item?.category === category);
}

function ignoredScoringReason(correction, category) {
  if (['GRAMMAR', 'MECHANICS'].includes(category) && correction?.ocrSuspect === true) return 'OCR_SUSPECT';
  return null;
}

function partitionCategoryCorrections(corrections, category) {
  const total = categoryCorrections(corrections, category);
  const counted = [];
  const ignored = [];
  for (const correction of total) {
    const reason = ignoredScoringReason(correction, category);
    if (reason) ignored.push({ correction, reason });
    else counted.push(correction);
  }
  return { total, counted, ignored };
}

function weightedIssuePenalty(corrections, category) {
  return partitionCategoryCorrections(corrections, category).counted.reduce((total, correction) => {
    const applied = Number(correction?.appliedDeduction);
    if (Number.isFinite(applied) && applied >= 0) return total + applied;
    const base = Number(correction?.defaultDeduction);
    return total + (Number.isFinite(base) && base >= 0 ? base : 0);
  }, 0);
}

function scoringAudit({ corrections, category, maxScore, wordCount, strictness = 'balanced' }) {
  const partition = partitionCategoryCorrections(corrections, category);
  const groups = new Map();
  for (const correction of partition.counted) {
    const symbol = String(correction?.symbol || 'DEFAULT').toUpperCase();
    const suggestedText = String(correction?.suggestedText || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
    const key = `${category}|${symbol}|${suggestedText}`;
    const group = groups.get(key) || { key, symbol, ruleId: null, count: 0,
      severityWeight: Number(correction?.defaultDeduction) || 0, weightedPenalty: 0, correctionIds: [] };
    const factor = Number.isFinite(Number(correction?.repetitionFactor)) ? Number(correction.repetitionFactor) : 1;
    group.count += 1;
    group.weightedPenalty += group.severityWeight * factor;
    if (correction?.id != null) group.correctionIds.push(String(correction.id));
    groups.set(key, group);
  }
  const scored = scoreFromWeightedIssues({ corrections, category, maxScore, wordCount, strictness });
  const ignoredReasons = partition.ignored.reduce((out, item) => {
    out[item.reason] = (out[item.reason] || 0) + 1;
    return out;
  }, {});
  const basePenalty = partition.counted.reduce((sum, correction) => {
    const value = Number(correction?.defaultDeduction);
    return sum + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);
  return {
    category, maxScore, wordCount,
    totalIssueCount: partition.total.length,
    countedIssueCount: partition.counted.length,
    ignoredIssueCount: partition.ignored.length,
    ignoredReasons,
    basePenalty: auditNumber(basePenalty),
    repetitionAdjustedPenalty: auditNumber(scored.weightedPenalty),
    weightedPenalty: auditNumber(scored.weightedPenalty),
    density: auditNumber(scored.density),
    tolerance: scored.tolerance,
    multiplier: scored.multiplier,
    maximumDeduction: auditNumber(scored.maximumDeduction),
    cappedDeduction: auditNumber(scored.cappedDeduction),
    unroundedScore: auditNumber(scored.unroundedScore),
    finalScore: scored.score,
    score: scored.score,
    correctionIds: partition.counted.map((item) => String(item?.id || '')).filter(Boolean),
    ignoredCorrectionIds: partition.ignored.map((item) => String(item.correction?.id || '')).filter(Boolean),
    groups: [...groups.values()].map((group) => ({
      ...group, weightedPenalty: auditNumber(group.weightedPenalty)
    }))
  };
}

function scoreFromWeightedIssues({ corrections, category, maxScore, wordCount, strictness = 'balanced' }) {
  const partition = partitionCategoryCorrections(corrections, category);
  const issueCount = partition.counted.length;
  const thresholds = STRICTNESS_THRESHOLDS[strictness] || STRICTNESS_THRESHOLDS.balanced;
  const maximumDeduction = maxScore * thresholds.maxDeductionRatio;
  if (!wordCount) return { score: 0, weightedPenalty: 0, density: 0, issueCount,
    totalIssueCount: partition.total.length, ignoredIssueCount: partition.ignored.length,
    tolerance: thresholds.lowImpactTolerance, multiplier: thresholds.multiplier,
    maximumDeduction, cappedDeduction: 0, unroundedScore: 0 };
  const weightedPenalty = weightedIssuePenalty(corrections, category);
  const density = weightedPenalty / Math.max(120, wordCount);
  const adjustedPenalty = Math.max(0, weightedPenalty - thresholds.lowImpactTolerance) * thresholds.multiplier;
  const cappedDeduction = Math.min(maximumDeduction, adjustedPenalty);
  const raw = maxScore - cappedDeduction;
  let score = roundToHalf(clamp(raw, maxScore));
  if (issueCount > 0) score = Math.min(score, maxScore - 0.5);
  return { score, weightedPenalty, density, issueCount,
    totalIssueCount: partition.total.length, ignoredIssueCount: partition.ignored.length,
    tolerance: thresholds.lowImpactTolerance, multiplier: thresholds.multiplier,
    maximumDeduction, cappedDeduction, unroundedScore: raw };
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

function scoreGrammar({ corrections, wordCount, strictness = 'balanced', enabled = true }) {
  const source = enabled ? corrections : [];
  const result = scoreFromWeightedIssues({ corrections: source, category: 'GRAMMAR', maxScore: RUBRIC_MAX.GRAMMAR, wordCount, strictness });
  return { score: result.score, maxScore: RUBRIC_MAX.GRAMMAR, issueCount: result.issueCount,
    comment: languageComment('grammar', result.issueCount, result.score, RUBRIC_MAX.GRAMMAR, result.density) };
}

function scoreMechanics({ corrections, wordCount, strictness = 'balanced', enabled = true }) {
  const source = enabled ? corrections : [];
  const result = scoreFromWeightedIssues({ corrections: source, category: 'MECHANICS', maxScore: RUBRIC_MAX.MECHANICS, wordCount, strictness });
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

function applySemanticStrictness(item, strictness = 'balanced') {
  const maxScore = Math.max(0, Number(item?.maxScore) || 20);
  const score = clamp(item?.score, maxScore);
  const deduction = maxScore - score;
  const factor = strictness === 'friendly' ? 0.65 : strictness === 'strict' ? 1.18 : 0.85;
  return { ...item, score: roundToHalf(clamp(maxScore - deduction * factor, maxScore)), maxScore };
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
  SCORING_AUDIT_VERSION,
  RUBRIC_MAX,
  SYMBOL_SEVERITY,
  STRICTNESS_THRESHOLDS,
  countWords,
  normalizedTranscript,
  scoreGrammar,
  scoreMechanics,
  scorePresentation,
  applySemanticStrictness,
  weightedIssuePenalty,
  partitionCategoryCorrections,
  scoreFromWeightedIssues,
  scoringAudit,
  gradeFromOverallScore
};
