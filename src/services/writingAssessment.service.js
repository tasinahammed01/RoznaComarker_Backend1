const logger = require('../utils/logger');
const { buildSubmissionCorrectionStatistics } = require('./submissionCorrectionStatistics.service');
const { getNormalizedSubmissionTranscript, normalizeOcrTranscript } = require('../utils/ocrTranscriptNormalizer');

const RUBRIC_MAX = Object.freeze({
  GRAMMAR: 25,
  VOCABULARY: 20,
  ORGANIZATION: 20,
  CONTENT: 20,
  MECHANICS: 10,
  PRESENTATION: 5
});

const ASSESSMENT_VERSION = 'writing-rubric-100-v1';

const EMPTY_ASSESSMENT = Object.freeze({
  assessmentVersion: ASSESSMENT_VERSION,
  maxOverallScore: 100,
  rubricScores: {
    GRAMMAR: { score: 0, maxScore: RUBRIC_MAX.GRAMMAR, comment: '' },
    VOCABULARY: { score: 0, maxScore: RUBRIC_MAX.VOCABULARY, comment: '' },
    ORGANIZATION: { score: 0, maxScore: RUBRIC_MAX.ORGANIZATION, comment: '' },
    CONTENT: { score: 0, maxScore: RUBRIC_MAX.CONTENT, comment: '' },
    MECHANICS: { score: 0, maxScore: RUBRIC_MAX.MECHANICS, comment: '' },
    PRESENTATION: { score: 0, maxScore: RUBRIC_MAX.PRESENTATION, comment: '' }
  },
  overallScore: 0,
  grade: 'F',
  evidence: {
    wordCount: 0,
    sentenceCount: 0,
    paragraphCount: 0,
    pageCount: 0,
    readablePageCount: 0,
    assignmentPromptAvailable: false,
    correctionCounts: {
      content: 0,
      grammar: 0,
      organization: 0,
      vocabulary: 0,
      mechanics: 0,
      total: 0
    }
  }
});

// Scoring helpers
function clamp(value, max) {
  const num = Number(value) || 0;
  return Math.max(0, Math.min(max, num));
}

function roundToHalf(value) {
  const num = Number(value) || 0;
  return Math.round(num * 2) / 2;
}

function countWords(text) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) return 0;
  return safeText.split(/\s+/).filter(w => w.length > 0).length;
}

function countSentences(text) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) return 0;
  const parts = safeText.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length;
}

function countParagraphs(text) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) return 0;
  return safeText.split(/\n\s*\n+/).map(p => p.trim()).filter(p => p.length > 0).length;
}

function calculateDensity(errorCount, wordCount) {
  if (wordCount === 0) return 0;
  return errorCount / wordCount;
}

function scoreFromDensity(density, maxScore, thresholds) {
  const t = thresholds || { severe: 0.15, high: 0.10, moderate: 0.05, low: 0.02 };
  let score = maxScore;
  
  if (density > t.severe) score = maxScore * 0.3;
  else if (density > t.high) score = maxScore * 0.5;
  else if (density > t.moderate) score = maxScore * 0.7;
  else if (density > t.low) score = maxScore * 0.9;
  
  return roundToHalf(clamp(score, maxScore));
}

