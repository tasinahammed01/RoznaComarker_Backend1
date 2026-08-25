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

  test('falls back after two invalid primary outputs and returns a controlled failure', async () => {
    await expect(extractWithResponses(
      providerSuccess(JSON.stringify({ title: 'Missing sections' })),
      providerSuccess('{broken'),
      providerSuccess('{still broken')
    )).rejects.toMatchObject({
      code: 'AI_CHAIN_EXHAUSTED',
      finalFailureCode: 'AI_OUTPUT_VALIDATION_FAILED',
      attemptCount: 3
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
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

  test('uses the paid fallback after the primary retry is exhausted', async () => {
    const result = await extractWithResponses(
      providerSuccess('{broken'), providerSuccess('{broken again'),
      providerSuccess(JSON.stringify(VALID_STRUCTURE))
    );
    const bodies = global.fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.map((body) => body.model)).toEqual([
      'test/worksheet-model', 'test/worksheet-model', 'test/worksheet-fallback'
    ]);
    expect(result.title).toBe('Fractions');
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
});
