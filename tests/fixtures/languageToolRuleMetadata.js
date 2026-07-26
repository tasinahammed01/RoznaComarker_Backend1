// Sanitized metadata captured from the configured LanguageTool /v2/check endpoint
// on 2026-07-27 using synthetic phrases. No student transcript or identity is stored.
module.exports = [
  { name: 'Show -> show', rule: { id: 'EN_UPPER_CASE_NGRAM', category: { id: 'CASING', name: 'Capitalization' }, issueType: 'misspelling' }, expected: ['MECHANICS', 'CAP'] },
  { name: 'informations -> information', rule: { id: 'INFORMATIONS', category: { id: 'NONSTANDARD_PHRASES', name: 'Nonstandard Phrases' }, issueType: 'misspelling' }, expected: ['VOCABULARY', 'WF'] },
  { name: 'everyday -> every day', rule: { id: 'EVERYDAY_EVERY_DAY', category: { id: 'CONFUSED_WORDS', name: 'Commonly Confused Words' }, issueType: 'misspelling' }, expected: ['VOCABULARY', 'WF'] },
  { name: 'there -> their', rule: { id: 'THERE_THEIR', category: { id: 'CONFUSED_WORDS', name: 'Commonly Confused Words' }, issueType: 'misspelling' }, expected: ['VOCABULARY', 'WC'] },
  { name: 'modal base form', rule: { id: 'MD_BASEFORM', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'VF'] },
  { name: 'plural subject agreement', rule: { id: 'NON3PRS_VERB', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'has/have agreement', rule: { id: 'HE_VERB_AGR', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'base form after plural subject', rule: { id: 'BASE_FORM', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'VF'] },
  { name: 'sentence-start agreement', rule: { id: 'AGREEMENT_SENT_START', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'it agreement', rule: { id: 'IT_VBZ', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'participle after have', rule: { id: 'HAVE_PART_AGREEMENT', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'VF'] },
  { name: 'many + singular noun', rule: { id: 'MANY_NN', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'every + plural noun', rule: { id: 'EACH_EVERY_NNS', category: { id: 'GRAMMAR', name: 'Grammar' }, issueType: 'grammar' }, expected: ['GRAMMAR', 'AGR'] },
  { name: 'linking-adverb comma', rule: { id: 'SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA', category: { id: 'PUNCTUATION', name: 'Punctuation' }, issueType: 'uncategorized' }, expected: ['MECHANICS', 'P'] }
];
