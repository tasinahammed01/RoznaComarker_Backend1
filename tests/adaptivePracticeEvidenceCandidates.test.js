'use strict';

const {
  ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS,
  ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS,
  buildAdaptiveEvidenceCandidates
} = require('../src/utils/adaptivePracticeEvidenceCandidates');

describe('Adaptive Practice evidence candidates', () => {
  test('extracts deterministic source-derived sentences with stable request-local IDs', () => {
    expect(buildAdaptiveEvidenceCandidates('This is sentence one.\nThis is sentence two.')).toEqual([
      { id: 'e1', text: 'This is sentence one.' },
      { id: 'e2', text: 'This is sentence two.' }
    ]);
  });

  test('folds OCR line wrapping without changing student words or punctuation', () => {
    expect(buildAdaptiveEvidenceCandidates('This is a sentence that was\r\nwrapped across two OCR lines.'))
      .toEqual([{ id: 'e1', text: 'This is a sentence that was wrapped across two OCR lines.' }]);
  });

  test('uses paragraph boundaries when punctuation is imperfect', () => {
    expect(buildAdaptiveEvidenceCandidates('First paragraph has enough student words\n\nSecond paragraph also has enough student words'))
      .toEqual([
        { id: 'e1', text: 'First paragraph has enough student words' },
        { id: 'e2', text: 'Second paragraph also has enough student words' }
      ]);
  });

  test('splits long sentences only at word boundaries and respects the persisted evidence limit', () => {
    const source = `${Array.from({ length: 160 }, (_, index) => `word${index}`).join(' ')}.`;
    const candidates = buildAdaptiveEvidenceCandidates(source);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every(({ text }) => text.length <= ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS
      && text.length <= ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS)).toBe(true);
    expect(candidates.map(({ text }) => text).join(' ')).toBe(source);
  });

  test('creates bounded word-safe chunks when OCR text has no punctuation', () => {
    const source = Array.from({ length: 180 }, (_, index) => `token${index}`).join(' ');
    const candidates = buildAdaptiveEvidenceCandidates(source);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every(({ text }) => text.length <= ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS)).toBe(true);
    expect(candidates.map(({ text }) => text).join(' ')).toBe(source);
  });

  test('returns no candidates for an empty transcript or an unusable over-limit token', () => {
    expect(buildAdaptiveEvidenceCandidates('')).toEqual([]);
    expect(buildAdaptiveEvidenceCandidates('x'.repeat(ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS + 1))).toEqual([]);
  });
});
