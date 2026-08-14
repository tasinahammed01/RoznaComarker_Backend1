'use strict';

const { groundAdaptiveEvidence, normalizeEvidenceForComparison } = require('../src/utils/adaptivePracticeEvidenceGrounding');

describe('adaptive practice evidence grounding', () => {
  test('accepts exact canonical evidence', () => {
    expect(groundAdaptiveEvidence('Cars are convenient but create parking problems.',
      'Cars are convenient but create parking problems.').grounded).toBe(true);
  });

  test('accepts harmless OCR line wrapping and repeated whitespace', () => {
    const source = 'This is a sentence\nwith a line break and   OCR spacing.';
    const evidence = 'This is a sentence with a line break and OCR spacing.';
    expect(groundAdaptiveEvidence(source, evidence).grounded).toBe(true);
  });

  test('accepts typographically equivalent Unicode quotes', () => {
    expect(groundAdaptiveEvidence('The student wrote “it’s effective.”',
      'The student wrote "it\'s effective."').grounded).toBe(true);
  });

  test.each([
    ['', 'Source text.'],
    ['Invented evidence.', 'Source text.'],
    ['Private vehicles are useful but cause traffic difficulties.',
      'Cars are convenient but create parking problems.'],
    ['Evidence copied from another submission.', 'This submission has different wording.']
  ])('rejects empty, fabricated, paraphrased, or wrong-submission evidence', (evidence, source) => {
    expect(groundAdaptiveEvidence(source, evidence).grounded).toBe(false);
  });

  test('does not normalize away punctuation that can be meaningful for mechanics', () => {
    expect(normalizeEvidenceForComparison('Wait, stop.')).not.toBe(normalizeEvidenceForComparison('Wait stop.'));
    expect(groundAdaptiveEvidence('Wait, stop.', 'Wait stop.').grounded).toBe(false);
  });

  test('handles a realistic OCR page wrap without changing the visible evidence value', () => {
    const source = 'Many students prefer online learning because it is\nflexible and accessible.\n\nHowever, interaction can be limited.';
    const result = groundAdaptiveEvidence(source,
      'students prefer online learning because it is flexible and accessible.');
    expect(result.grounded).toBe(true);
    expect(result.evidence).toBe('students prefer online learning because it is flexible and accessible.');
  });
});
