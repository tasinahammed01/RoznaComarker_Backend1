'use strict';

const DEFINITIONS = Object.freeze({
  CONTENT: 'Task relevance, claims, development, and supporting detail.',
  ORGANIZATION: 'Coherence, paragraph order, transitions, topic sentences, and conclusions.',
  VOCABULARY: 'Word choice/form, harmful repetition, register, and collocation.',
  GRAMMAR: 'Tense, verb form, agreement, clauses, word order, articles, and prepositions.',
  MECHANICS: 'Spelling, punctuation, capitalization, spacing, and provable formatting.'
});

const promptDefinitions = () => Object.entries(DEFINITIONS)
  .map(([category, definition]) => `${category}=${definition}`).join(' ');

module.exports = { DEFINITIONS, promptDefinitions };
