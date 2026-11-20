'use strict';
// generateAndPersist with the handwriting mechanics check: findings join the correction set before the merge (and so before the
// rubric); the check never delays or fails marking. The stage itself is mocked here (it has its own tests). Offline, synthetic text.
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
jest.mock('../src/models/SubmissionFeedback', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../src/services/semanticCorrectionCoordinator.service', () => ({ ...jest.requireActual('../src/services/semanticCorrectionCoordinator.service'), analyze: jest.fn() }));
jest.mock('../src/services/handwritingMechanics/stage.service', () => {
  const actual = jest.requireActual('../src/services/handwritingMechanics/stage.service');
  return { ...actual, start: jest.fn(actual.start) };
});
jest.mock('../src/services/canonicalEvaluation.service', () => ({
  resolveAssessmentPolicy: jest.fn(async () => { const p = require('../src/services/teacherEvaluationPolicy.service');
    const policy = p.normalizeTeacherEvaluationPolicy({ strictness: 'balanced' }); return { policy, policyHash: p.evaluationPolicyHash(policy) }; }),
  prepareRubricAssessment: jest.fn(async () => ({ semantic: { model: 'openai/gpt-6-astra', metrics: { attemptCount: 1 } } })),
  persistProvisionalScore: jest.fn(async () => ({ status: 'partial', overallScore: 78 })), generate: jest.fn(async () => null)
}));
const crypto = require('crypto');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const evaluation = require('../src/services/canonicalEvaluation.service');
const stage = require('../src/services/handwritingMechanics/stage.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { reviewedResult, finding: aiFinding } = require('./helpers/astraAssessmentFixtures.cjs');
const DETECTOR = require('../src/services/handwritingMechanics/engine').DETECTOR;
const model = 'google/gemini-3.8-flash';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const TEXT = 'Kids these days , they win.';

function exactDoc(text = TEXT) {
  const version = require('../src/services/gptVisionExact/contract').VERSION;
  const state = { _id: 'hm-doc', ocrJobId: 'ocr-1', files: ['file-1'], writingCorrections: [], sourceFidelityMode: 'gpt_vision_exact',
    sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED', sourceTranscriptExact: text, sourceTranscriptSha256: sha(text),
    ocrPages: [{ fileId: 'file-1', fileOrder: 0, pageIndex: 0, pageNumber: 1, sourceFidelityMode: 'gpt_vision_exact', sourceFidelityVersion: version,
      sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED', sourceTextExact: text, sourceTextSha256: sha(text), words: [] }] };
  const constructor = { updateOne: jest.fn(async (query, update) => { Object.assign(state, update.$set || {}); return { modifiedCount: 1, matchedCount: 1 }; }),
    findById: jest.fn(() => ({ lean: async () => state })), exists: jest.fn(async () => true) };
  return { doc: { ...state, constructor }, state };
}
const spc = over => ({ category: 'MECHANICS', symbol: 'SPC', quotedText: 'days ,', suggestedText: 'days,', occurrence: 0, confidence: 0.85,
  message: 'You wrote "days ,". Write "days," (no space before the comma).', severity: 'low', correctionKind: 'localized', detector: DETECTOR,
  startChar: 11, endChar: 17, ...over });
const handle = (result, settle) => ({ done: Promise.resolve(), stop: jest.fn(), settle: jest.fn(settle || (async () => result)) });
const summary = { version: 'handwriting-mechanics-v1', status: 'completed', calls: 1, costUsd: 0.001, findings: 1 };
const saved = state => state.writingCorrections || [];

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'mock-only'; process.env.CORRECTION_DETECTION_MODEL = model;
  delete process.env.HANDWRITING_MECHANICS_CHECK_ENABLED; delete process.env.HANDWRITING_MECHANICS_WAIT_AFTER_CORRECTION_MS;
  jest.clearAllMocks();
  jest.spyOn(require('../src/utils/logger'), 'info').mockImplementation(() => {});
  jest.spyOn(require('../src/utils/logger'), 'warn').mockImplementation(() => {});
  coordinator.analyze.mockImplementation(async input => ({ ...reviewedResult(input), model, status: 'completed', metrics: { attemptCount: 1 }, coverage: { complete: true } }));
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.HANDWRITING_MECHANICS_CHECK_ENABLED; });

test('flag off (default): the stage is inactive, nothing is added or saved, hash as without the check', async () => {
  const { doc, state } = exactDoc();
  await pipeline.generateAndPersist(doc);
  expect(stage.start).toHaveBeenCalledTimes(1);
  expect(saved(state)).toEqual([]);
  expect(state).not.toHaveProperty('handwritingMechanicsCheck');
  const offHash = state.correctionSourceHash;
  // The same essay with the flag on gets another hash: the pipeline passes the essay to the hash builder.
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  const again = exactDoc();
  stage.start.mockReturnValueOnce(handle({ status: 'completed', findings: [], summary }));
  await pipeline.generateAndPersist(again.doc);
  expect(again.state.correctionSourceHash).not.toBe(offHash);
});

test('flag on: check findings (no-op form included) are validated, merged, saved with their tag, and reach the rubric', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  const { doc, state } = exactDoc('Kids these days, they win.');
  stage.start.mockReturnValueOnce(handle({ status: 'completed', findings: [spc({ quotedText: 'days,', startChar: 11, endChar: 16 })], summary }));
  await pipeline.generateAndPersist(doc);
  const started = stage.start.mock.calls[0][0];
  expect(started).toMatchObject({ transcript: 'Kids these days, they win.', transcriptComplete: true });
  expect(started.pages[0]).toMatchObject({ fileId: 'file-1', pageNumber: 1, startChar: 0 });
  const settled = stage.start.mock.results[0].value.settle.mock.calls[0][0];
  expect(settled.correctionSucceeded).toBe(true);
  expect(settled.waitMs).toBeLessThanOrEqual(8000);
  expect(saved(state)).toEqual([expect.objectContaining({ symbol: 'SPC', quotedText: 'days,', suggestedText: 'days,', detector: DETECTOR, startChar: 11 })]);
  expect(state.handwritingMechanicsCheck).toEqual({ ...summary, findingsAccepted: 1 });
  expect(evaluation.prepareRubricAssessment.mock.calls[0][0].submission.writingCorrections).toEqual([expect.objectContaining({ detector: DETECTOR })]);
});

test('the same spacing error found by the AI and by the check is kept once', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  coordinator.analyze.mockImplementation(async input => ({ ...reviewedResult(input, [aiFinding('MECHANICS', 'SPC', 'days ,', { suggestedText: 'days,' })]),
    model, status: 'completed', metrics: { attemptCount: 1 }, coverage: { complete: true } }));
  const { doc, state } = exactDoc();
  stage.start.mockReturnValueOnce(handle({ status: 'completed', findings: [spc()], summary }));
  await pipeline.generateAndPersist(doc);
  expect(saved(state).filter(c => c.symbol === 'SPC')).toHaveLength(1);
});

test('the correction failed: the check is told so and none of its findings are saved', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  coordinator.analyze.mockRejectedValue(Object.assign(new Error('provider down'), { code: 'AI_PROVIDER_UNAVAILABLE' }));
  const { doc, state } = exactDoc();
  // Even a check that (wrongly) still returns findings must not have them saved when the correction failed.
  stage.start.mockReturnValueOnce(handle({ status: 'discarded', findings: [spc()], summary: { ...summary, status: 'discarded' } }));
  await pipeline.generateAndPersist(doc);
  expect(stage.start.mock.results[0].value.settle.mock.calls[0][0].correctionSucceeded).toBe(false);
  expect(saved(state).some(c => c.detector)).toBe(false);
});

