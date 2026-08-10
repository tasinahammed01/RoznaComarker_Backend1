'use strict';

const semanticCorrections = require('../src/services/semanticWritingCorrections.service');
const semanticRubric = require('../src/services/semanticRubricAssessment.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');
const { computeCanonicalCorrectionStatistics } = require('../src/services/correctionCanonical.service');
const { synchronizedRubricScores } = require('../src/services/canonicalEvaluation.service');
const detailedFeedback = require('../src/services/canonicalDetailedFeedback.service');
const { scoreGrammar, scoreMechanics, scorePresentation, gradeFromOverallScore } =
  require('../src/services/rubricLanguageScoring.service');
const { normalizeTeacherEvaluationPolicy } = require('../src/services/teacherEvaluationPolicy.service');

const transcript = 'This essay has a clear idea. The ending repeats the same point.';
const assignment = { title: 'Fixed essay', instructions: 'Explain the claim with evidence.', rubric: null };
const policy = normalizeTeacherEvaluationPolicy(null);
const env = {
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter', ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_PRIMARY_RETRIES: '0', ASSESSMENT_AI_FALLBACK_RETRIES: '0',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '30000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '90000',
  OPENROUTER_API_KEY: 'test-key'
};

const corrections = [
  { id: 'c1', category: 'CONTENT', symbol: 'DEV', correctionKind: 'localized', quotedText: 'clear idea',
    suggestedText: 'clear, supported idea', message: 'Add evidence.', severity: 'medium', confidence: 0.95 },
  { id: 'o1', category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global', quotedText: 'The ending repeats',
    suggestedText: 'The ending synthesizes', message: 'Strengthen the conclusion.', severity: 'medium', confidence: 0.95 },
  { id: 'v1', category: 'VOCABULARY', symbol: 'REP', correctionKind: 'localized', quotedText: 'same point',
    suggestedText: 'central claim', message: 'Use precise wording.', severity: 'low', confidence: 0.95 },
  { id: 'g1', category: 'GRAMMAR', symbol: 'AGR', correctionKind: 'localized', quotedText: 'This essay',
    suggestedText: 'This essay', message: 'Review agreement.', severity: 'low', confidence: 0.95 },
  { id: 'm1', category: 'MECHANICS', symbol: 'P', correctionKind: 'localized', quotedText: 'idea.',
    suggestedText: 'idea;', message: 'Review punctuation.', severity: 'low', confidence: 0.95 }
];

function rubricPayload(sourceHash) {
  const evidence = semanticRubric.transcriptEvidenceCatalog(transcript);
  return { sourceHash, categories: {
    CONTENT: { score: 18, maxScore: 20, comment: 'Relevant and developed.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'A controlling idea is present.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'c1', evidenceId: null,
        explanation: 'The claim needs support.', suggestion: 'Add evidence.' }] },
    ORGANIZATION: { score: 16, maxScore: 20, comment: 'Mostly logical.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'The opening is clear.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'o1', evidenceId: null,
        explanation: 'The ending repeats.', suggestion: 'Revise the conclusion.' }] },
    VOCABULARY: { score: 15, maxScore: 20, comment: 'Adequate but repetitive.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'The wording is understandable.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'v1', evidenceId: null,
        explanation: 'The phrase repeats.', suggestion: 'Use a precise phrase.' }] }
  } };
}

async function deterministicResult(sourceHash) {
  const stats = computeCanonicalCorrectionStatistics(corrections);
  const assessment = await semanticRubric.assess({ transcript, corrections, sourceHash, assignment,
    statistics: stats, pageManifest: [{ fileId: sourceHash, pageNumber: 1 }],
    transcriptComplete: true, policy }, {
    config: getSemanticAIConfig(env), env,
    runCompletion: async ({ validate }) => {
      const content = JSON.stringify(rubricPayload(sourceHash));
      return { content, value: validate(content), provider: 'openrouter', model: 'openai/gpt-4.1-mini',
        metrics: { attempts: [{ provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbackIndex: 0,
          status: 'success' }] } };
    }
  });
  const wordCount = transcript.split(/\s+/u).length;
  const rubricScores = synchronizedRubricScores({
    CONTENT: assessment.categories.CONTENT, ORGANIZATION: assessment.categories.ORGANIZATION,
    VOCABULARY: assessment.categories.VOCABULARY,
    GRAMMAR: scoreGrammar({ corrections, wordCount, strictness: policy.strictness }),
    MECHANICS: scoreMechanics({ corrections, wordCount, strictness: policy.strictness }),
    PRESENTATION: scorePresentation({ files: ['one-file'] })
  }, stats);
  const overallScore = Object.values(rubricScores).reduce((sum, item) => sum + item.score, 0);
  return { writingCorrections: corrections, correctionStatistics: stats, rubricScores, overallScore,
    grade: gradeFromOverallScore(overallScore), detailedFeedback: detailedFeedback.buildDeterministicDetailedFeedback({
      corrections, statistics: stats, categoryScores: rubricScores, sourceHash, semanticAssessment: assessment
    }) };
}

describe('first submission and resubmission assessment parity', () => {
  test('uses the same deterministic execution settings and canonical request inputs', () => {
    const config = getSemanticAIConfig(env);
    expect(config).toMatchObject({ temperature: 0, responseFormat: 'json', thinkingLevel: 'minimal',
      maxOutputTokens: 8000 });
    expect(config.chain).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbackIndex: 0 },
      { provider: 'openrouter', model: 'openai/gpt-4.1', fallbackIndex: 1 }
    ]);

    const build = (sourceHash, fileId) => semanticCorrections.buildSemanticRequest({ transcript,
      transcriptHash: sourceHash, assignment, pageManifest: [{ fileId, fileOrder: 0, pageNumber: 1,
        pageIndex: 0, startChar: 0, endChar: transcript.length }] });
    const first = build('first-layout-hash', 'first-file');
    const replacement = build('replacement-layout-hash', 'replacement-file');
    const normalizeExpectedIdentity = (value) => JSON.stringify(value)
      .replaceAll('first-layout-hash', 'CURRENT_SOURCE_HASH')
      .replaceAll('replacement-layout-hash', 'CURRENT_SOURCE_HASH')
      .replaceAll('first-file', 'CURRENT_FILE_ID')
      .replaceAll('replacement-file', 'CURRENT_FILE_ID');
    expect(normalizeExpectedIdentity(first.messages)).toBe(normalizeExpectedIdentity(replacement.messages));
    expect(semanticCorrections.SEMANTIC_PROMPT_VERSION).toBe(semanticCorrections.SEMANTIC_PROMPT_VERSION);
    expect(semanticCorrections.SEMANTIC_SCHEMA_VERSION).toBe(semanticCorrections.SEMANTIC_SCHEMA_VERSION);
    expect(policy).toEqual(normalizeTeacherEvaluationPolicy(null));
  });

  test('the same mocked provider findings produce identical canonical scoring and feedback', async () => {
    const first = await deterministicResult('first-layout-hash');
    const replacement = await deterministicResult('replacement-layout-hash');
    expect(replacement.writingCorrections).toEqual(first.writingCorrections);
    expect(replacement.correctionStatistics).toEqual(first.correctionStatistics);
    expect(replacement.rubricScores).toEqual(first.rubricScores);
    expect(replacement.overallScore).toBe(first.overallScore);
    expect(replacement.grade).toBe(first.grade);
    expect({ ...replacement.detailedFeedback, sourceHash: 'CURRENT_SOURCE_HASH' })
      .toEqual({ ...first.detailedFeedback, sourceHash: 'CURRENT_SOURCE_HASH' });
  });
});
