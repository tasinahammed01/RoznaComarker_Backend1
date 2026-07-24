const { validateAssessment } = require('../src/services/semanticRubricAssessment.service');

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

  test('clamps category scores and preserves server-side maxima', () => {
    const payload = valid();
    payload.categories.CONTENT.score = 99;
    const result = validateAssessment(payload, { sourceHash: 'hash', transcript, corrections });
    expect(result.categories.CONTENT.score).toBe(20);
    expect(result.categories.CONTENT.maxScore).toBe(20);
  });
});