test('a check that throws, or never settles, does not fail or hold up marking', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  process.env.HANDWRITING_MECHANICS_WAIT_AFTER_CORRECTION_MS = '50';
  const broken = exactDoc();
  stage.start.mockReturnValueOnce(handle(null, async () => { throw new Error('boom'); }));
  await pipeline.generateAndPersist(broken.doc);
  expect(broken.state.correctionStatus).toBe('completed');
  const stuck = exactDoc();
  stage.start.mockReturnValueOnce(handle(null, () => new Promise(() => {})));
  const t0 = Date.now();
  await pipeline.generateAndPersist(stuck.doc);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(stuck.state.correctionStatus).toBe('completed');
  stage.start.mockImplementationOnce(() => { throw new Error('start failed'); });
  const thrown = exactDoc();
  await pipeline.generateAndPersist(thrown.doc);
  expect(thrown.state.correctionStatus).toBe('completed');
});

test('the wait never runs past the correction deadline', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  const policy = require('../src/services/assessmentExecutionPolicy.service');
  const realPlan = policy.plan;
  const plan = jest.spyOn(policy, 'plan').mockImplementation((...args) => ({ ...realPlan(...args), correctionDeadlineAt: Date.now() - 1000 }));
  try {
    const { doc } = exactDoc();
    stage.start.mockReturnValueOnce(handle({ status: 'completed', findings: [], summary }));
    await pipeline.generateAndPersist(doc);
    expect(stage.start.mock.results[0].value.settle.mock.calls[0][0].waitMs).toBe(0);
  } finally { plan.mockRestore(); }
});

test('an ungroundable check finding is dropped, the rest of the set is kept', async () => {
  process.env.HANDWRITING_MECHANICS_CHECK_ENABLED = 'true';
  const { doc, state } = exactDoc();
  stage.start.mockReturnValueOnce(handle({ status: 'completed', summary,
    findings: [spc(), spc({ quotedText: 'not in the essay', suggestedText: 'x', startChar: 0, endChar: 3 })] }));
  await pipeline.generateAndPersist(doc);
  expect(saved(state).map(c => c.quotedText)).toEqual(['days ,']);
  expect(state.correctionStatus).toBe('completed');
});
