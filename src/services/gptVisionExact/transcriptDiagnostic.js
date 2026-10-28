'use strict';

// Metadata only, called after the closed segment schema has been validated.
// Only matchActiveLines proves separator equivalence. Other difference labels
// are diagnostic classifications, never permission to change source characters.
const TYPES = ['EXACT', 'SEPARATOR_ONLY', 'CRLF_VS_LF', 'EXTRA_FINAL_NEWLINE', 'MISSING_FINAL_NEWLINE',
  'NON_ACTIVE_TEXT_INCLUDED', 'SEGMENT_SEPARATOR', 'LINE_SEPARATOR',
  'WHITESPACE', 'PUNCTUATION', 'CASE', 'CONTENT_OR_ORDER'];
function matchActiveLines(supplied, lines) {
  const mismatch = {transcriptComparison: 'MISMATCH', transcriptReconciled: false, transcriptReconciledBoundaries: 0};
  if (typeof supplied !== 'string' || !Array.isArray(lines) || lines.length > 300) return mismatch;
  let cursor = 0, lf = 0, crlf = 0, space = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || !line.length || !supplied.startsWith(line, cursor)) return mismatch;
    cursor += line.length;
    if (i === lines.length - 1) continue;
    // Disjoint prefixes: no searching/backtracking, trimming or internal edits.
    if (supplied.startsWith('\r\n', cursor)) {cursor += 2; crlf++;}
    else if (supplied[cursor] === '\n') {cursor++; lf++;}
    else if (supplied[cursor] === ' ') {cursor++; space++;}
    else return mismatch;
  }
  if (cursor !== supplied.length) return mismatch;
  return {transcriptComparison: crlf + space ? 'SEPARATOR_ONLY' : 'EXACT', transcriptReconciled: crlf + space > 0,
    transcriptReconciledBoundaries: crlf + space, transcriptSeparatorLFCount: lf,
    transcriptSeparatorCRLFCount: crlf, transcriptSeparatorSpaceCount: space};
}
function characterKind(text, index) {
  if (index >= text.length) return 'END';
  const char = String.fromCodePoint(text.codePointAt(index));
  if (char === '\r') return 'CR';
  if (char === '\n') return 'LF';
  if (char === ' ') return 'SPACE';
  if (/\s/u.test(char)) return 'OTHER_WHITESPACE';
  if (/\p{P}/u.test(char)) return 'PUNCTUATION';
  return 'CONTENT';
}
function compare(v, derived) {
  const supplied = v.activeTranscript;
  let index = 0;
  while (index < supplied.length && index < derived.length && supplied[index] === derived[index]) index++;
  const activeLines = v.physicalLines.map((line, lineIndex) => ({lineIndex,
    segments: line.segments.map((s, segmentIndex) => ({...s, segmentIndex})).filter(s => s.classification === 'STUDENT_ACTIVE_TEXT')
  })).filter(line => line.segments.length);
  const comparison = matchActiveLines(supplied, activeLines.map(line => line.segments.map(s => s.text).join('')));
  let difference = 'CONTENT_OR_ORDER';
  if (supplied === derived) difference = 'EXACT';
  else if (supplied.replace(/\r\n/g, '\n') === derived) difference = 'CRLF_VS_LF';
  else if (supplied === derived + '\n') difference = 'EXTRA_FINAL_NEWLINE';
  else if (supplied + '\n' === derived) difference = 'MISSING_FINAL_NEWLINE';
  else if (v.physicalLines.map(line => line.segments.map(s => s.text || '').join('')).filter(Boolean).join('\n') === supplied)
    difference = 'NON_ACTIVE_TEXT_INCLUDED';
  else if (activeLines.map(line => line.segments.map(s => s.text).join(' ')).join('\n') === supplied)
    difference = 'SEGMENT_SEPARATOR';
  else if (activeLines.map(line => line.segments.map(s => s.text).join('')).join(' ') === supplied)
    difference = 'LINE_SEPARATOR';
  else if (comparison.transcriptComparison === 'SEPARATOR_ONLY') difference = 'SEPARATOR_ONLY';
  else {
    // Remove only the exact common suffix for diagnosis. A missing letter can
    // expose a space at the first mismatch; that is not a whitespace-only error.
    let aEnd = supplied.length, bEnd = derived.length;
    while (aEnd > index && bEnd > index && supplied[aEnd - 1] === derived[bEnd - 1]) {aEnd--; bEnd--;}
    const a = supplied.slice(index, aEnd), b = derived.slice(index, bEnd);
    if (/^\s*$/u.test(a) && /^\s*$/u.test(b)) difference = 'WHITESPACE';
    else if (/^\p{P}*$/u.test(a) && /^\p{P}*$/u.test(b)) difference = 'PUNCTUATION';
    else if (a.toLowerCase() === b.toLowerCase()) difference = 'CASE';
  }
  let cursor = 0, physicalLine = -1, segment = -1;
  for (const line of activeLines) {
    for (const s of line.segments) {
      if (index >= cursor && index < cursor + s.text.length) {physicalLine = line.lineIndex; segment = s.segmentIndex;}
      cursor += s.text.length;
    }
    cursor++;
  }
  return {transcriptModelLength: supplied.length, transcriptDerivedLength: derived.length,
    transcriptFirstDifference: index, transcriptModelLine: supplied.slice(0, index).split('\n').length,
    transcriptDerivedLine: derived.slice(0, index).split('\n').length,
    transcriptPhysicalLineIndex: physicalLine, transcriptSegmentIndex: segment,
    transcriptModelCharacterKind: characterKind(supplied, index), transcriptDerivedCharacterKind: characterKind(derived, index),
    transcriptDifferenceType: difference, ...comparison};
}
module.exports = {compare, matchActiveLines, TYPES, CHARACTER_KINDS: ['END', 'CR', 'LF', 'SPACE', 'OTHER_WHITESPACE', 'PUNCTUATION', 'CONTENT']};
