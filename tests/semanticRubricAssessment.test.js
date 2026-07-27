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

  test('performs at most one bounded repair and validates the complete replacement response', async () => {
    const invalid = valid();
    invalid.categories.CONTENT.score = 25;
    const runCompletion = jest.fn()
      .mockResolvedValueOnce({
        content: JSON.stringify(invalid), provider: 'google', model: 'gemini-3.6-flash',
        httpStatus: 200, finishReason: 'STOP', candidateCount: 1, hasContent: true, hasText: true,
        responseTextLength: 100, metrics: { attempts: [{ attempt: 1, status: 'completed' }] }
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(valid()), provider: 'google', model: 'gemini-3.6-flash',
        httpStatus: 200, finishReason: 'STOP', candidateCount: 1, hasContent: true, hasText: true,
        responseTextLength: 100, metrics: { attempts: [{ attempt: 1, status: 'completed' }] }
      });
    const result = await assess({
      transcript, corrections, sourceHash: 'hash', assignment: { title: 'Essay' }, statistics: {}, pageManifest: []
    }, {
      runCompletion,
      env: { GEMINI_API_KEY: 'test' },
      config: {
        provider: 'google', model: 'gemini-3.6-flash', totalBudgetMs: 90000, attemptTimeoutMs: 45000,
        minAttemptBudgetMs: 1000, maxRetries: 1, maxOutputTokens: 4000, approvedModels: []
      }
    });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1][0].config).toMatchObject({ maxRetries: 0 });
    expect(runCompletion.mock.calls[1][0].messages.at(-1).content).toContain('categories.CONTENT.score');
    expect(result.categories.CONTENT.score).toBe(18);
    expect(result.metrics.validationRepairAttempted).toBe(true);
  });

  test('fails truthfully after one invalid repair response', async () => {
    const invalid = valid();
    invalid.categories.CONTENT.score = 25;
    const runCompletion = jest.fn().mockResolvedValue({
      content: JSON.stringify(invalid), provider: 'google', model: 'gemini-3.6-flash',
      httpStatus: 200, finishReason: 'STOP', candidateCount: 1, hasContent: true, hasText: true,
      responseTextLength: 100, metrics: { attempts: [] }
    });
    await expect(assess({
      transcript, corrections, sourceHash: 'hash', assignment: { title: 'Essay' }, statistics: {}, pageManifest: []
    }, {
      runCompletion,
      env: { GEMINI_API_KEY: 'test' },
      config: {
        provider: 'google', model: 'gemini-3.6-flash', totalBudgetMs: 90000, attemptTimeoutMs: 45000,
        minAttemptBudgetMs: 1000, maxRetries: 1, maxOutputTokens: 4000, approvedModels: []
      }
    })).rejects.toMatchObject({ code: 'SEMANTIC_RUBRIC_SCORE_INVALID', repairAttempted: true });
    expect(runCompletion).toHaveBeenCalledTimes(2);
  });
});
