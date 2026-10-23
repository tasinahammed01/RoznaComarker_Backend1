'use strict';
const { defaultLegend } = require('../../src/services/writingCorrections.service');
const categories = defaultLegend().groups.map(group => group.key);
function reviewPayload(hash, selected = categories, findings = [], legend = defaultLegend()) {
  return { transcriptHash: hash, categories: Object.fromEntries(selected.map(category => [category, {
    reviewed: true, reviewedSymbols: legend.groups.find(group => group.key === category).symbols.map(item => item.symbol),
    noFindingReason: findings.some(item => item.category === category) ? '' : 'No countable issue was found after reviewing this category.',
    corrections: findings.filter(item => item.category === category).map(({ category: ignored, ...item }) => item)
  }])) };
}
function reviewedResult(input, corrections = []) {
  const selected = input.categories || categories;
  return { corrections, provider: 'openrouter', model: 'openai/gpt-6-astra', metrics: { attempts: [] }, diagnostics: {
    schemaValidated: true, allCategoriesReviewed: true, reviewedCategories: selected,
    categoryReviews: selected.map(category => ({ category, reviewed: true })),
    symbolReviewCoverage: Object.fromEntries(selected.map(category => [category, { complete: true }]))
  } };
}
const finding = (category, symbol, quotedText, overrides = {}) => ({ category, symbol, quotedText,
  occurrence: 0, confidence: .99, correctionKind: ['CONTENT', 'ORGANIZATION'].includes(category) ? 'global' : 'localized',
  message: 'A grounded issue requires revision.', suggestedText: ['CONTENT', 'ORGANIZATION'].includes(category) ? '' : 'corrected',
  severity: 'high', stylePreference: false, ...overrides });
module.exports = { categories, reviewPayload, reviewedResult, finding };
