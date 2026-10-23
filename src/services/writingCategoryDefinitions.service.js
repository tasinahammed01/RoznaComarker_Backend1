'use strict';

const DEFINITIONS = Object.freeze({
  CONTENT: 'Task relevance, claims, development, and supporting detail.',
  ORGANIZATION: 'Logical progression/coherence (COH), cohesion/transitions (CO), paragraph unity (PU), topic-sentence function (TS), and adequate whole-response closure/conclusion (CONC).',
  VOCABULARY: 'Word choice/form, harmful repetition, register, and collocation.',
  GRAMMAR: 'Tense, verb form, agreement, clauses, word order, articles, and prepositions.',
  MECHANICS: 'Spelling, punctuation, capitalization, spacing, and provable formatting.'
});

const promptDefinitions = () => Object.entries(DEFINITIONS)
  .map(([category, definition]) => `${category}=${definition}`).join(' ');

module.exports = { DEFINITIONS, promptDefinitions };
