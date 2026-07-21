const { buildCanonicalResultState, safeErrorCode } = require('../src/services/canonicalResultState.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');

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
    expect(state.retryable).toBe(true);
    expect(state).toMatchObject({ correctionStage: 'semantic_failed', processingActive: false,
      automaticPollingAllowed: false, manualRetryAllowed: true, terminal: true,
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

  test('missing evaluation without an active job is terminal and never inferred as processing', () => {
    const state = buildCanonicalResultState({ submission: { ocrStatus: 'completed', correctionStatus: 'completed',
      correctionSourceHash: 'hash', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, writingCorrections: [] } });
    expect(state).toMatchObject({ evaluationStatus: 'blocked', detailedFeedbackStatus: 'blocked',
      processingActive: false, automaticPollingAllowed: false, terminal: true });
  });

  test('completed canonical analysis permits genuine zero semantic counts', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', writingCorrections: [],
      correctionStatistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0, total: 0 } } });
    expect(state.statisticsCompleteness).toBe('canonical');
    expect(state.categoryAvailability.content).toBe('available');
    expect(state.statistics.content).toBe(0);
  });

  test('missing and stale evaluation are null while a legitimate completed zero remains zero', () => {
    const base = { correctionStatus: 'completed', correctionSourceHash: 'new',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, writingCorrections: [] };
    expect(buildCanonicalResultState({ submission: base }).score).toBeNull();
    expect(buildCanonicalResultState({ submission: { ...base, evaluationStatus: 'completed' }, feedback: {
      evaluationSourceHash: 'old', overallScore: 99, grade: 'A' } }).score).toBeNull();
    const current = buildCanonicalResultState({ submission: { ...base, evaluationStatus: 'completed' }, feedback: {
      evaluationSourceHash: 'new', overallScore: 0, grade: 'F' } });
    expect(current.score).toBe(0);
    expect(current.grade).toBe('F');
  });

  test('stale detailed feedback is suppressed and errors are classified safely', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', correctionSourceHash: 'new',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed' },
      feedback: { evaluationSourceHash: 'new', detailedFeedbackSourceHash: 'old', detailedFeedback: { strengths: ['legacy'] } } });
    expect(state.detailedFeedbackCurrent).toBe(false);
    expect(state.detailedFeedbackStatus).toBe('stale');
    expect(safeErrorCode('request timed out with private provider details')).toBe('AI_PROVIDER_TIMEOUT');
  });

  test('current hashes with malformed generic feedback fail explicitly and permit authorized repair', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', correctionSourceHash: 'new',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed' },
      feedback: { evaluationSourceHash: 'new', detailedFeedbackSourceHash: 'new', detailedFeedback: {
        status: 'completed', sourceHash: 'new', strengths: ['generic'], areasForImprovement: ['generic'], actionSteps: ['generic']
      } } });
    expect(state).toMatchObject({ evaluationCurrent: true, detailedFeedbackCurrent: false,
      detailedFeedbackStatus: 'failed', manualRetryAllowed: true, processingActive: false, terminal: true });
  });

  test('a valid teacher override retains priority over canonical source hashes', () => {
    const state = buildCanonicalResultState({ submission: { correctionStatus: 'completed', correctionSourceHash: 'new',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed' },
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
});
