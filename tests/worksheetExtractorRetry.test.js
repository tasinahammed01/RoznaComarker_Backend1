const VALID_STRUCTURE = {
  title: 'Fractions',
  description: 'Practice fractions',
  subject: 'Math',
  sections: [{
    instruction: 'Answer each question.',
    questions: [{
      id: 'q1', prompt: 'What is 1/2 + 1/2?', type: 'short_answer',
      correct_answer: '1', topic: 'fractions', confidence: 'high'
    }]
  }]
};

const providerSuccess = (content, finishReason = 'stop') => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }]
  })
});

function mixedWorksheetStructure() {
  const questions = [];
  const mcqPrompts = ['Which word correctly applies the silent-e suffix rule?',
    'Select the correctly doubled consonant before adding the ending.',
    'Identify the plural spelling supported by the teacher answer key.'];
  for (let index = 1; index <= 3; index += 1) questions.push({ id: `mcq-${index}`,
    prompt: mcqPrompts[index - 1], type: 'multiple_choice',
    options: [`answer-${index}`, `choice-b-${index}`, `choice-c-${index}`, `choice-d-${index}`],
    correct_answer: `answer-${index}`, topic: 'spelling', confidence: 'high' });
  for (let index = 1; index <= 3; index += 1) questions.push({ id: `blank-${index}`,
    prompt: `Complete spelling rule ${index}: ______`, type: 'fill_blank', correct_answer: `rule-${index}`,
    topic: 'rules', confidence: 'high' });
  const trueFalsePrompts = ['A silent final e is removed before adding ing.',
    'Every one-syllable word doubles its ending consonant.',
    'The answer table identifies which plural form is correct.'];
  for (let index = 1; index <= 3; index += 1) questions.push({ id: `tf-${index}`,
    prompt: trueFalsePrompts[index - 1], type: 'true_false',
    correct_answer: index % 2 ? 'true' : 'false', topic: 'rules', confidence: 'high' });
  for (let index = 1; index <= 6; index += 1) questions.push({ id: `short-${index}`,
    prompt: `Explain source example ${index}.`, type: 'short_answer', correct_answer: `Explanation ${index}`,
    topic: 'application', confidence: 'medium' });
  return { title: 'Spelling Rules', description: 'Mixed Word worksheet', subject: 'English',
    sections: [{ instruction: 'Complete every section in source order.', questions }] };
}