function gradeFromOverallScore(overallScore) {
  const score = clamp(overallScore, 100);
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function calculatePresentationEvidence(submission) {
  const ocrPages = Array.isArray(submission.ocrPages) ? submission.ocrPages : [];
  const readablePages = ocrPages.filter(p => p && typeof p.text === 'string' && p.text.trim().length > 50);
  const hasAnyText = readablePages.length > 0;
  const ocrStatus = submission.ocrStatus || 'unknown';
  
  // Also check legacy single-file OCR fields
  const hasLegacyText = typeof submission.ocrText === 'string' && submission.ocrText.trim().length > 50 ||
                        typeof submission.transcriptText === 'string' && submission.transcriptText.trim().length > 50;
  
  const pageCount = ocrPages.length > 0 ? ocrPages.length : (hasLegacyText ? 1 : 0);
  const readablePageCount = readablePages.length > 0 ? readablePages.length : (hasLegacyText ? 1 : 0);
  
  return {
    pageCount,
    readablePageCount,
    hasAnyText: hasAnyText || hasLegacyText,
    ocrStatus,
    appearsIncomplete: pageCount > 0 && readablePageCount === 0
  };
}


function scoreGrammar(correctionStats, wordCount) {
  const grammarErrors = correctionStats.grammar || 0;
  const maxScore = RUBRIC_MAX.GRAMMAR;
  
  if (wordCount === 0) {
    return { score: 0, comment: 'No text to evaluate grammar.' };
  }
  
  const density = calculateDensity(grammarErrors, wordCount);
  const score = scoreFromDensity(density, maxScore);
  
  let severity = 'minimal';
  if (grammarErrors === 0) severity = 'none';
  else if (density > 0.10) severity = 'severe';
  else if (density > 0.05) severity = 'frequent';
  else if (density > 0.02) severity = 'occasional';
  
  const comment = `${grammarErrors} grammar issue${grammarErrors === 1 ? '' : 's'} detected (${severity}). ${
    severity === 'none' ? 'Excellent grammar with no errors.' :
    severity === 'minimal' ? 'Excellent grammar with minimal errors.' :
    severity === 'occasional' ? 'Good grammar with occasional errors; minor impact on readability.' :
    severity === 'frequent' ? 'Grammar needs improvement; frequent errors reduce clarity.' :
    'Severe grammar issues significantly impact readability.'
  }`;
  
  return { score, comment };
}

function scoreVocabulary(correctionStats, wordCount, transcript) {
  const vocabularyErrors = correctionStats.vocabulary || 0;
  const maxScore = RUBRIC_MAX.VOCABULARY;
  
  if (wordCount === 0) {
    return { score: 0, comment: 'No text to evaluate vocabulary.' };
  }
  
  const density = calculateDensity(vocabularyErrors, wordCount);
  let score = scoreFromDensity(density, maxScore, { severe: 0.08, high: 0.05, moderate: 0.02, low: 0.01 });
  
  // Conservative text evidence for vocabulary
  const words = typeof transcript === 'string' ? transcript.toLowerCase().split(/\s+/) : [];
  const uniqueWords = new Set(words.filter(w => w.length > 2));
  const varietyRatio = wordCount > 0 ? uniqueWords.size / wordCount : 0;
  
  if (varietyRatio < 0.3 && wordCount > 50) {
    score = roundToHalf(Math.max(score * 0.8, maxScore * 0.3));
  }
  
  const comment = `${vocabularyErrors} vocabulary issue${vocabularyErrors === 1 ? '' : 's'} detected. ${
    varietyRatio < 0.3 && wordCount > 50 ? 'Limited word variety detected. ' : ''
  }${
    score >= maxScore * 0.8 ? 'Strong vocabulary use with appropriate word choices.' :
    score >= maxScore * 0.6 ? 'Adequate vocabulary with some word choice issues.' :
    'Vocabulary needs improvement; consider word variety and precision.'
  }`;
  
  return { score, comment };
}

function scoreMechanics(correctionStats, wordCount) {
  const mechanicsErrors = correctionStats.mechanics || 0;
  const maxScore = RUBRIC_MAX.MECHANICS;
  
  if (wordCount === 0) {
    return { score: 0, comment: 'No text to evaluate mechanics.' };
  }
  
  const density = calculateDensity(mechanicsErrors, wordCount);
  const score = scoreFromDensity(density, maxScore, { severe: 0.12, high: 0.08, moderate: 0.04, low: 0.02 });
  
  const comment = `${mechanicsErrors} mechanics issue${mechanicsErrors === 1 ? '' : 's'} (spelling, punctuation, capitalization, typography, spacing). ${
    score >= maxScore * 0.9 ? 'Excellent mechanics with very few errors.' :
    score >= maxScore * 0.7 ? 'Good mechanics with minor spelling/punctuation errors.' :
    score >= maxScore * 0.5 ? 'Mechanics need improvement; several errors detected.' :
    'Significant spelling and punctuation issues require attention.'
  }`;
  
  return { score, comment };
}

function scoreOrganization(evidence, correctionStats) {
  const { paragraphCount, sentenceCount, wordCount } = evidence;
  const organizationErrors = correctionStats.organization || 0;
  const maxScore = RUBRIC_MAX.ORGANIZATION;
  
  if (wordCount === 0) {
    return { score: 0, comment: 'No text to evaluate organization.' };
  }
  
  if (wordCount < 50) {
    return { score: roundToHalf(maxScore * 0.5), comment: 'Text too short to assess organization structure.' };
  }
  
  let score = maxScore * 0.6;
  
  // Paragraph structure evidence
  const idealParagraphs = Math.max(1, Math.floor(wordCount / 150));
  const paragraphRatio = paragraphCount / idealParagraphs;
  
  if (paragraphRatio >= 0.8 && paragraphRatio <= 1.5) {
    score = maxScore;
  } else if (paragraphRatio >= 0.5 && paragraphRatio <= 2.0) {
    score = maxScore * 0.8;
  }
  
  // Sentence structure evidence
  if (wordCount > 100 && sentenceCount < 2) {
    score = roundToHalf(score * 0.7);
  }
  
  // Organization corrections impact
  const orgDensity = calculateDensity(organizationErrors, wordCount);
  if (orgDensity > 0.03) {
    score = roundToHalf(score * 0.85);
  }
  
  score = roundToHalf(clamp(score, maxScore));
  
  const comment = `${paragraphCount} paragraph${paragraphCount === 1 ? '' : 's'}, ${sentenceCount} sentence${sentenceCount === 1 ? '' : 's'}. ${organizationErrors} organization issue${organizationErrors === 1 ? '' : 's'}. ${
    score >= maxScore * 0.9 ? 'Well-organized with clear paragraph structure and logical flow.' :
    score >= maxScore * 0.7 ? 'Organization is adequate; structure could be improved for better flow.' :
    'Organization needs improvement; consider paragraph structure and transitions.'
  }`;
  
  return { score, comment };
}

function scorePresentation(presentationEvidence) {
  const { pageCount, readablePageCount, hasAnyText, ocrStatus, appearsIncomplete } = presentationEvidence;
  const maxScore = RUBRIC_MAX.PRESENTATION;
  
  if (pageCount === 0 && !hasAnyText) {
    return { score: 0, comment: 'No pages or text to evaluate presentation.' };
  }
  
  let score = maxScore;
  
  if (!hasAnyText) {
    score = maxScore * 0.3;
  } else {
    const readableRatio = pageCount > 0 ? readablePageCount / pageCount : 1;
    if (readableRatio < 0.5) score = maxScore * 0.5;
    else if (readableRatio < 0.8) score = maxScore * 0.8;
  }
  
  if (appearsIncomplete) {
    score = roundToHalf(score * 0.7);
  }
  
  score = roundToHalf(clamp(score, maxScore));
  
  const comment = `Automated presentation score based on OCR readability and page completeness (${readablePageCount}/${pageCount} pages readable). ${
    score >= maxScore * 0.9 ? 'Good document presentation and readability.' :
    score >= maxScore * 0.7 ? 'Presentation adequate with minor readability issues.' :
    'Presentation could be improved; some pages have readability issues.'
  } Handwriting neatness requires teacher review.`;
  
  return { score, comment };
}

function scoreContent(evidence, assignment, transcript, correctionStats) {
  const { wordCount, paragraphCount } = evidence;
  const contentErrors = correctionStats.content || 0;
  const maxScore = RUBRIC_MAX.CONTENT;
  
  const hasPrompt = Boolean(assignment && assignment.instructions && assignment.instructions.trim().length > 0);
  
  if (wordCount === 0) {
    return { score: 0, comment: 'No content to evaluate.' };
  }
  
  if (!hasPrompt) {
    let score = maxScore * 0.6;
    if (wordCount < 100) score = maxScore * 0.4;
    if (wordCount < 50) score = maxScore * 0.2;
    if (wordCount < 20) score = 0;
    
    score = roundToHalf(clamp(score, maxScore));
    
    const comment = score > 0 
      ? `Conservative score: assignment prompt not available for semantic evaluation. Score based on text length (${wordCount} words) and structure (${paragraphCount} paragraph${paragraphCount === 1 ? '' : 's'}). Semantic prompt alignment requires AI evaluation.`
      : 'Insufficient content to evaluate.';
    
    return { score, comment };
  }
  
  // When prompt is available, use conservative completion evidence
  let score = maxScore * 0.5;
  
  // Length evidence (no fixed thresholds, relative to task)
  if (wordCount >= 200 && paragraphCount >= 2) score = maxScore * 0.65;
  if (wordCount >= 400 && paragraphCount >= 3) score = maxScore * 0.75;
  
  // Content errors impact
  const contentDensity = calculateDensity(contentErrors, wordCount);
  if (contentDensity > 0.04) {
    score = roundToHalf(score * 0.85);
  }
  
  score = roundToHalf(clamp(score, maxScore));
  
  const comment = `Conservative completion evidence: ${wordCount} words, ${paragraphCount} paragraph${paragraphCount === 1 ? '' : 's'}, ${contentErrors} content issue${contentErrors === 1 ? '' : 's'}. Semantic prompt alignment and task achievement require AI evaluation. Current score based on text structure and length relative to available assignment context.`;
  
  return { score, comment };
}

async function buildWritingAssessment({ submission, assignment, transcriptText, corrections, correctionStatistics, strictness }) {
  try {
    const safeSubmission = submission || {};
    const safeAssignment = assignment || {};
    
    // Use original normalized transcript (not corrected text)
    const transcript = transcriptText || getNormalizedSubmissionTranscript(safeSubmission);
    const normalizedTranscript = normalizeOcrTranscript(transcript);
    
    // Get or build correction statistics
    let stats = correctionStatistics;
    if (!stats || typeof stats !== 'object') {
      stats = await buildSubmissionCorrectionStatistics(safeSubmission);
    }
    
    // Extract evidence
    const wordCount = countWords(normalizedTranscript);
    const sentenceCount = countSentences(normalizedTranscript);
    const paragraphCount = countParagraphs(normalizedTranscript);
    const presentationEvidence = calculatePresentationEvidence(safeSubmission);
    
    const hasAssignmentPrompt = Boolean(safeAssignment && safeAssignment.instructions && safeAssignment.instructions.trim().length > 0);
    
    // Score each category
    const grammarResult = scoreGrammar(stats, wordCount);
    const vocabularyResult = scoreVocabulary(stats, wordCount, normalizedTranscript);
    const mechanicsResult = scoreMechanics(stats, wordCount);
    const organizationResult = scoreOrganization({ wordCount, sentenceCount, paragraphCount }, stats);
    const presentationResult = scorePresentation(presentationEvidence);
    const contentResult = scoreContent({ wordCount, paragraphCount }, safeAssignment, normalizedTranscript, stats);
    
    // Build rubric scores
    const rubricScores = {
      GRAMMAR: {
        score: grammarResult.score,
        maxScore: RUBRIC_MAX.GRAMMAR,
        comment: grammarResult.comment
      },
      VOCABULARY: {
        score: vocabularyResult.score,
        maxScore: RUBRIC_MAX.VOCABULARY,
        comment: vocabularyResult.comment
      },
      ORGANIZATION: {
        score: organizationResult.score,
        maxScore: RUBRIC_MAX.ORGANIZATION,
        comment: organizationResult.comment
      },
      CONTENT: {
        score: contentResult.score,
        maxScore: RUBRIC_MAX.CONTENT,
        comment: contentResult.comment
      },
      MECHANICS: {
        score: mechanicsResult.score,
        maxScore: RUBRIC_MAX.MECHANICS,
        comment: mechanicsResult.comment
      },
      PRESENTATION: {
        score: presentationResult.score,
        maxScore: RUBRIC_MAX.PRESENTATION,
        comment: presentationResult.comment
      }
    };
    
    // Calculate overall score as exact sum of category scores
    const overallScore = Object.values(rubricScores).reduce((sum, cat) => sum + cat.score, 0);
    const grade = gradeFromOverallScore(overallScore);
    
    const evidence = {
      wordCount,
      sentenceCount,
      paragraphCount,
      pageCount: presentationEvidence.pageCount,
      readablePageCount: presentationEvidence.readablePageCount,
      assignmentPromptAvailable: hasAssignmentPrompt,
      correctionCounts: {
        content: stats.content || 0,
        grammar: stats.grammar || 0,
        organization: stats.organization || 0,
        vocabulary: stats.vocabulary || 0,
        mechanics: stats.mechanics || 0,
        total: stats.total || 0
      }
    };
    
    const assessment = {
      assessmentVersion: ASSESSMENT_VERSION,
      maxOverallScore: 100,
      rubricScores,
      overallScore,
      grade,
      evidence
    };
    
    if (process.env.NODE_ENV !== 'production') {
      logger.debug({
        message: 'Writing assessment completed',
        assessmentVersion: ASSESSMENT_VERSION,
        submissionId: String(safeSubmission._id || ''),
        overallScore,
        grade,
        categoryScores: {
          GRAMMAR: grammarResult.score,
          VOCABULARY: vocabularyResult.score,
          ORGANIZATION: organizationResult.score,
          CONTENT: contentResult.score,
          MECHANICS: mechanicsResult.score,
          PRESENTATION: presentationResult.score
        },
        correctionCounts: evidence.correctionCounts,
        pageEvidence: {
          pageCount: evidence.pageCount,
          readablePageCount: evidence.readablePageCount
        }
      });
    }
    
    return assessment;
  } catch (error) {
    logger.error({
      message: 'Writing assessment failed',
      assessmentVersion: ASSESSMENT_VERSION,
      error: error?.message || error,
      submissionId: String(submission?._id || '')
    });
    return { ...EMPTY_ASSESSMENT };
  }
}

module.exports = {
  buildWritingAssessment,
  EMPTY_ASSESSMENT,
  RUBRIC_MAX,
  ASSESSMENT_VERSION
};
