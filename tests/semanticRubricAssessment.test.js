const { parseJson, validateAssessment, assess, transcriptEvidenceCatalog, buildRequest } = require('../src/services/semanticRubricAssessment.service');
const { NO_TRANSCRIPT_EVIDENCE_SENTINEL } = require('../src/services/structuredOutputSchemas.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');

const transcript = 'This essay has a clear idea. The ending repeats the same point.';
const evidence = transcriptEvidenceCatalog(transcript);
const corrections = [
  { id: 'c1', category: 'CONTENT', quotedText: 'clear idea' },
  { id: 'o1', category: 'ORGANIZATION', quotedText: 'The ending repeats' },
  { id: 'v1', category: 'VOCABULARY', quotedText: 'same point' }
];

function valid() {
  return { sourceHash: 'hash', categories: {
    CONTENT: { score: 18, maxScore: 20, comment: 'Relevant and developed.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'This states a controlling idea.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'c1', evidenceId: null, explanation: 'Needs more support.', suggestion: 'Add evidence.' }] },
    ORGANIZATION: { score: 16, maxScore: 20, comment: 'Mostly logical.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'The opening is clear.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'o1', evidenceId: null, explanation: 'The ending repeats.', suggestion: 'Revise the conclusion.' }] },
    VOCABULARY: { score: 15, maxScore: 20, comment: 'Adequate but repetitive.',
      strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'The phrase is understandable.' }],
      improvementEvidence: [{ evidenceType: 'correction', correctionId: 'v1', evidenceId: null, explanation: 'The wording is repetitive.', suggestion: 'Use a more precise phrase.' }] }
  } };
}

