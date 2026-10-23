'use strict';
jest.mock('../src/models/SubmissionFeedback', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/class.model', () => ({ findById: () => ({ select: () => ({ lean: async () => ({ teacher: 'teacher' }) }) }) }));
jest.mock('../src/models/user.model', () => ({ findById: () => ({ select: () => ({ lean: async () => null }) }) }));
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const client = require('../src/services/semanticAIClient.service');
const canonical = require('../src/services/correctionCanonical.service');
const details = require('../src/services/canonicalDetailedFeedback.service');
const { fixture } = require('./fixtures/astraCoverageFeedback.cjs');
const { reviewedResult, reviewPayload } = require('./helpers/astraAssessmentFixtures.cjs');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const env = { OPENROUTER_API_KEY: 'offline-key', ASSESSMENT_AI_PRIMARY_RETRIES: '0' };
const config = () => client.getAssessmentAIConfig(env);
const counts = { CONTENT: 1, ORGANIZATION: 0, VOCABULARY: 2, GRAMMAR: 7, MECHANICS: 11 };
const source = data => ({ transcript: data.transcript, transcriptHash: 'source', transcriptComplete: true,
  assignment: {}, legend: defaultLegend(), spans: [], pageManifest: [{ startChar: 0, endChar: data.transcript.length }] });
const reviewed = (input, corrections) => {
  const result = reviewedResult(input, corrections);
  result.diagnostics.acceptedByCategory = counts; return result;
};
describe('hard coverage repair is separate from optional quality review', () => {
  test.each(['recovery', 'budget', 'zero', 'finding', 'failure'])('a valid Organization zero remains authoritative: %s', async mode => {
    const data = fixture(); data.transcript += ' neutral'.repeat(550);
    let clock = 1000; const deadlineAt = clock + (mode === 'budget' ? 20000 : 180000);
    const service = { buildSemanticRequest: () => ({ promptInputTokenEstimate: 3432 }), analyze: jest.fn(async input => {
      if (mode === 'recovery' && service.analyze.mock.calls.length === 1) {
        clock += 90000; throw Object.assign(Error('timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
      }
      if (input.analysisMode === 'zero_result_audit') {
        if (mode === 'failure') throw Object.assign(Error('timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
        const added = mode === 'finding' ? [canonical.normalizeCorrection({ symbol: 'COH', category: 'ORGANIZATION',
          quotedText: data.corrections[0].quotedText, startChar: 0, endChar: data.corrections[0].endChar,
          message: 'Link the ideas logically.', confidence: .99, correctionKind: 'global' }, data.transcript, [], defaultLegend(), 'AI')] : [];
        return reviewed(input, added);
      }
      return reviewed(input, data.corrections);
    }) };
    const result = await coordinator.analyze({ ...source(data), deadlineAt }, { env, config: config(), semanticService: service, now: () => clock, settings:{enabled:false} });
    expect(result.status).toBe('completed'); expect(result.coverage.coverageComplete).toBe(true);
    expect(result.coverage.categoryCoverageComplete.ORGANIZATION).toBe(true);
    expect(result.diagnostics.coverageRepairCategories).toEqual([]);
    expect(result.diagnostics.qualityAuditCategories).toEqual(['ORGANIZATION']);
    expect(canonical.statistics(result.corrections).organization).toBe(mode === 'finding' ? 1 : 0);
    expect(result.diagnostics.categoryReviewStatus.ORGANIZATION).toBe(mode === 'finding' ? 'REVIEWED_WITH_FINDINGS' : 'ZERO_AFTER_REVIEW');
    expect(result.diagnostics.qualityAuditStatus).toBe(mode === 'recovery' ? 'skipped_recovery_bound'
      : mode === 'budget' ? 'skipped_budget' : mode === 'failure' ? 'failed' : 'completed');
    expect(service.analyze).toHaveBeenCalledTimes(mode === 'budget' ? 1 : 2);
  });
  test.each(['missing-review', 'missing-symbol', 'explicit-false', 'source-mismatch'])('genuine hard failure stays incomplete: %s', async mode => {
    const data = fixture();
    const service = { analyze: jest.fn(async input => {
      if (input.analysisMode === 'zero_result_audit') throw Object.assign(Error('timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
      const result = reviewed(input, data.corrections);
      if (mode === 'missing-review') result.diagnostics.categoryReviews = result.diagnostics.categoryReviews.filter(r => r.category !== 'ORGANIZATION');
      if (mode === 'missing-symbol') result.diagnostics.symbolReviewCoverage.ORGANIZATION.complete = false;
      if (mode === 'explicit-false') result.diagnostics.categoryCoverageComplete = { ORGANIZATION: false };
      if (mode === 'source-mismatch') result.diagnostics.sourceHashMatches = false;
      return result;
    }) };
    const result = await coordinator.analyze(source(data), { env, config: config(), semanticService: service });
    expect(result.status).toBe('partial'); expect(result.coverage.categoryCoverageComplete.ORGANIZATION).toBe(false);
    expect(result.diagnostics.coverageRepairCategories).toContain('ORGANIZATION');
    expect(result.diagnostics.coverageRepairStatus).toBe('failed');
    expect(result.corrections).toHaveLength(21);
  });
  test('a completed full-document repair can establish missing coverage without inventing counts', async () => {
    const data = fixture();
    const service = { analyze: jest.fn(async input => {
      const result = reviewed(input, input.analysisMode ? [] : data.corrections);
      if (!input.analysisMode) result.diagnostics.categoryReviews = result.diagnostics.categoryReviews.filter(r => r.category !== 'ORGANIZATION');
      return result;
    }) };
    const result = await coordinator.analyze(source(data), { env, config: config(), semanticService: service });
    expect(result.status).toBe('completed'); expect(result.diagnostics.coverageRepairStatus).toBe('completed');
    expect(canonical.statistics(result.corrections).organization).toBe(0);
  });
  test('actual schema still rejects missing Organization symbol review', () => {
    const data = fixture(), payload = reviewPayload('source', undefined, data.findings);
    payload.categories.ORGANIZATION.reviewedSymbols.pop();
    expect(() => semantic.parseJson(JSON.stringify(payload), 'source')).toThrow();
  });
});

describe('production-shaped recovery, evaluation and read-only freshness', () => {
  test.each(['quote', 'offset', 'identity', 'count', 'correction', 'action'])('holistic feedback rejects changed %s evidence', field => {
    const transcript = 'One exact source passage.';
    const categoryScores = { ORGANIZATION: { score: 16.5, maxScore: 20, improvementEvidence: [{
      findingScope: 'holistic', evidenceType: 'transcript', correctionId: null, evidenceId: 'doc:server-evidence',
      quotedText: transcript, startChar: 0, endChar: transcript.length,
      explanation: 'The ideas need clearer links.', suggestion: 'Explain the connection.' }] } };
    const input = { corrections: [], statistics: { organization: 0 }, categoryScores, sourceHash: 'source', transcript };
    const result = details.buildDeterministicDetailedFeedback(input);
    expect(details.validateDetailedFeedback(result, input)).toBe(result);
    const area = result.areasForImprovement[0];
    if (field === 'quote') area.holisticEvidence[0].quotedText = 'invented';
    if (field === 'offset') area.holisticEvidence[0].startChar = 1;
    if (field === 'identity') area.holisticEvidence[0].evidenceId = 'invented';
    if (field === 'count') area.issueCount = 1;
    if (field === 'correction') area.examples.push({ correctionId: 'invented' });
    if (field === 'action') result.actionSteps[0].action = 'Invented advice';
    expect(details.validateDetailedFeedback(result, input)).toBeNull();
  });
  test('long-document 90s timeout + 20s recovery + 40s rubric completes 21 counts and fresh holistic feedback', async () => {
    const data = fixture(), feedback = require('../src/models/SubmissionFeedback');
    // This recovery regression belongs outside the new short-timeout policy.
    // Appending neutral source leaves all existing correction spans unchanged.
    data.transcript += ' neutral'.repeat(300);
    let stored = null, clock = 1000, correctionCalls = 0;
    const timer = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const state = { _id: 'submission', class: 'class', student: 'student', files: ['f'], ocrJobId: 'ocr', ocrStatus: 'completed',
      ocrPages: [{ fileId: 'f', pageNumber: 1, text: data.transcript }], writingCorrections: [] };
    const apply = (object, update) => { Object.assign(object, update.$set || {}); for (const key of Object.keys(update.$unset || {})) delete object[key]; };
    const model = { updateOne: jest.fn(async (_q, update) => { apply(state, update); return { modifiedCount: 1 }; }),
      findById: jest.fn(async () => ({ ...state, constructor: model })), exists: jest.fn().mockResolvedValue({}) };
    feedback.findOne.mockImplementation(() => ({ lean: async () => stored }));
    feedback.updateOne.mockImplementation(async (_q, update) => { if (stored) apply(stored, update); return { modifiedCount: 1 }; });
    feedback.findOneAndUpdate.mockImplementation(async (_q, update) => { stored ||= {}; apply(stored, update); return stored; });
    const oldFetch = global.fetch, oldKey = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'offline-key';
    global.fetch = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body), prompt = body.messages[1].content;
      expect(body.model).toBe('openai/gpt-6-astra');
      const line = prefix => JSON.parse(prompt.split('\n').find(value => value.startsWith(prefix)).slice(prefix.length));
      let payload;
      if (prompt.includes('transcriptHash=')) {
        correctionCalls++;
        if (correctionCalls === 1) { clock += 90000; throw Object.assign(Error('timeout'), { name: 'TimeoutError' }); }
        clock += 20000;
        payload = reviewPayload(prompt.match(/^transcriptHash=(.+)$/mu)[1], undefined, data.findings);
      } else {
        clock += 40000;
        const evidence = line('evidenceCatalog='), catalog = line('correctionCatalog=');
        const scoring = require('../src/services/rubricLanguageScoring.service');
        const g = scoring.scoreGrammar({ corrections: state.writingCorrections, wordCount: scoring.countWords(data.transcript), strictness: 'balanced', enabled: true }).score;
        const m = scoring.scoreMechanics({ corrections: state.writingCorrections, wordCount: scoring.countWords(data.transcript), strictness: 'balanced', enabled: true }).score;
        const p = scoring.scorePresentation(state).score;
        const contentVocabularyScore = (69 - 16.5 - g - m - p) / 2;
        const rawScore = target => 20 - (20 - target) / .85;
        const contentScore = Math.floor(contentVocabularyScore * 2) / 2;
        const vocabularyScore = contentVocabularyScore * 2 - contentScore;
        expect(contentVocabularyScore).toBeGreaterThanOrEqual(0); expect(contentVocabularyScore).toBeLessThanOrEqual(20);
        payload = { sourceHash: prompt.match(/^sourceHash=(.+)$/mu)[1], categories: Object.fromEntries(
          ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map(category => {
            const correction = catalog.find(c => c.category === category);
            return [category, { score: category === 'ORGANIZATION' ? rawScore(16.5) : category === 'CONTENT' ? rawScore(contentScore) : category === 'VOCABULARY' ? rawScore(vocabularyScore) : 18,
              maxScore: 20, comment: 'Grounded category judgment.',
              strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'The response expresses an idea.' }],
              improvementEvidence: [{ findingScope: correction ? 'localized' : 'holistic', evidenceType: correction ? 'correction' : 'transcript',
                correctionId: correction?.correctionId || null, evidenceId: correction?.evidenceId || evidence[0].evidenceId,
                explanation: 'The progression needs stronger links.', suggestion: 'Explain the connection between these ideas.' }] }];
          })) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: body.model,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }) };
    });
    try {
      const assignment = { title: 'Essay', instructions: 'Explain social expectations and support the argument.' };
      await require('../src/services/canonicalCorrectionsPipeline.service').generateAndPersist({ ...state, constructor: model }, { assignment });
      expect(state.semanticStatus).toBe('completed'); expect(state.evaluationStatus).toBe('completed');
      expect(state.semanticMetrics).toMatchObject({ correctionCoverageComplete: true,
        qualityAuditStatus: 'skipped_recovery_bound', coverageRepairCategories: [], rubricSucceeded: true, detailedFeedbackFresh: true });
      expect(state.semanticMetrics.performance).toMatchObject({correctionPrimaryMs:90000,correctionRecoveryMs:20000,
        coverageRepairMs:0,qualityAuditMs:0,rubricMs:40000,feedbackBuildMs:0,providerCallCount:3});
      expect(state.correctionStatistics).toMatchObject({ content: 1, organization: 0, vocabulary: 2, grammar: 7, mechanics: 11, total: 21 });
      expect(stored.evaluationStatus).toBe('completed'); expect(stored.overallScore).toBeCloseTo(69);
      expect(stored.rubricScores.ORGANIZATION.score).toBe(16.5);
      expect(stored.detailedFeedback.areasForImprovement).toContainEqual(expect.objectContaining({ category: 'ORGANIZATION', evidenceKind: 'holistic', issueCount: 0 }));
      const current = require('../src/services/canonicalResultState.service').buildCanonicalResultState({ submission: state, feedback: stored });
      expect(current).toMatchObject({ detailedFeedbackStatus: 'completed', categoryAvailability: { organization: 'available' } });
      const beforeReload = global.fetch.mock.calls.length;
      const reloaded = await require('../src/services/canonicalEvaluation.service').generate({ submission: { ...state, constructor: model }, assignment });
      expect(reloaded.status).toBe('reused'); expect(global.fetch).toHaveBeenCalledTimes(beforeReload);
      expect(beforeReload).toBe(3);
      expect(details.validateDetailedFeedback(stored.detailedFeedback, { corrections: state.writingCorrections,
        statistics: state.correctionStatistics, categoryScores: stored.rubricScores, sourceHash: state.correctionSourceHash, transcript: data.transcript })).not.toBeNull();
    } finally { timer.mockRestore(); global.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; }
  });
});
