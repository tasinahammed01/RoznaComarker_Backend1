'use strict';

module.exports = [
  ['CONTENT', '#FFD6A5', 'REL', 'Relevance', 'The idea is not related to the topic or task.', 2],
  ['CONTENT', '#FFD6A5', 'DEV', 'Idea Development', 'The point is too general or lacks details or examples.', 1],
  ['CONTENT', '#FFD6A5', 'TA', 'Task Achievement', 'The response does not fully answer the prompt or question.', 2],
  ['CONTENT', '#FFD6A5', 'CL', 'Clarity of Ideas', 'The message is unclear or confusing.', 1],
  ['CONTENT', '#FFD6A5', 'SD', 'Supporting Details', 'Examples or explanations are missing to support the main idea.', 1],
  ['ORGANIZATION', '#CDE7F0', 'COH', 'Coherence', 'Ideas are not logically connected.', 1],
  ['ORGANIZATION', '#CDE7F0', 'CO', 'Cohesion', 'Linking words or transitions are missing or misused.', 1],
  ['ORGANIZATION', '#CDE7F0', 'PU', 'Paragraph Unity', 'The paragraph contains unrelated ideas.', 1],
  ['ORGANIZATION', '#CDE7F0', 'TS', 'Topic Sentence', 'The topic sentence is missing or unclear.', 1],
  ['ORGANIZATION', '#CDE7F0', 'CONC', 'Conclusion', 'The conclusion is weak or missing.', 1],
  ['GRAMMAR', '#B7E4C7', 'T', 'Tense', 'Incorrect verb tense.', 0.5],
  ['GRAMMAR', '#B7E4C7', 'VF', 'Verb Form', 'Incorrect verb form.', 0.5],
  ['GRAMMAR', '#B7E4C7', 'AGR', 'Subject–Verb Agreement', 'The verb does not agree with the subject.', 0.5],
  ['GRAMMAR', '#B7E4C7', 'FRAG', 'Sentence Fragment', 'Incomplete sentence missing a subject or verb.', 1],
  ['GRAMMAR', '#B7E4C7', 'RO', 'Run-on Sentence', 'Two or more sentences are joined incorrectly.', 1],
  ['GRAMMAR', '#B7E4C7', 'WO', 'Word Order', 'The order of words in the sentence is incorrect.', 0.5],
  ['GRAMMAR', '#B7E4C7', 'ART', 'Article Use', 'Missing or incorrect article (a, an, the).', 0.5],
  ['GRAMMAR', '#B7E4C7', 'PREP', 'Preposition', 'Incorrect or missing preposition.', 0.5],
  ['VOCABULARY', '#E4C1F9', 'WC', 'Word Choice', 'A more suitable word could be used.', 0.5],
  ['VOCABULARY', '#E4C1F9', 'WF', 'Word Form', 'Incorrect form of the word.', 0.5],
  ['VOCABULARY', '#E4C1F9', 'REP', 'Repetition', 'The same word or phrase is repeated too often.', 0.5],
  ['VOCABULARY', '#E4C1F9', 'FORM', 'Formal / Inappropriate Word', 'The word is too informal or not suitable for academic context.', 1],
  ['VOCABULARY', '#E4C1F9', 'COL', 'Collocation', 'Words do not naturally go together.', 0.5],
  ['MECHANICS', '#FFF3BF', 'SP', 'Spelling', 'The word is spelled incorrectly.', 0.5],
  ['MECHANICS', '#FFF3BF', 'P', 'Punctuation', 'Punctuation mark is missing, extra, or incorrect.', 0.5],
  ['MECHANICS', '#FFF3BF', 'CAP', 'Capitalization', 'Incorrect use of capital or lowercase letters.', 0.25],
  ['MECHANICS', '#FFF3BF', 'SPC', 'Spacing', 'Missing or extra space between words or sentences.', 0.25],
  ['MECHANICS', '#FFF3BF', 'FMT', 'Formatting', 'Inconsistent formatting, alignment, or spacing.', 0.25]
].map(([category, color, symbol, label, description, defaultDeduction]) => ({
  category, symbol, label, description, color, defaultDeduction
}));
