'use strict';
const { normalizeCorrection } = require('../../src/services/correctionCanonical.service');
const { defaultLegend } = require('../../src/services/writingCorrections.service');
const rubric = require('../../src/services/semanticRubricAssessment.service');
function fixture() {
  const rows = [{ category: 'CONTENT', symbol: 'DEV', text: 'Society controls every choice.', suggestion: '' },
    { category: 'VOCABULARY', symbol: 'COL', text: 'a strong rain', suggestion: 'a heavy rain' },
    ...Array.from({ length: 7 }, (_, i) => ({ category: 'GRAMMAR', symbol: 'AGR', text: `She know item${i}`, suggestion: `She knows item${i}` })),
    ...Array.from({ length: 11 }, (_, i) => ({ category: 'MECHANICS', symbol: 'SP', text: `mispell${i}`, suggestion: `misspell${i}` }))];
  const transcript = rows.map(row => row.text).join(' ');
  let offset = 0;
  const corrections = rows.map(row => {
    const startChar = offset; offset += row.text.length + 1;
    return normalizeCorrection({ category: row.category, symbol: row.symbol, quotedText: row.text,
      suggestedText: row.suggestion, startChar, endChar: startChar + row.text.length,
      correctionKind: row.category === 'CONTENT' ? 'global' : 'localized', severity: 'medium', confidence: .99,
      message: 'Synthetic canonical source-grounded finding.' }, transcript, [], defaultLegend(), 'AI');
  });
  const evidence = rubric.transcriptEvidenceCatalog(transcript);
  const payload = { sourceHash: 'frozen-rubric-source', categories: Object.fromEntries(
    ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map((category, index) => {
      const correction = corrections.find(item => item.category === category);
      return [category, { score: 18 - index, maxScore: 20, comment: 'This category uses exact supplied evidence.',
        strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'A clear idea is expressed.' }],
        improvementEvidence: [{ findingScope: correction ? 'localized' : 'holistic',
          evidenceType: correction ? 'correction' : 'transcript', correctionId: correction?.id || null,
          evidenceId: correction ? `correction:${correction.id}` : evidence[0].evidenceId,
          explanation: 'This passage supports an improvement.', suggestion: 'Clarify the relevant point.' }] }];
    })) };
  return { transcript, corrections, evidence, payload };
}
module.exports = { fixture };
