const service = require('../src/services/canonicalDetailedFeedback.service');

describe('canonical detailed feedback', () => {
  const corrections = [
    { id: 'g1', category: 'GRAMMAR', symbol: 'AGR', symbolLabel: 'Agreement', quotedText: 'students learns', message: 'Agreement', suggestedText: 'students learn', confidence: .99 },
    { id: 'g2', category: 'GRAMMAR', symbol: 'AGR', quotedText: 'AI have', message: 'Agreement', suggestedText: 'AI has', confidence: .98 },
    { id: 'm1', category: 'MECHANICS', symbol: 'P', quotedText: 'idea however', message: 'Punctuation', suggestedText: 'idea; however', confidence: 1 }
  ];
  const statistics = { content: 0, organization: 0, grammar: 2, vocabulary: 0, mechanics: 1, total: 3 };
  const categoryScores = {
    GRAMMAR: { score: 20, maxScore: 25, comment: 'Repeated agreement errors affect accuracy.' },
    MECHANICS: { score: 9, maxScore: 10, comment: 'Punctuation is generally controlled.' },
    CONTENT: { score: 18, maxScore: 20, comment: 'Ideas address the task with support.' },
    ORGANIZATION: { score: 16, maxScore: 20, comment: '' }, VOCABULARY: { score: 16, maxScore: 20, comment: '' },
    PRESENTATION: { score: 5, maxScore: 5, comment: 'OCR readability was sufficient.' }
  };

  test('uses current counts, dominant symbols, real IDs and quotations', () => {
    const result = service.buildDeterministicDetailedFeedback({ corrections, statistics, categoryScores, sourceHash: 'hash' });
    const grammar = result.areasForImprovement.find((item) => item.category === 'GRAMMAR');
    expect(grammar).toMatchObject({ issueCount: 2, score: 20, dominantSymbols: ['AGR'] });
    expect(grammar.examples.map((item) => item.correctionId)).toEqual(['g1', 'g2']);
    expect(grammar.examples[0].quotedText).toBe('students learns');
    expect(grammar.examples[0].symbolLabel).toBe('Agreement');
    expect(result.actionSteps[0].relatedCorrectionIds.length).toBeGreaterThan(0);
    expect(service.validateDetailedFeedback(result, { corrections, statistics, categoryScores, sourceHash: 'hash' })).toBe(result);
  });

  test('represents a legitimate no-improvement result explicitly and rejects generic string arrays as canonical', () => {
    const result = service.buildDeterministicDetailedFeedback({ corrections: [], statistics: {
      content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0
    }, categoryScores: {}, sourceHash: 'hash' });
    expect(result).toMatchObject({ status: 'completed', sourceHash: 'hash', areasForImprovement: [], strengths: [], actionSteps: [] });
    expect(service.isStructuredDetailedFeedback(result)).toBe(true);
    expect(service.isStructuredDetailedFeedback({ areasForImprovement: ['generic'], strengths: [], actionSteps: [] })).toBe(false);
  });

  test('does not infer a strength from zero issues without positive evaluation evidence', () => {
    const result = service.buildDeterministicDetailedFeedback({ corrections, statistics, categoryScores, sourceHash: 'hash' });
    expect(result.strengths.some((item) => item.category === 'ORGANIZATION')).toBe(false);
    expect(result.strengths.some((item) => item.category === 'CONTENT')).toBe(true);
    expect(result.strengths.find((item) => item.category === 'PRESENTATION').provisional).toBe(true);
  });

  test('rejects stale hashes, contradictory counts and invented correction IDs', () => {
    const result = service.buildDeterministicDetailedFeedback({ corrections, statistics, categoryScores, sourceHash: 'hash' });
    expect(service.validateDetailedFeedback(result, { corrections, statistics, categoryScores, sourceHash: 'new' })).toBeNull();
    result.areasForImprovement[0].issueCount = 99;
    expect(service.validateDetailedFeedback(result, { corrections, statistics, categoryScores, sourceHash: 'hash' })).toBeNull();
  });
});