describe('worksheet structure extraction bounded retry', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env.WORKSHEET_EXTRACTION_AI_PRIMARY_PROVIDER = 'openrouter';
    process.env.WORKSHEET_EXTRACTION_AI_PRIMARY_MODEL = 'test/worksheet-model';
    process.env.WORKSHEET_EXTRACTION_AI_FALLBACK_PROVIDER = 'openrouter';
    process.env.WORKSHEET_EXTRACTION_AI_FALLBACK_MODEL = 'test/worksheet-fallback';
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_BASE_URL = 'https://router.test/v1';
    process.env.AI_ATTEMPT_TIMEOUT_MS = '60000';
    process.env.AI_TOTAL_BUDGET_MS = '120000';
    process.env.AI_RETRY_DELAY_MS = '0';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  async function extractWithResponses(...responses) {
    global.fetch = jest.fn();
    responses.forEach((response) => global.fetch.mockImplementationOnce(async () => response));
    const { extractWorksheetStructure } = require('../src/services/worksheetExtractor.service');
    return extractWorksheetStructure('A sufficiently long, valid worksheet text fixture.', {
      language: 'English', subject: 'Math', gradeLevel: '5'
    });
  }

  test('accepts a valid first response without retrying', async () => {
    const result = await extractWithResponses(providerSuccess(JSON.stringify(VALID_STRUCTURE)));
    expect(result.extractedStructure).toEqual(VALID_STRUCTURE);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['valid JSON missing sections', JSON.stringify({ title: 'Wrong shape' })],
    ['malformed JSON', '{"title":"Broken","sections":['],
    ['empty output', ''],
  ])('retries once after %s and accepts the second valid response', async (_label, firstContent) => {
    const result = await extractWithResponses(
      providerSuccess(firstContent),
      providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    expect(result.extractedStructure.sections).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('retries once after a provider-truncated response', async () => {
    const result = await extractWithResponses(
      providerSuccess('{"title":"Cut off"', 'length'),
      providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    expect(result.extractedStructure).toEqual(VALID_STRUCTURE);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('performs exactly one validator-guided repair and returns a controlled failure', async () => {
    await expect(extractWithResponses(
      providerSuccess(JSON.stringify({ title: 'Missing sections' })),
      providerSuccess('{still broken')
    )).rejects.toMatchObject({
      code: 'EXTRACTION_INVALID_TITLE',
      finalFailureCode: 'EXTRACTION_INVALID_TITLE',
      repairAttempted: true,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('does not retry provider authentication failures', async () => {
    await expect(extractWithResponses({
      ok: false, status: 401, headers: { get: () => null }, text: async () => ''
    })).rejects.toMatchObject({ code: 'AI_PROVIDER_AUTH_ERROR', attemptCount: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([429, 503])('retries one provider %i response and succeeds', async (status) => {
    const result = await extractWithResponses(
      { ok: false, status, headers: { get: () => null }, text: async () => '' },
      providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    expect(result.extractedStructure.title).toBe('Fractions');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('retries one timeout and succeeds with a fresh provider attempt', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    global.fetch = jest.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(providerSuccess(JSON.stringify(VALID_STRUCTURE)));
    const { extractWorksheetStructure } = require('../src/services/worksheetExtractor.service');
    const result = await extractWorksheetStructure('A valid worksheet fixture.');
    expect(result.extractedStructure.title).toBe('Fractions');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('accepts a whole-response JSON code fence without weakening the schema', async () => {
    const result = await extractWithResponses(
      providerSuccess(`\`\`\`json\n${JSON.stringify(VALID_STRUCTURE)}\n\`\`\``)
    );
    expect(result.extractedStructure).toEqual(VALID_STRUCTURE);
  });

  test('the repair prompt includes exact validator errors and preserves bounded call count', async () => {
    const result = await extractWithResponses(
      providerSuccess(JSON.stringify({ title: 'Missing sections' })),
      providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    const repairBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(repairBody.messages[1].content).toContain('EXTRACTION_MISSING_SECTIONS');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.title).toBe('Fractions');
  });

  test('safely extracts JSON surrounded by prose and normalizes harmless aliases', async () => {
    const nearValid = JSON.parse(JSON.stringify(VALID_STRUCTURE));
    nearValid.sections[0].questions[0].type = 'open_ended';
    const result = await extractWithResponses(providerSuccess(`Here is the result:\n${JSON.stringify(nearValid)}\nDone.`));
    expect(result.extractedStructure.sections[0].questions[0].type).toBe('short_answer');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('invalid question type is a retryable structured validation failure', async () => {
    const invalid = JSON.parse(JSON.stringify(VALID_STRUCTURE));
    invalid.sections[0].questions[0].type = 'unknown';
    const result = await extractWithResponses(
      providerSuccess(JSON.stringify(invalid)), providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    expect(result.title).toBe('Fractions');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('invalid MCQ followed by a valid mixed-document repair returns the repaired review structure', async () => {
    const repaired = mixedWorksheetStructure();
    const invalid = JSON.parse(JSON.stringify(repaired));
    invalid.sections[0].questions[0].options = ['duplicate', 'duplicate', 'third', 'fourth'];
    const source = Array.from({ length: 62 }, (_value, index) =>
      `${index + 1}. Spelling worksheet source fact ${index + 1} with enough distinct educational text.`).join('\n')
      .slice(0, 2680) + '\nTABLE ROW 1: Question | Options | Answer';
    const result = await extractWithResponsesForSource(source,
      providerSuccess(JSON.stringify(invalid)), providerSuccess(JSON.stringify(repaired)));
    expect(result.extractedStructure).toEqual(repaired);
    expect(result.extractionDiagnostics).toEqual(expect.objectContaining({
      repairAttempted: true, validationErrors: [], finalFailureCode: null,
      validationHistory: [{ stage: 'semantic', code: 'EXTRACTION_INVALID_MCQ_OPTIONS' }],
    }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('reports a distinct source-coverage stage and code after schema/semantic success', () => {
    const { validateExtractionPipeline } = require('../src/services/worksheetExtractor.service');
    const validation = validateExtractionPipeline(JSON.stringify(VALID_STRUCTURE), {
      sparse: false, targetItems: 12,
    });
    expect(validation).toMatchObject({ ok: false, stage: 'source_coverage',
      code: 'EXTRACTION_INSUFFICIENT_ITEMS' });
  });

  async function extractWithResponsesForSource(source, ...responses) {
    global.fetch = jest.fn();
    responses.forEach((response) => global.fetch.mockImplementationOnce(async () => response));
    const { extractWorksheetStructure } = require('../src/services/worksheetExtractor.service');
    return extractWorksheetStructure(source, { language: 'English', subject: 'English', gradeLevel: '5' });
  }
});
