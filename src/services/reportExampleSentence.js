'use strict';

// Teacher report only: the student's sentence around a "Common mistakes" example, cut at request time from the same stored transcript the
// highlights use (canonical transcript; exact-source pages included). Pure. Nothing here is stored or logged; a position that no longer
// points at the quoted words gives no sentence, and the example keeps its word pair.

const SENTENCE_MAX = 240;
const CONTEXT_MIN = 20;
const CONTROL = /[\u0000-\u001F\u007F]/gu;
// A sentence ends after ., ! or ? (with closing quotes or brackets) followed by space, or at a line break (pages are joined by line breaks).
const BOUNDARY = /[.!?]["'’”)\]]*(?=\s)|\n/gu;
const squash = value => String(value ?? '').replace(CONTROL, ' ').replace(/\s+/gu, ' ');
const norm = value => squash(value).trim();

/** Whether a correction's stored span still points at its quoted words in this transcript. */
function located(text, correction) {
  const start = correction?.startChar, end = correction?.endChar;
  return typeof text === 'string' && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length
    && norm(correction.quotedText) !== '' && norm(text.slice(start, end)) === norm(correction.quotedText);
}

/** { start, end } of the sentence holding [start, end), surrounding spaces trimmed. */
function sentenceSpan(text, start, end) {
  let from = 0, to = text.length;
  for (const match of text.matchAll(BOUNDARY)) {
    const stop = match.index + match[0].length;
    if (stop <= start) { from = stop; continue; }
    if (match.index >= start && stop >= end) { to = match[0] === '\n' ? match.index : stop; break; }
  }
  while (from < to && /\s/u.test(text[from])) from += 1;
  while (to > from && /\s/u.test(text[to - 1])) to -= 1;
  return { start: from, end: to };
}

/** Windows of the sentence to show: the whole sentence when short, else a window around each mistake, merged, cut at word edges. */
function windowsOf(text, span, marks) {
  if (span.end - span.start <= SENTENCE_MAX) return [[span.start, span.end]];
  const marked = marks.reduce((sum, m) => sum + (m.endChar - m.startChar), 0);
  const radius = Math.max(CONTEXT_MIN, Math.floor((SENTENCE_MAX - marked - 6 * marks.length) / (2 * marks.length)));
  const raw = marks.map(m => [Math.max(span.start, m.startChar - radius), Math.min(span.end, m.endChar + radius), m]);
  const merged = [];
  for (const [from, to, m] of raw) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) { last[1] = Math.max(last[1], to); last[3] = m; } else merged.push([from, to, m, m]);
  }
  return merged.map(([from, to, first, last]) => {
    // Cut at word edges, never into a mistake.
    let a = from, b = to;
    if (a > span.start) { const space = text.indexOf(' ', a); a = space >= 0 && space < first.startChar ? space + 1 : first.startChar; }
    if (b < span.end) { const space = text.lastIndexOf(' ', b); b = space > last.endChar ? space : last.endChar; }
    return [a, b];
  });
}

/**
 * The sentence holding the given mistakes (corrections of one submission with startChar, endChar, quotedText, suggestedText), as parts:
 * plain { text }, a mistake { text, error: true, corrected }, or { gap: true } between two windows of a long sentence. { parts, cutStart,
 * cutEnd }, or null when no mistake can be placed or the mistakes do not share one sentence.
 */
function sentenceOf(text, corrections) {
  if (typeof text !== 'string' || !text) return null;
  const marks = (corrections || []).filter(c => located(text, c)).sort((a, b) => a.startChar - b.startChar)
    .filter((m, i, all) => i === 0 || m.startChar >= all[i - 1].endChar);
  if (!marks.length) return null;
  const span = sentenceSpan(text, marks[0].startChar, marks[0].endChar);
  if (marks.some(m => m.startChar < span.start || m.endChar > span.end)) return null;
  if (marks.reduce((sum, m) => sum + (m.endChar - m.startChar), 0) > SENTENCE_MAX) return null;
  const windows = windowsOf(text, span, marks);
  const parts = [];
  windows.forEach(([from, to], index) => {
    if (index > 0) parts.push({ gap: true });
    let at = from;
    for (const m of marks.filter(x => x.startChar >= from && x.endChar <= to)) {
      if (m.startChar > at) parts.push({ text: squash(text.slice(at, m.startChar)) });
      parts.push({ text: norm(text.slice(m.startChar, m.endChar)), error: true, corrected: norm(m.suggestedText) });
      at = m.endChar;
    }
    if (to > at) parts.push({ text: squash(text.slice(at, to)) });
  });
  return { parts: parts.filter(p => p.gap || p.text !== ''), cutStart: windows[0][0] > span.start, cutEnd: windows[windows.length - 1][1] < span.end };
}

module.exports = { SENTENCE_MAX, located, sentenceSpan, sentenceOf };