describe('semantic rubric assessment validation', () => {
  const customRubric = {
    criteria: [{
      id: 'criterion-1',
      title: 'Quality',
      weight: 100,
      levels: [
        { title: 'Excellent', percentage: 100 },
        { title: 'Satisfactory', percentage: 60 }
      ]
    }]
  };

  function withCustomCriterion(overrides = {}) {
    return {
      ...valid(),
      customCriteria: [{
        criterionId: 'criterion-1',
        percentage: 60,
        levelTitle: 'Satisfactory',
        comment: 'A supported satisfactory judgment.',
        evidenceIds: [evidence[0].evidenceId],
        ...overrides
      }]
    };
  }

  test('custom-rubric prompt makes disabled teacher checks apply to every custom criterion', () => {
    const request = buildRequest({
      transcript, corrections, sourceHash: 'hash', assignment: {},
      policy: { strictness: 'balanced',
        checks: { grammarSpelling: false, coherenceLogic: false, factChecking: false } },
      customRubric: { criteria: [{ id: 'criterion-1', title: 'Quality', weight: 100, levels: [] }] }
    });
    const prompt = request.messages.map((item) => item.content).join('\n');
    expect(prompt).toContain('For every custom criterion, do not deduct specifically for spelling, grammar, punctuation, capitalization, spacing, formatting');
    expect(prompt).toContain('For every custom criterion, do not deduct specifically for organization, coherence, flow, transitions, or logical sequencing');
    expect(prompt).toContain('copy that level’s configured percentage exactly');
    expect(prompt).toContain('Evaluate CONTENT, ORGANIZATION, and VOCABULARY independently from customRubric');
  });

  test('accepts the exact configured percentage for the selected custom-rubric level', () => {
    const result = validateAssessment(withCustomCriterion(), {
      sourceHash: 'hash', transcript, corrections, customRubric
    });
    expect(result.customCriteria[0]).toMatchObject({
      criterionId: 'criterion-1',
      percentage: 60,
      levelTitle: 'Satisfactory'
    });
  });

  test('rejects a custom percentage inconsistent with the selected configured level', () => {
    expect(() => validateAssessment(withCustomCriterion({ percentage: 27 }), {
      sourceHash: 'hash', transcript, corrections, customRubric
    })).toThrow(expect.objectContaining({
      code: 'CUSTOM_RUBRIC_PERCENTAGE_MISMATCH',
      validationIssues: [expect.objectContaining({
        expectedPercentage: 60,
        actualPercentage: 27
      })]
    }));
  });

  test('rejects missing, duplicate, unknown-criterion, and unknown-level custom assessments', () => {
    const missing = { ...valid(), customCriteria: [] };
    expect(() => validateAssessment(missing, {
      sourceHash: 'hash', transcript, corrections, customRubric
    })).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_ASSESSMENT_INCOMPLETE' }));

    const duplicate = withCustomCriterion();
    duplicate.customCriteria.push({ ...duplicate.customCriteria[0] });
    expect(() => validateAssessment(duplicate, {
      sourceHash: 'hash', transcript, corrections, customRubric
    })).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_CRITERION_DUPLICATE' }));

    expect(() => validateAssessment(withCustomCriterion({ criterionId: 'invented' }), {
      sourceHash: 'hash', transcript, corrections, customRubric
    })).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_CRITERION_UNKNOWN' }));

    expect(() => validateAssessment(withCustomCriterion({ levelTitle: 'Invented' }), {
      sourceHash: 'hash', transcript, corrections, customRubric
    })).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_LEVEL_INVALID' }));
  });

  test('rejects an incorrect source hash', () => {
    expect(() => validateAssessment({ ...valid(), sourceHash: 'old' }, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(/source hash/i);
  });

  test('rejects unknown transcript evidence IDs', () => {
    const payload = valid();
    payload.categories.CONTENT.strengthEvidence[0].evidenceId = 'invented-id';
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' }));
  });

  test('never prompts, persists, or resolves the private empty-catalog sentinel', () => {
    const request = buildRequest({ transcript: '', corrections: [], sourceHash: 'empty-hash', assignment: {} });
    expect(request.evidenceCatalog).toEqual([]);
    expect(JSON.stringify(request.messages)).not.toContain(NO_TRANSCRIPT_EVIDENCE_SENTINEL);
    const emptyCategory = { score: 20, maxScore: 20, comment: 'No unsupported judgment.',
      strengthEvidence: [], improvementEvidence: [] };
    const payload = { sourceHash: 'empty-hash', categories: {
      CONTENT: { ...emptyCategory, strengthEvidence: [{ evidenceId: NO_TRANSCRIPT_EVIDENCE_SENTINEL,
        explanation: 'This must never resolve.' }] },
      ORGANIZATION: { ...emptyCategory }, VOCABULARY: { ...emptyCategory }
    } };
    expect(() => validateAssessment(payload, { sourceHash: 'empty-hash', transcript: '', corrections: [] }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' }));
  });

  test('rejects invalid correction IDs', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence[0].correctionId = 'missing';
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(/correction ID/i);
  });

  test('accepts transcript-grounded Content and Organization improvement evidence with zero corrections', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, evidenceId: evidence[0].evidenceId,
      explanation: 'The idea needs more development.', suggestion: 'Add a specific supporting example.'
    }];
    payload.categories.ORGANIZATION.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, evidenceId: evidence[1].evidenceId,
      explanation: 'The conclusion repeats rather than synthesizes.', suggestion: 'Synthesize the main point.'
    }];
    const result = validateAssessment(payload, {
      sourceHash: 'hash',
      transcript,
      corrections: corrections.filter((item) => !['CONTENT', 'ORGANIZATION'].includes(item.category))
    });
    expect(result.categories.CONTENT.improvementEvidence[0]).toMatchObject({
      evidenceType: 'transcript', correctionId: null, evidenceId: evidence[0].evidenceId,
      quotedText: evidence[0].quotedText
    });
    expect(result.categories.ORGANIZATION.improvementEvidence[0]).toMatchObject({
      evidenceType: 'transcript', correctionId: null, evidenceId: evidence[1].evidenceId,
      quotedText: evidence[1].quotedText
    });
  });

  test('rejects a Grammar correction ID used as Content evidence', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence[0].correctionId = 'g1';
    expect(() => validateAssessment(payload, {
      sourceHash: 'hash', transcript, corrections: [...corrections, { id: 'g1', category: 'GRAMMAR', quotedText: 'clear idea' }]
    })).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_CORRECTION_INVALID' }));
  });

  test('rejects an unknown transcript evidence ID', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, evidenceId: 'invented-id',
      explanation: 'Needs support.', suggestion: 'Add support.'
    }];
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections: [] }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' }));
  });

  test('restricts conclusion claims to transcript evidence IDs in the final quarter', () => {
    const payload = valid();
    payload.categories.ORGANIZATION.comment = 'The conclusion is weak.';
    payload.categories.ORGANIZATION.strengthEvidence = [{ evidenceId: evidence[0].evidenceId,
      explanation: 'The opening is clear.' }];
    payload.categories.ORGANIZATION.improvementEvidence = [{ evidenceType: 'correction', correctionId: 'o1',
      evidenceId: null, explanation: 'The ending repeats.', suggestion: 'Revise the conclusion.' }];
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_CONCLUSION_EVIDENCE_INVALID' }));
    payload.categories.ORGANIZATION.improvementEvidence = [{ evidenceType: 'transcript', correctionId: null,
      evidenceId: evidence[1].evidenceId, explanation: 'The ending repeats.', suggestion: 'Revise the conclusion.' }];
    expect(validateAssessment(payload, { sourceHash: 'hash', transcript, corrections })
      .categories.ORGANIZATION.improvementEvidence[0].quotedText).toBe(evidence[1].quotedText);
  });

  test('does not misclassify a general Organization observation as conclusion-specific', () => {
    const payload = valid();
    payload.categories.ORGANIZATION.comment = 'Coherence and transitions are uneven, and the conclusion could be stronger.';
    payload.categories.ORGANIZATION.improvementEvidence = [{ evidenceType: 'correction', correctionId: 'o1',
      evidenceId: null, explanation: 'The progression repeats an earlier point.', suggestion: 'Improve the progression.' }];
    expect(validateAssessment(payload, { sourceHash: 'hash', transcript, corrections })
      .categories.ORGANIZATION.comment).toContain('Coherence');
  });

  test('requires a complete authoritative transcript for a missing-conclusion claim', () => {
    const payload = valid();
    payload.categories.ORGANIZATION.comment = 'The conclusion is missing.';
    payload.categories.ORGANIZATION.improvementEvidence = [{ evidenceType: 'transcript', correctionId: null,
      evidenceId: evidence[1].evidenceId, explanation: 'The conclusion is missing.', suggestion: 'Add a conclusion.' }];
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections, transcriptComplete: false }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_ABSENCE_EVIDENCE_INVALID' }));
    expect(validateAssessment(payload, { sourceHash: 'hash', transcript, corrections, transcriptComplete: true })
      .categories.ORGANIZATION.improvementEvidence[0].finalQuarter).toBe(true);
  });

  test('accepts a validated global CONC correction for a conclusion-specific claim', () => {
    const payload = valid();
    const withConclusion = [...corrections, { id: 'conc-1', category: 'ORGANIZATION', symbol: 'CONC',
      quotedText: 'The ending repeats', correctionKind: 'global' }];
    payload.categories.ORGANIZATION.comment = 'The conclusion is weak.';
    payload.categories.ORGANIZATION.improvementEvidence = [{ evidenceType: 'correction', correctionId: 'conc-1',
      evidenceId: null, explanation: 'The conclusion is weak.', suggestion: 'Develop the conclusion.' }];
    expect(validateAssessment(payload, { sourceHash: 'hash', transcript, corrections: withConclusion,
      transcriptComplete: true }).categories.ORGANIZATION.improvementEvidence[0].correctionId).toBe('conc-1');
  });

  test.each([99, -1, '18'])('rejects incorrect score type or range: %p', (score) => {
    const payload = valid();
    payload.categories.CONTENT.score = score;
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_SCORE_INVALID',
        validationStage: 'score_validation',
        validationIssues: [expect.objectContaining({
          path: 'categories.CONTENT.score',
          code: 'SEMANTIC_RUBRIC_SCORE_INVALID',
          category: 'CONTENT',
          expectedType: 'number',
          expectedMinimum: 0,
          expectedMaximum: 20
        })] }));
  });

  test('reports only safe primitive score diagnostics and never clamps an over-range score', () => {
    const payload = valid();
    payload.categories.CONTENT.score = 25;
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(expect.objectContaining({
        validationIssues: [expect.objectContaining({
          actualType: 'number',
          finite: true,
          actualNumericValue: 25,
          expectedMaximum: 20
        })]
      }));
    expect(payload.categories.CONTENT.score).toBe(25);
  });

  test('accepts exactly one surrounding Markdown JSON fence', () => {
    expect(parseJson(`\`\`\`json\n${JSON.stringify(valid())}\n\`\`\``)).toEqual(valid());
  });

  test.each([
    ['not json', 'SEMANTIC_RUBRIC_JSON_INVALID', 'json_parse'],
    ['Here is the result: {"sourceHash":"hash"}', 'SEMANTIC_RUBRIC_JSON_INVALID', 'json_parse'],
    ['```text\n{"sourceHash":"hash"}\n```', 'SEMANTIC_RUBRIC_MARKDOWN', 'markdown_fence'],
    ['```json\n{"sourceHash":"hash"}\n```\nextra', 'SEMANTIC_RUBRIC_MARKDOWN', 'markdown_fence']
  ])('rejects unsupported rubric serialization %#', (content, code, stage) => {
    expect(() => parseJson(content)).toThrow(expect.objectContaining({ code, validationStage: stage }));
  });

  test('accepts a complete valid rubric response without changing scores', () => {
    const result = validateAssessment(valid(), { sourceHash: 'hash', transcript, corrections });
    expect(result.categories.CONTENT.score).toBe(18);
    expect(result.categories.ORGANIZATION.score).toBe(16);
    expect(result.categories.VOCABULARY.score).toBe(15);
  });

  test.each(['3 vocabulary errors were detected.', 'Frequent vocabulary errors weaken precision.'])
  ('normalizes a zero-count Vocabulary contradiction without changing score or evidence: %s', (comment) => {
    const payload = valid();
    payload.categories.VOCABULARY.comment = comment;
    payload.categories.VOCABULARY.improvementEvidence = [{ evidenceType: 'transcript', correctionId: null,
      evidenceId: evidence[1].evidenceId, explanation: 'The wording is repetitive.', suggestion: 'Use more precise wording.' }];
    const result = validateAssessment(payload, { sourceHash: 'hash', transcript,
      corrections: corrections.filter((item) => item.category !== 'VOCABULARY') });
    expect(result.categories.VOCABULARY.score).toBe(15);
    expect(result.categories.VOCABULARY.comment).toBe('This category was assessed holistically from the submitted writing. No validated canonical vocabulary corrections were recorded.');
    expect(result.categories.VOCABULARY.improvementEvidence[0].evidenceId).toBe(evidence[1].evidenceId);
    expect(result.diagnostics.commentNormalizations).toEqual([expect.objectContaining({ category: 'VOCABULARY',
      commentNormalized: true, commentNormalizationReason: 'ZERO_CANONICAL_COUNT_CONTRADICTION', canonicalCount: 0 })]);
  });

  test('normalizes a nonzero numeric claim to the authoritative canonical count', () => {
    const payload = valid();
    payload.categories.VOCABULARY.comment = '5 vocabulary corrections were detected.';
    const result = validateAssessment(payload, { sourceHash: 'hash', transcript,
      corrections: [...corrections, { id: 'v2', category: 'VOCABULARY', quotedText: 'same point' }] });
    expect(result.categories.VOCABULARY.score).toBe(15);
    expect(result.categories.VOCABULARY.comment).toContain('2 validated canonical vocabulary corrections');
    expect(result.diagnostics.commentNormalizations[0]).toMatchObject({ canonicalCount: 2,
      commentNormalizationReason: 'NONZERO_CANONICAL_COUNT_CONTRADICTION' });
  });

  test('accepts a gateway-validated fallback replacement in one transaction', async () => {
    const invalid = valid();
    invalid.categories.CONTENT.score = 25;
    const runCompletion = jest.fn(async ({ validate }) => ({
      content: JSON.stringify(valid()), value: validate(JSON.stringify(valid())),
      provider: 'openrouter', model: 'fallback-model',
      metrics: { attempts: [{ status: 'failed', code: 'AI_OUTPUT_VALIDATION_FAILED' },
        { status: 'success', code: null }] }
    }));
    const result = await assess({
      transcript, corrections, sourceHash: 'hash', assignment: { title: 'Essay' }, statistics: {}, pageManifest: []
    }, {
      runCompletion,
      config: {
        provider: 'google', model: 'primary-model',
        chain: [{ provider: 'google', model: 'primary-model' }, { provider: 'openrouter', model: 'fallback-model' }],
        totalBudgetMs: 90000, attemptTimeoutMs: 45000, maxRetries: 0, maxOutputTokens: 4000
      }
    });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(runCompletion.mock.calls[0][0]).toMatchObject({ schemaName: 'semantic_rubric_assessment',
      responseSchema: { type: 'object', additionalProperties: false,
        properties: { sourceHash: { const: 'hash' } } } });
    const responseSchema = runCompletion.mock.calls[0][0].responseSchema;
    expect(responseSchema.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).toEqual(evidence.map((item) => item.evidenceId));
    expect(responseSchema.properties.categories.properties.CONTENT.properties.improvementEvidence.items
      .properties.correctionId.enum).toEqual([null, 'c1']);
    expect(result.categories.CONTENT.score).toBe(18);
    expect(result.metrics.validationRepairAttempted).toBe(false);
    expect(result.metrics.attempts).toHaveLength(2);
  });

  test('fails truthfully when gateway validation rejects the chain', async () => {
    const invalid = valid();
    invalid.categories.CONTENT.score = 25;
    const runCompletion = jest.fn(async ({ validate }) => validate(JSON.stringify(invalid)));
    await expect(assess({
      transcript, corrections, sourceHash: 'hash', assignment: { title: 'Essay' }, statistics: {}, pageManifest: []
    }, {
      runCompletion,
      config: {
        provider: 'google', model: 'primary-model', chain: [{ provider: 'google', model: 'primary-model' }],
        totalBudgetMs: 90000, attemptTimeoutMs: 45000, maxRetries: 0, maxOutputTokens: 4000
      }
    })).rejects.toMatchObject({ code: 'SEMANTIC_RUBRIC_SCORE_INVALID' });
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  test('validates transcript evidence returned by a gateway fallback', async () => {
    const invalid = valid();
    invalid.categories.CONTENT.improvementEvidence[0].correctionId = 'invented-content-id';
    const repaired = valid();
    repaired.categories.CONTENT.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, evidenceId: evidence[0].evidenceId,
      explanation: 'The idea needs more development.', suggestion: 'Add a specific supporting example.'
    }];
    const runCompletion = jest.fn(async ({ validate }) => ({
      content: JSON.stringify(repaired), value: validate(JSON.stringify(repaired)),
      provider: 'openrouter', model: 'fallback-model',
      metrics: { attempts: [{ status: 'failed', code: 'AI_OUTPUT_VALIDATION_FAILED' },
        { status: 'success', code: null }] }
    }));
    const result = await assess({
      transcript,
      corrections: corrections.filter((item) => item.category !== 'CONTENT'),
      sourceHash: 'hash',
      assignment: { title: 'Essay' },
      statistics: {},
      pageManifest: []
    }, {
      runCompletion,
      config: {
        provider: 'google', model: 'primary-model',
        chain: [{ provider: 'google', model: 'primary-model' }, { provider: 'openrouter', model: 'fallback-model' }],
        totalBudgetMs: 90000, attemptTimeoutMs: 45000, maxRetries: 0, maxOutputTokens: 4000
      }
    });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(result.categories.CONTENT.improvementEvidence[0]).toMatchObject({
      evidenceType: 'transcript', correctionId: null
    });
    expect(result.metrics.attempts).toHaveLength(2);
    expect(result.metrics.attempts[1]).toMatchObject({ status: 'success' });
  });

  test('rejects invented primary evidence, then normalizes a valid zero-count fallback comment', async () => {
    const configuredEnv = {
      ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
      ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter', ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1-mini',
      ASSESSMENT_AI_PRIMARY_RETRIES: '0', ASSESSMENT_AI_FALLBACK_RETRIES: '0',
      ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '30000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '90000',
      ASSESSMENT_AI_RETRY_DELAY_MS: '0', SEMANTIC_AI_MAX_OUTPUT_TOKENS: '4000',
      OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: 'https://router.test/v1'
    };
    const invalidPrimary = valid();
    invalidPrimary.categories.CONTENT.strengthEvidence[0].evidenceId = 'invented-id';
    const validFallback = valid();
    validFallback.categories.VOCABULARY.comment = '3 vocabulary errors were detected.';
    validFallback.categories.VOCABULARY.improvementEvidence = [{ evidenceType: 'transcript', correctionId: null,
      evidenceId: evidence[1].evidenceId, explanation: 'The wording is repetitive.', suggestion: 'Use precise wording.' }];
    const payloads = [invalidPrimary, validFallback];
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify(payloads.shift()) } }] }) }));
    const result = await assess({ transcript, sourceHash: 'hash', assignment: { title: 'Essay' },
      corrections: corrections.filter((item) => item.category !== 'VOCABULARY'), statistics: { vocabulary: 0 },
      pageManifest: [] }, { config: getSemanticAIConfig(configuredEnv), env: configuredEnv, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('openai/gpt-4.1');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe('openai/gpt-4.1-mini');
    expect(result.metrics.attempts[0]).toMatchObject({ fallbackIndex: 0, code: 'AI_OUTPUT_VALIDATION_FAILED',
      validationCode: 'SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID' });
    expect(result.metrics.attempts[1]).toMatchObject({ fallbackIndex: 1, status: 'success' });
    expect(result.categories.VOCABULARY.score).toBe(15);
    expect(result.categories.VOCABULARY.comment).not.toMatch(/3 vocabulary errors|frequent vocabulary errors/iu);
    expect(result.diagnostics.commentNormalizations[0]).toMatchObject({ category: 'VOCABULARY',
      commentNormalizationReason: 'ZERO_CANONICAL_COUNT_CONTRADICTION' });
    const schema = JSON.parse(fetchImpl.mock.calls[0][1].body).response_format.json_schema.schema;
    expect(schema.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).toEqual(evidence.map((item) => item.evidenceId));
    expect(schema.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).not.toContain('invented-id');
  });
});
