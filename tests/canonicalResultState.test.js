const { buildCanonicalResultState, safeErrorCode } = require('../src/services/canonicalResultState.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');

const currentEvaluation = (overrides = {}) => ({
  evaluationSourceHash: 'hash',
  detailedFeedbackSourceHash: 'hash',
  overallScore: 52,
  grade: 'C',
  assessmentVersion: ASSESSMENT_VERSION,
  evaluationVersion: EVALUATION_VERSION,
  detailedFeedback: {
    status: 'completed',
    sourceHash: 'hash',
    version: 'canonical-detailed-feedback-1',
    areasForImprovement: [],
    strengths: [],
    actionSteps: []
  },
  ...overrides
});

const completedSubmission = (overrides = {}) => ({
  ocrStatus: 'completed',
  correctionStatus: 'completed',
  semanticStatus: 'completed',
  correctionSourceHash: 'hash',
  correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
  evaluationStatus: 'completed',
  evaluationVersion: EVALUATION_VERSION,
  writingCorrections: [],
  ...overrides
});

describe('canonical result state contract', () => {
  test('LanguageTool-only corrections are partial and semantic categories are pending', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'processing', writingCorrections: [
      { source: 'LANGUAGETOOL', category: 'GRAMMAR' }, { source: 'LANGUAGETOOL', category: 'MECHANICS' }
    ], correctionStatistics: { content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 1, total: 2 } } });
    expect(state.statisticsCompleteness).toBe('language_only');
    expect(state.categoryAvailability).toEqual({ grammar: 'available', mechanics: 'available', content: 'pending', organization: 'pending', vocabulary: 'pending' });
    expect(state.sourceCounts).toEqual({ languageTool: 2, semanticAi: 0 });
  });

  test('semantic failure preserves language availability without claiming zeros', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'partial', correctionError: 'AI_PROVIDER_NOT_CONFIGURED',
      writingCorrections: [{ source: 'LANGUAGETOOL', category: 'GRAMMAR' }] } });
    expect(state.statisticsStatus).toBe('partial');
    expect(state.categoryAvailability.content).toBe('failed');
    expect(state.categoryAvailability.grammar).toBe('available');
    expect(state.retryable).toBe(false);
    expect(state).toMatchObject({ correctionStage: 'semantic_failed', processingActive: false,
      automaticPollingAllowed: false, manualRetryAllowed: false, terminal: true,
      evaluationStatus: 'blocked', detailedFeedbackStatus: 'blocked',
      evaluationBlockedReason: 'corrections_incomplete', detailedFeedbackBlockedReason: 'evaluation_unavailable' });
    expect(state.score).toBeNull();
    expect(state.grade).toBeNull();
  });

  test('active semantic processing is the only reason to continue automatic observation', () => {
    const state = buildCanonicalResultState({ submission: { ocrStatus: 'completed', correctionStatus: 'processing', correctionJobId: 'job',
      semanticStatus: 'retry_wait', semanticAttempt: 1, semanticMaxAttempts: 3, writingCorrections: [] } });
    expect(state).toMatchObject({ processingActive: true, automaticPollingAllowed: true, terminal: false,
      semanticStatus: 'retry_wait', semanticAttempt: 1, semanticMaxAttempts: 3 });
  });

  test('corrections completed plus evaluation pending remains a non-terminal polling state', () => {
    const state = buildCanonicalResultState({ submission: completedSubmission({ evaluationStatus: 'pending' }) });
    expect(state).toMatchObject({ evaluationStatus: 'pending', detailedFeedbackStatus: 'processing',
      processingActive: true, automaticPollingAllowed: true, terminal: false });
  });

  test('active evaluation never exposes matching persisted score or detailed feedback', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', correctionSourceHash: 'hash',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'processing', evaluationJobId: 'job' },
    feedback: { evaluationSourceHash: 'hash', detailedFeedbackSourceHash: 'hash', overallScore: 88, grade: 'B',
      detailedFeedback: { status: 'completed', sourceHash: 'hash', version: 'canonical-detailed-feedback-1',
        areasForImprovement: [], strengths: [], actionSteps: [] } } });
    expect(state).toMatchObject({ score: null, grade: null, evaluationStatus: 'processing',
      evaluationCurrent: false, detailedFeedbackStatus: 'processing', detailedFeedbackCurrent: false,
      processingActive: true, automaticPollingAllowed: true, terminal: false });
  });

  test('completed matching lifecycle exposes score and valid structured detailed feedback together', () => {
    const detailedFeedback = { status: 'completed', sourceHash: 'hash', version: 'canonical-detailed-feedback-1',
      areasForImprovement: [{ id: 'area', category: 'GRAMMAR', title: 'Grammar', issueCount: 1, score: 20,
        maxScore: 25, explanation: 'One issue.', dominantSymbols: [], examples: [] }],
      strengths: [], actionSteps: [] };
    const state = buildCanonicalResultState({ submission: completedSubmission(),
    feedback: currentEvaluation({ overallScore: 88, grade: 'B', detailedFeedback }) });
    expect(state).toMatchObject({ score: 88, evaluationStatus: 'completed', evaluationCurrent: true,
      detailedFeedbackStatus: 'completed', detailedFeedbackCurrent: true });
  });

  test('returns the unchanged numeric score and grade without presentation-review status fields', () => {
    const state = buildCanonicalResultState({ submission: completedSubmission(),
      feedback: currentEvaluation({ overallScore: 51, grade: 'F', overriddenByTeacher: false }) });
    expect(state).toMatchObject({ score: 51, grade: 'F' });
    expect(state).not.toHaveProperty('scoreStatus');
    expect(state).not.toHaveProperty('scoreStatusReason');
    expect(state).not.toHaveProperty('presentationReviewStatus');
    expect(state).not.toHaveProperty('scoreSummary');
  });

  test('completed canonical analysis permits genuine zero semantic counts', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', writingCorrections: [],
      correctionStatistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0, total: 0 } } });
    expect(state.statisticsCompleteness).toBe('canonical');
    expect(state.categoryAvailability.content).toBe('available');
    expect(state.statistics.content).toBe(0);
  });

  test('LanguageTool failure never turns missing analysis into synthetic zero availability', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'partial', semanticStatus: 'completed',
      languageToolStatus: 'failed', correctionSourceHash: 'hash', correctionVersion: 'v',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      writingCorrections: [{ source: 'AI', category: 'CONTENT' }],
      correctionStatistics: { content: 1, grammar: null, organization: 0, vocabulary: 0, mechanics: null, total: 1 } } });
    expect(state.statisticsCompleteness).toBe('semantic_only');
    expect(state.categoryAvailability).toMatchObject({ grammar: 'failed', mechanics: 'failed', content: 'available' });
    expect(state.statistics.grammar).toBeNull();
    expect(state.score).toBeNull();
  });

  test('same-hash retained LanguageTool corrections remain available but result stays partial', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'partial', semanticStatus: 'completed',
      languageToolStatus: 'failed', correctionSourceHash: 'hash', correctionVersion: 'v',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      languageToolSourceHash: 'hash', languageToolVersion: 'v',
      languageToolTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      writingCorrections: [{ source: 'LANGUAGETOOL', category: 'GRAMMAR' }, { source: 'AI', category: 'CONTENT' }],
      correctionStatistics: { content: 1, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0, total: 2 } } });
    expect(state.statisticsCompleteness).toBe('language_only');
    expect(state.statisticsStatus).toBe('partial');
    expect(state.categoryAvailability).toEqual({ grammar: 'available', mechanics: 'available',
      content: 'available', organization: 'available', vocabulary: 'available' });
    expect(state.score).toBeNull();
  });

  test('missing and stale evaluation are null while a legitimate completed zero remains zero', () => {
    const base = { correctionStatus: 'completed', correctionSourceHash: 'new',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, writingCorrections: [] };
    expect(buildCanonicalResultState({ submission: base }).score).toBeNull();
    expect(buildCanonicalResultState({ submission: { ...base, evaluationStatus: 'completed' }, feedback: {
      evaluationSourceHash: 'old', overallScore: 99, grade: 'A' } }).score).toBeNull();
    const current = buildCanonicalResultState({ submission: { ...base, semanticStatus: 'completed',
      evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION }, feedback: {
      evaluationSourceHash: 'new', assessmentVersion: ASSESSMENT_VERSION,
      evaluationVersion: EVALUATION_VERSION, overallScore: 0, grade: 'F' } });
    expect(current.score).toBe(0);
    expect(current.grade).toBe('F');
  });

  test('stale detailed feedback is suppressed and errors are classified safely', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', semanticStatus: 'completed',
      correctionSourceHash: 'new', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION },
      feedback: { evaluationSourceHash: 'new', detailedFeedbackSourceHash: 'old', detailedFeedback: { strengths: ['legacy'] } } });
    expect(state.detailedFeedbackCurrent).toBe(false);
    expect(state.detailedFeedbackStatus).toBe('stale');
    expect(safeErrorCode('request timed out with private provider details')).toBe('AI_PROVIDER_TIMEOUT');
    for (const code of ['SEMANTIC_RESPONSE_INVALID', 'SEMANTIC_SOURCE_MISMATCH', 'SEMANTIC_SCHEMA_INVALID',
      'SEMANTIC_EVIDENCE_UNGROUNDED', 'GOOGLE_RESPONSE_EMPTY', 'GOOGLE_RESPONSE_BLOCKED', 'GOOGLE_OUTPUT_TRUNCATED', 'HTTP_429'])
      expect(safeErrorCode({ code })).toBe(code);
  });

  test('current hashes with malformed generic feedback fail explicitly and permit authorized repair', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', semanticStatus: 'completed',
      correctionSourceHash: 'new', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION },
      feedback: { evaluationSourceHash: 'new', detailedFeedbackSourceHash: 'new',
        assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION, detailedFeedback: {
        status: 'completed', sourceHash: 'new', strengths: ['generic'], areasForImprovement: ['generic'], actionSteps: ['generic']
      } } });
    expect(state).toMatchObject({ evaluationCurrent: true, detailedFeedbackCurrent: false,
      detailedFeedbackStatus: 'failed', manualRetryAllowed: true, processingActive: false, terminal: true });
  });

  test('a valid teacher override retains priority over canonical source hashes', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', semanticStatus: 'completed',
      correctionSourceHash: 'new', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION },
      feedback: { overriddenByTeacher: true, evaluationSourceHash: 'old', detailedFeedbackSourceHash: 'old',
        detailedFeedback: { strengths: ['Teacher-authored strength'], areasForImprovement: [], actionSteps: [] }, overallScore: 90, grade: 'A' } });
    expect(state).toMatchObject({ evaluationCurrent: true, detailedFeedbackCurrent: true,
      evaluationStatus: 'completed', detailedFeedbackStatus: 'completed', score: 90, grade: 'A' });
  });

  test('old-layout corrections and evaluations are stale and suppressed', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', correctionSourceHash: 'old-layout',
      writingCorrections: [{ source: 'LANGUAGETOOL' }], correctionStatistics: { grammar: 1 }, evaluationStatus: 'completed' },
    feedback: { evaluationSourceHash: 'old-layout', overallScore: 100, grade: 'A' } });
    expect(state).toMatchObject({ correctionStatus: 'stale', correctionCurrent: false, evaluationStatus: 'blocked',
      detailedFeedbackStatus: 'blocked', processingActive: false, automaticPollingAllowed: false, manualRetryAllowed: true });
    expect(state.statistics).toBeNull();
    expect(state.categoryAvailability.grammar).toBe('failed');
    expect(state.score).toBeNull();
    expect(state.sourceCounts).toEqual({ languageTool: 0, semanticAi: 0 });
  });

  test.each([
    ['OCR', { ocrStatus: 'processing', correctionStatus: 'pending' }],
    ['LanguageTool', { ocrStatus: 'completed', correctionStatus: 'processing', languageToolStatus: 'processing' }],
    ['semantic', { ocrStatus: 'completed', correctionStatus: 'processing', semanticStatus: 'processing' }],
    ['semantic retry', { ocrStatus: 'completed', correctionStatus: 'processing', semanticStatus: 'retry_wait' }]
  ])('%s processing keeps automatic polling active', (_stage, submission) => {
    expect(buildCanonicalResultState({ submission })).toMatchObject({
      processingActive: true, automaticPollingAllowed: true, terminal: false
    });
  });

  test('evaluation processing with no source hash is transitional, not terminal stale', () => {
    const state = buildCanonicalResultState({ submission: completedSubmission({
      evaluationStatus: 'processing', evaluationJobId: 'evaluation-job'
    }), feedback: { overallScore: 10 } });
    expect(state).toMatchObject({
      evaluationStatus: 'processing', detailedFeedbackStatus: 'processing',
      processingActive: true, automaticPollingAllowed: true, terminal: false,
      evaluationCurrent: false, score: null
    });
  });

  test('completed current evaluation is terminal and exposes persisted score 52', () => {
    const state = buildCanonicalResultState({
      submission: completedSubmission({ evaluationStatus: 'completed' }),
      feedback: currentEvaluation()
    });
    expect(state).toMatchObject({
      evaluationStatus: 'completed', detailedFeedbackStatus: 'completed',
      processingActive: false, automaticPollingAllowed: false, terminal: true,
      evaluationCurrent: true, detailedFeedbackCurrent: true, score: 52, grade: 'C'
    });
  });

  test('a source mismatch becomes terminal stale only after evaluation processing ends', () => {
    const state = buildCanonicalResultState({
      submission: completedSubmission({ evaluationStatus: 'completed' }),
      feedback: currentEvaluation({ evaluationSourceHash: 'old' })
    });
    expect(state).toMatchObject({
      evaluationStatus: 'stale', processingActive: false,
      automaticPollingAllowed: false, terminal: true, manualRetryAllowed: true, score: null
    });
  });

  test('retryable evaluation failure is terminal and allows manual retry', () => {
    const state = buildCanonicalResultState({
      submission: completedSubmission({ evaluationStatus: 'failed', evaluationError: { code: 'AI_PROVIDER_TIMEOUT' } })
    });
    expect(state).toMatchObject({
      evaluationStatus: 'failed', processingActive: false,
      automaticPollingAllowed: false, terminal: true, manualRetryAllowed: true
    });
  });
});
