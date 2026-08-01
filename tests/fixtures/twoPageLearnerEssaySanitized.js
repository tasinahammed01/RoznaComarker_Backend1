'use strict';

// Synthetic expert fixture distilled from common learner-English patterns. It
// contains no names, file metadata, or complete student submission text.
const transcript = [
  'Online platforms has become common for students.',
  'Almost every students use them for study.',
  'The main benefit are communication, but this broad claim needs specific support.',
  'Students can find many explanation, and online learning is more easier.',
  'However this final paragraph repeats the claim and ends without resolving the argument.'
].join(' ');

const corrections = [
  { category: 'GRAMMAR', symbol: 'AGR', correctionKind: 'localized', quotedText: 'platforms has', occurrence: 0,
    message: 'Use plural subject-verb agreement.', suggestedText: 'platforms have', confidence: 0.96 },
  { category: 'VOCABULARY', symbol: 'WF', correctionKind: 'localized', quotedText: 'many explanation', occurrence: 0,
    message: 'Use the plural noun form after many.', suggestedText: 'many explanations', confidence: 0.94 },
  { category: 'CONTENT', symbol: 'SD', correctionKind: 'global', quotedText: 'this broad claim needs specific support', occurrence: 0,
    message: 'Develop the claim with concrete support.', suggestedText: '', confidence: 0.91 },
  { category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global',
    quotedText: 'this final paragraph repeats the claim and ends without resolving the argument', occurrence: 0,
    message: 'The ending does not synthesize or close the argument.', suggestedText: '', confidence: 0.93 }
];

module.exports = { transcript, corrections, expectedMinimumCategories: ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR'] };
