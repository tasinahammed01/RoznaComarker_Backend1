const { parseJson, validateAssessment, assess } = require('../src/services/semanticRubricAssessment.service');

const transcript = 'This essay has a clear idea. The ending repeats the same point.';
const corrections = [
  { id: 'c1', category: 'CONTENT', quotedText: 'clear idea' },
  { id: 'o1', category: 'ORGANIZATION', quotedText: 'The ending repeats' },
  { id: 'v1', category: 'VOCABULARY', quotedText: 'same point' }
];

function valid() {
  return { sourceHash: 'hash', categories: {
    CONTENT: { score: 18, maxScore: 20, comment: 'Relevant and developed.',
      strengthEvidence: [{ quotedText: 'clear idea', explanation: 'This states a controlling idea.' }],
      improvementEvidence: [{ correctionId: 'c1', quotedText: 'clear idea', explanation: 'Needs more support.', suggestion: 'Add evidence.' }] },
    ORGANIZATION: { score: 16, maxScore: 20, comment: 'Mostly logical.',
      strengthEvidence: [{ quotedText: 'This essay has a clear idea.', explanation: 'The opening is clear.' }],
      improvementEvidence: [{ correctionId: 'o1', quotedText: 'The ending repeats', explanation: 'The ending repeats.', suggestion: 'Revise the conclusion.' }] },
    VOCABULARY: { score: 15, maxScore: 20, comment: 'Adequate but repetitive.',
      strengthEvidence: [{ quotedText: 'clear idea', explanation: 'The phrase is understandable.' }],
      improvementEvidence: [{ correctionId: 'v1', quotedText: 'same point', explanation: 'The wording is repetitive.', suggestion: 'Use a more precise phrase.' }] }
  } };
}

describe('semantic rubric assessment validation', () => {
  test('rejects an incorrect source hash', () => {
    expect(() => validateAssessment({ ...valid(), sourceHash: 'old' }, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(/source hash/i);
  });

  test('rejects invented evidence quotes', () => {
    const payload = valid();
    payload.categories.CONTENT.strengthEvidence[0].quotedText = 'invented quotation';
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections }))
      .toThrow(/quote/i);
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
      evidenceType: 'transcript', correctionId: null, quotedText: 'clear idea',
      explanation: 'The idea needs more development.', suggestion: 'Add a specific supporting example.'
    }];
    payload.categories.ORGANIZATION.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, quotedText: 'The ending repeats',
      explanation: 'The conclusion repeats rather than synthesizes.', suggestion: 'Synthesize the main point.'
    }];
    const result = validateAssessment(payload, {
      sourceHash: 'hash',
      transcript,
      corrections: corrections.filter((item) => !['CONTENT', 'ORGANIZATION'].includes(item.category))
    });
    expect(result.categories.CONTENT.improvementEvidence[0]).toMatchObject({
      evidenceType: 'transcript', correctionId: null, quotedText: 'clear idea'
    });
    expect(result.categories.ORGANIZATION.improvementEvidence[0]).toMatchObject({
      evidenceType: 'transcript', correctionId: null, quotedText: 'The ending repeats'
    });
  });

  test('rejects a Grammar correction ID used as Content evidence', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence[0].correctionId = 'g1';
    expect(() => validateAssessment(payload, {
      sourceHash: 'hash', transcript, corrections: [...corrections, { id: 'g1', category: 'GRAMMAR', quotedText: 'clear idea' }]
    })).toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_CORRECTION_INVALID' }));
  });

  test('rejects an ungrounded transcript-evidence quotation', () => {
    const payload = valid();
    payload.categories.CONTENT.improvementEvidence = [{
      evidenceType: 'transcript', correctionId: null, quotedText: 'invented passage',
      explanation: 'Needs support.', suggestion: 'Add support.'
    }];
    expect(() => validateAssessment(payload, { sourceHash: 'hash', transcript, corrections: [] }))
      .toThrow(expect.objectContaining({ code: 'SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED' }));
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
      evidenceType: 'transcript', correctionId: null, quotedText: 'clear idea',
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
});
