const {
  hasValidOcrPages,
  hasValidLegacyOcrWords,
  hasUsableOcrData
} = require('../src/controllers/submission.controller');

describe('OCR availability helpers', () => {
  test('accepts persisted multi-file OCR pages without legacy words', () => {
    const submission = { ocrPages: [{ fileId: 'file-1', text: 'Persisted OCR text', words: [] }] };
    expect(hasValidOcrPages(submission)).toBe(true);
    expect(hasValidLegacyOcrWords(submission)).toBe(false);
    expect(hasUsableOcrData(submission)).toBe(true);
  });

  test('accepts valid legacy OCR words', () => {
    const submission = { ocrData: { words: [{ text: 'Hello' }] } };
    expect(hasValidLegacyOcrWords(submission)).toBe(true);
    expect(hasUsableOcrData(submission)).toBe(true);
  });

  test('rejects an empty completed OCR payload', () => {
    expect(hasUsableOcrData({ ocrStatus: 'completed', ocrPages: [], ocrData: { words: [] } })).toBe(false);
  });
});
