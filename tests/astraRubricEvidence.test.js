'use strict';
jest.mock('../src/models/SubmissionFeedback', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/class.model', () => ({ findById: () => ({ select: () => ({ lean: async () => ({ teacher: 'teacher' }) }) }) }));
jest.mock('../src/models/user.model', () => ({ findById: () => ({ select: () => ({ lean: async () => null }) }) }));
const rubric = require('../src/services/semanticRubricAssessment.service');
const { fixture } = require('./fixtures/astraRubricEvidence.cjs');
const { getAssessmentAIConfig } = require('../src/services/semanticAIClient.service');
const { statistics } = require('../src/services/correctionCanonical.service');
const feedback = require('../src/models/SubmissionFeedback');
const evaluation = require('../src/services/canonicalEvaluation.service');
const env = { OPENROUTER_API_KEY: 'offline-key', ASSESSMENT_AI_MODEL:'openai/gpt-6-astra', ASSESSMENT_AI_PRIMARY_RETRIES: '1' };
beforeEach(()=>{process.env.ASSESSMENT_AI_MODEL='openai/gpt-6-astra';});
afterAll(()=>{delete process.env.ASSESSMENT_AI_MODEL;});
const clone = object => JSON.parse(JSON.stringify(object));
const input = data => ({ transcript: data.transcript, sourceHash: data.payload.sourceHash,
  corrections: data.corrections, assignment: { title: 'Essay', instructions: 'Explain the idea with examples.' },
  includeLanguageCategories: true, transcriptComplete: true });
const validate = (data, payload = data.payload, extra = {}) => rubric.validateAssessment(payload, {
  ...input(data), assessedCategories: rubric.DEGRADED_CATEGORIES, contextStatus: 'instructions', ...extra });
const transport = payloads => jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'openai/gpt-6-astra', choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify(payloads.shift()) } }] }) }));
function invalidDocumentId(data) {
  const bad = clone(data.payload);
  bad.categories.CONTENT.improvementEvidence = [{ ...bad.categories.ORGANIZATION.improvementEvidence[0], evidenceId: 'ev-invented' }];
  return bad;
}

