'use strict';
// Task 20: a well-formed finding that only exceeds a length limit is dropped and counted; it no longer rejects the whole correction reply.
const { defaultLegend } = require('../src/services/writingCorrections.service');

describe('a reply with one over-long finding', () => {
  const wire = require('../src/services/compactCorrectionWire.service');
  const semantic = require('../src/services/semanticWritingCorrections.service');
  const legend = semantic.compactSemanticLegend(defaultLegend());
  const item = (overrides = {}) => ({ symbol: 'SP', message: 'Spelling.', correctionKind: 'localized', quotedText: 'mispell', occurrence: 0,
    suggestedText: 'misspell', confidence: 0.9, severity: 'medium', ...overrides });
  const reply = (findings) => ({ reviewContract: wire.EXPLANATION_VERSION, transcriptHash: 'h', categories: Object.fromEntries(legend.map(group => [group.category, {
    reviewed: true, reviewedSymbols: Object.fromEntries(group.symbols.map(s => [s.symbol, true])), corrections: group.category === 'MECHANICS' ? findings : [] }])) });
  test('keeps the valid findings and leaves out only the over-long one, counted', () => {
    const out = wire.expand(reply([item(), item({ quotedText: 'x'.repeat(501) }), item({ symbol: 'CAP', quotedText: 'monday', suggestedText: 'Monday' })]), legend);
    expect(out.categories.MECHANICS.corrections.map(c => c.symbol)).toEqual(['SP', 'CAP']);
    expect(out.overlongFindingsDropped).toBe(1);
    expect(Object.keys(out)).toEqual(['transcriptHash', 'categories']);
  });
  test('the same for an over-long suggestion or explanation', () => {
    const out = wire.expand(reply([item({ suggestedText: 'y'.repeat(301) }), item({ message: 'z'.repeat(241) }), item()]), legend);
    expect(out.categories.MECHANICS.corrections).toHaveLength(1);
    expect(out.overlongFindingsDropped).toBe(2);
  });
  test('a structural defect still rejects the whole reply', () => {
    for (const bad of [item({ severity: 'urgent' }), item({ extra: 1 }), item({ quotedText: '' }), item({ occurrence: -1 }), item({ symbol: 'NOPE' }), item({ confidence: 2 })]) {
      expect(() => wire.expand(reply([item(), bad]), legend)).toThrow('Invalid compact correction response.');
    }
  });
});
