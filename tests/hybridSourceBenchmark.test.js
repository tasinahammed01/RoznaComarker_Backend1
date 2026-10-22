const { evaluate, edits, correctionMetrics, correctionControl } = require('../src/services/hybridSource/benchmark');
// Synthetic strings test arithmetic/contracts only. They are NOT a real-page benchmark.
const gold = { version: 'human-gold-v1', humanReviewed: true, reviewer: 'unit-test-only',
  imageSha256: 'a'.repeat(64), transcript: 'Hello, world!', excludedSpans: [], expectedCorrections: [] };
test('reports case/punctuation and word/character error separately', () => {
  const result = evaluate(gold, { imageSha256: gold.imageSha256, transcript: 'hello world!' });
  expect(result.CER).toBe(2 / 13); expect(result.WER).toBe(0.5);
  expect(result.punctuationErrors).toBe(1);
  expect(result.OCR_INDUCED_FALSE_CORRECTION_RATE).toBeNull();
  expect(result.geometryBindingSuccessRate).toBeNull();
});
test('distinguishes omissions from inserted words and refuses unreviewed gold', () => {
  expect(edits(['one', 'two'], ['one'])).toMatchObject({ deletions: 1, insertions: 0 });
  expect(edits(['one'], ['one', 'two'])).toMatchObject({ deletions: 0, insertions: 1 });
  expect(() => evaluate({ ...gold, humanReviewed: false }, {})).toThrow('HUMAN_GOLD');
  expect(() => evaluate(gold, { imageSha256: 'wrong', transcript: '' })).toThrow('SOURCE_MISMATCH');
});
test('OCR-induced rate requires explicit human labels, including false labels', () => {
  const base = { imageSha256: gold.imageSha256, transcript: gold.transcript };
  expect(evaluate(gold, { ...base, corrections: [{}] }).OCR_INDUCED_FALSE_CORRECTION_RATE).toBeNull();
  expect(evaluate(gold, { ...base, corrections: [{ humanReviewedOcrInduced: true },
    { humanReviewedOcrInduced: false }] }).OCR_INDUCED_FALSE_CORRECTION_RATE).toBe(0.5);
});
test('correction-only audit uses code-owned legend and flags unchanged suggestions', () => {
  expect(correctionMetrics([], [{ start: 0, end: 5, quotedText: 'Hello', suggestedText: 'Hello',
    category: 'MECHANICS', symbol: 'MADE_UP' }], gold.transcript)).toMatchObject({
    falsePositives: 1, invalidCode: 1, quoteMismatch: 0, unchangedSuggestion: 1 });
});
test('correction control cannot accidentally invoke a live provider', async () => {
  await expect(correctionControl(gold)).rejects.toThrow('OFFLINE_ADAPTER_REQUIRED');
});
test('correction control feeds verbatim human gold through existing semantic engine', async () => {
  const runCompletion = jest.fn(async () => ({ value: { corrections: [], diagnostics: {} },
    provider: 'offline', model: 'recorded', metrics: {} }));
  const result = await correctionControl({ ...gold, transcript: 'preception' }, {
    config: { chain: [{ provider: 'openrouter', model: 'unchanged-semantic-test-config' }] }, runCompletion });
  expect(result.corrections).toEqual([]);
  expect(JSON.stringify(runCompletion.mock.calls[0][0].messages)).toContain('preception');
  expect(runCompletion).toHaveBeenCalledTimes(1);
});
