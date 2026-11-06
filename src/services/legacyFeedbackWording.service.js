'use strict';
// Results stored before Task 17 hold wording the product no longer uses. It is removed when a result is read, so old submissions show the same language as new
// ones and nothing stored changes. Only the fields that hold our own wording are touched: never a transcript, a quote or a teacher's text.
const FIELDS = new Set(['comment', 'title', 'explanation', 'reason']);
const REPLACEMENTS = [
  [/\s*This is a holistic observation, not a counted correction\./giu, ''],
  [/This category was assessed holistically( from the submitted writing)?\. No validated canonical \w+ corrections were recorded\./giu, 'This category was assessed from the submitted writing.'],
  [/^Holistic rubric feedback; no counted local correction\.\s*/iu, ''],
  [/^Grounded holistic rubric guidance, without a counted local correction\.$/iu, 'Based on the rubric review of this writing.'],
  [/\s*\(holistic\)/giu, ''],
  [/\bholistically\b/giu, 'overall'],
  [/\bholistic\b/giu, 'overall'],
];
function plainText(text) {
  if (!/holistic/iu.test(text)) return text;
  return REPLACEMENTS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
const NOT_WALKED = new Set(['writingCorrections', 'corrections', 'teacherComments', 'transcript', 'transcriptPages', 'transcriptWordSpans', 'ocrPages']);
/** A copy without the old wording. Values it does not recognise pass through unchanged. */
function withoutLegacyWording(value, key) {
  if (typeof value === 'string') return FIELDS.has(key) ? plainText(value) : value;
  if (Array.isArray(value)) return value.map(item => withoutLegacyWording(item, key));
  if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype || Buffer.isBuffer(value)) return value;
  if (typeof value.toJSON === 'function') return withoutLegacyWording(value.toJSON(), key);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, NOT_WALKED.has(name) ? item : withoutLegacyWording(item, name)]));
}
module.exports = { withoutLegacyWording, plainText };
