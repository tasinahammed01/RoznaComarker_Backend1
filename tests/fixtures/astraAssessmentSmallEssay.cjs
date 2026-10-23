'use strict';
// Shape-matched synthetic source; not a claimed transcription of the real essay.
const words = Array.from({ length: 127 }, (_, index) => {
  let word = index < 92 ? 'clear' : 'idea';
  if ([0, 43, 85].includes(index)) word = word[0].toUpperCase() + word.slice(1);
  return word + ([42, 84, 126].includes(index) ? '.' : '');
});
const text = words.map((word, index) => word + (index === 126 ? '' : (index + 1) % 7 === 0 ? '\n' : ' ')).join('');
module.exports = Object.freeze({ text, characterCount: 729, wordCount: 127, lineCount: 19,
  sentenceCount: 3, pageCount: 1, requestInputTokenEstimate: 3432 });