describe('server-owned exact rubric evidence', () => {
  test('exact supplied IDs are accepted; holistic Organization is valid with zero local corrections', () => {
    const data = fixture(), result = validate(data);
    expect(result.categories.ORGANIZATION.issueCount).toBe(0);
    expect(result.categories.ORGANIZATION.improvementEvidence[0]).toMatchObject({ evidenceId: data.evidence[0].evidenceId,
      quotedText: data.evidence[0].quotedText, startChar: data.evidence[0].startChar });
    expect(statistics(data.corrections)).toMatchObject({ content: 1, organization: 0, vocabulary: 1, grammar: 7, mechanics: 11, total: 20 });
  });
  test.each(['ev-invented', 'EV-' + '0000', ' ev-invented '])('unknown transcript reference %s has no fuzzy/first-match repair', id => {
    const data = fixture(), bad = invalidDocumentId(data); bad.categories.CONTENT.improvementEvidence[0].evidenceId = id;
    expect(() => validate(data, bad)).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' }));
  });
  test.each([null, 'wrong-format'])('valid unique canonical correction ID deterministically owns evidenceId=%s', value => {
    const data = fixture(), payload = clone(data.payload);
    payload.categories.CONTENT.improvementEvidence[0].evidenceId = value;
    const before = JSON.stringify(payload);
    const result = validate(data, payload);
    expect(result.categories.CONTENT.improvementEvidence[0].evidenceId).toBe(`correction:${data.corrections[0].id}`);
    expect(result.diagnostics.rubricEvidenceCanonicalizedCount).toBe(1);
    expect(JSON.stringify(payload)).toBe(before);
  });
  test('two conflicting known references cannot be canonicalized', () => {
    const data = fixture(); data.payload.categories.CONTENT.improvementEvidence[0].evidenceId = data.evidence[0].evidenceId;
    expect(() => validate(data)).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' }));
  });
  test('duplicate correction identity is rejected', () => {
    const data = fixture(); data.corrections.push({ ...data.corrections[0] });
    expect(() => validate(data)).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_AMBIGUOUS' }));
  });
  test('repeated exact quote without canonical offsets is ambiguous, never first-matched', () => {
    const data = fixture(); data.transcript += '\n' + data.corrections[0].quotedText;
    delete data.corrections[0].startChar; delete data.corrections[0].endChar;
    expect(() => validate(data)).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED' }));
  });
  test('source hash mismatch remains terminal, and server catalogs must contain exact literal spans', () => {
    const data = fixture();
    expect(() => validate(data, { ...data.payload, sourceHash: 'other' })).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_SOURCE_MISMATCH' }));
    expect(() => validate(data, data.payload, { evidenceCatalog: [{ ...data.evidence[0], quotedText: 'paraphrased' }] }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED' }));
  });
  test('prompt/schema provide exact server-owned document and correction identities', () => {
    const data = fixture(), request = rubric.buildRequest(input(data)), prompt = request.messages[1].content;
    expect(prompt).toContain('Copy evidenceId character-for-character');
    expect(prompt).toContain('Never create, alter, abbreviate, or infer an evidenceId');
    expect(request.correctionCatalog[0]).toMatchObject({ evidenceId: `correction:${data.corrections[0].id}`,
      quotedText: data.corrections[0].quotedText, startChar: data.corrections[0].startChar });
  });
  test.each(['sourceHash', 'policyHash', 'rubricHash', 'promptVersion', 'schemaVersion'])
  ('prepared rubric %s mismatch remains rejected', field => {
    const data = fixture();
    const expected = { sourceHash: data.payload.sourceHash, policyHash: 'p', rubricHash: 'r', customRubricStatus: 'absent' };
    const prepared = { ...expected, semantic: validate(data), promptVersion: rubric.PROMPT_VERSION, schemaVersion: rubric.SCHEMA_VERSION };
    prepared[field] = 'not-current';
    expect(() => evaluation.validatePreparedRubric(prepared, expected)).toThrow(expect.objectContaining({
      code: ['promptVersion', 'schemaVersion'].includes(field) ? 'PREPARED_RUBRIC_VERSION_MISMATCH' : 'PREPARED_RUBRIC_HASH_MISMATCH' }));
  });
  test('empty correction quote cannot establish source evidence', () => {
    const data = fixture(); data.corrections[0].quotedText = '';
    expect(() => validate(data)).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED' }));
  });
  test('bbox-null image warning does not discard canonical transcript target or count', () => {
    const text = 'An exact source passage.';
    const correction = { id: 'ta', source: 'AI', symbol: 'TA', category: 'CONTENT', fileId: 'f', page: 1,
      startChar: 0, endChar: text.length, quotedText: text, wordIds: ['w'] };
    const page = { fileId: 'f', pageNumber: 1, text, startChar: 0, words: [{ id: 'w', text, bbox: null }] };
    const canonical = { text, pages: [page], wordSpans: [{ wordId: 'w', fileId: 'f', page: 1, start: 0, end: text.length }] };
    const [result] = require('../src/services/canonicalCorrectionRender.service').buildCanonicalCorrectionRenderModels([correction], canonical, []);
    expect(result.wordIds).toEqual(['w']); expect(result.renderTarget.boxes).toEqual([]);
    expect(result.renderTarget.textRanges).toEqual([{ start: 0, end: text.length }]);
    expect(statistics([result]).total).toBe(1);
  });
});

describe('one same-Astra evidence-reference repair', () => {
  test('repair inherits the original absolute deadline and is skipped after it expires', async () => {
    const data = fixture(); let clock = 1000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const fetchImpl = transport([invalidDocumentId(data)]);
    const timedFetch = jest.fn(async (...args) => { const result = await fetchImpl(...args); clock = 3000; return result; });
    try {
      await expect(rubric.assess({ ...input(data), deadlineAt: 2000 }, { env, config: getAssessmentAIConfig(env), fetchImpl: timedFetch }))
        .rejects.toMatchObject({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID', rubricDiagnostics: { rubricRepairAttempted: false } });
      expect(timedFetch).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });
  test('repair receives allowed catalog/path, preserves judgments and validates the whole result', async () => {
    const data = fixture(), bad = invalidDocumentId(data), fixed = clone(bad);
    fixed.categories.CONTENT.improvementEvidence[0].evidenceId = data.evidence[0].evidenceId;
    const fetchImpl = transport([bad, fixed]);
    const result = await rubric.assess(input(data), { env, config: getAssessmentAIConfig(env), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies.map(body => body.model)).toEqual(['openai/gpt-6-astra', 'openai/gpt-6-astra']);
    expect(bodies[1].messages[1].content).toContain('validationPath=$.categories.CONTENT.improvementEvidence.evidenceId');
    expect(bodies[1].messages[1].content).toContain(data.evidence[0].evidenceId);
    expect(bodies[1].messages[0].content).toContain('Never invent evidence or reassess the essay');
    expect(result.diagnostics).toMatchObject({ rubricRepairAttempted: true, rubricRepairSucceeded: true,
      rubricAttemptCount: 2, rubricValidationCode: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' });
    expect(result.categories.CONTENT.score).toBe(bad.categories.CONTENT.score);
  });
  test('bad derived ID with exact correction reference needs no repair/provider retry', async () => {
    const data = fixture(); data.payload.categories.CONTENT.improvementEvidence[0].evidenceId = 'wrong-format';
    const fetchImpl = transport([data.payload]);
    const result = await rubric.assess(input(data), { env, config: getAssessmentAIConfig(env), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toMatchObject({ rubricEvidenceCanonicalizedCount: 1, rubricRepairAttempted: false });
  });
  test.each(['invalid-again', 'score-change'])('failed repair %s stays unavailable with specific root and at most two calls', async mode => {
    const data = fixture(), bad = invalidDocumentId(data), repaired = clone(bad);
    if (mode === 'score-change') { repaired.categories.CONTENT.score = 20;
      repaired.categories.CONTENT.improvementEvidence[0].evidenceId = data.evidence[0].evidenceId; }
    const fetchImpl = transport([bad, repaired, data.payload]);
    await expect(rubric.assess(input(data), { env, config: getAssessmentAIConfig(env), fetchImpl }))
      .rejects.toMatchObject({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID', attemptCount: 2,
        rubricDiagnostics: { rubricErrorCode: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID', rubricRepairAttempted: true, rubricRepairSucceeded: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('20-correction canonical evaluation regression without correction reanalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks(); feedback.findOne.mockReturnValue({ lean: async () => null });
    feedback.findOneAndUpdate.mockResolvedValue({});
  });
  test.each([true, false])('completed correction counts survive rubric repair success=%s', async success => {
    const data = fixture(), bad = invalidDocumentId(data), fixed = clone(bad);
    fixed.categories.CONTENT.improvementEvidence[0].evidenceId = data.evidence[0].evidenceId;
    const fetchImpl = transport([bad, success ? fixed : bad]);
    const previousFetch = global.fetch; global.fetch = fetchImpl;
    const previousKey = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'offline-key';
    const correctionsService = require('../src/services/semanticWritingCorrections.service');
    const correctionAnalysis = jest.spyOn(correctionsService, 'analyze');
    const record = { _id: 'submission', class: 'class', student: 'student', ocrStatus: 'completed',
      files: ['f'], ocrPages: [{ fileId: 'f', pageNumber: 1, text: data.transcript }], correctionSourceHash: data.payload.sourceHash,
      writingCorrections: data.corrections, correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'pending',
      semanticMetrics: { coverage: { coverageComplete: true, totalChunks: 1, successfulChunks: 1, failedChunks: 0, structuralPassStatus: 'not_required' } },
      constructor: { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }), exists: jest.fn().mockResolvedValue({}) } };
    const before = JSON.stringify(record.writingCorrections);
    try {
      const result = await evaluation.generate({ submission: record, assignment: input(data).assignment });
      expect(result.status).toBe(success ? 'completed' : 'failed');
      expect(fetchImpl).toHaveBeenCalledTimes(2); expect(correctionAnalysis).not.toHaveBeenCalled();
      expect(JSON.stringify(record.writingCorrections)).toBe(before);
      expect(statistics(record.writingCorrections)).toMatchObject({ content: 1, organization: 0, vocabulary: 1, grammar: 7, mechanics: 11, total: 20 });
      const saved = feedback.findOneAndUpdate.mock.calls.at(-1)[1].$set;
      if (success) {
        expect(result.overallScore).toEqual(expect.any(Number)); expect(result.categoryScores).toBeDefined();
        expect(saved.detailedFeedback.status).toBe('completed');
        expect(saved.evaluationDiagnostics.rubricRepairSucceeded).toBe(true);
      } else {
        expect(result.overallScore).toBeNull();
        expect(saved.evaluationErrorCode).toBe('SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID');
        expect(saved.evaluationDiagnostics).toMatchObject({ rubricRepairSucceeded: false, rubricRepairAttempted: true });
      }
    } finally {
      global.fetch = previousFetch; correctionAnalysis.mockRestore();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });
});
