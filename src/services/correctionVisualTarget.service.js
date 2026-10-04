'use strict';

// Optional visualization metadata. Evidence, identity, scoring and wording stay canonical.
const lexical = (text) => [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)]
  .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
const punctuation = (text) => text.replace(/\s/gu, '');
// Ampersands and apostrophes may change lexical meaning, so do not infer them.
const isPunctuation = (text) => /^[.,;:!?()\[\]{}"“”«»\s]*$/u.test(text);

function validateVisualTarget(target, evidenceIds) {
  if (!target || target.version !== 1 || !Array.isArray(target.wordIds) || !Array.isArray(target.anchors)) return undefined;
  const allowed = new Set(evidenceIds);
  if (target.wordIds.length + target.anchors.length === 0 || target.wordIds.length + target.anchors.length > 128) return undefined;
  if (target.wordIds.some((id) => typeof id !== 'string' || !allowed.has(id))) return undefined;
  if (target.anchors.some((a) => !a || !allowed.has(a.wordId) || !['before', 'after'].includes(a.side)
    || !['INSERT', 'DELETE', 'REPLACE'].includes(a.operation))) return undefined;
  return { version: 1, wordIds: [...new Set(target.wordIds)], anchors: target.anchors.map((a) => ({
    wordId: a.wordId, side: a.side, operation: a.operation,
    ...(typeof a.punctuation === 'string' && a.punctuation.length <= 16 ? { punctuation: a.punctuation } : {})
  })) };
}

function deriveVisualTarget(correction, spans = []) {
  const source = String(correction.quotedText || ''), suggestion = String(correction.suggestedText || '');
  if (!source || !suggestion || source === suggestion || source.length > 500 || suggestion.length > 1000
    || ['CONTENT', 'ORGANIZATION'].includes(correction.category)) return undefined;
  const base = correction.startChar;
  if (!Number.isInteger(base) || correction.endChar !== base + source.length) return undefined;
  const evidence = spans.filter((s) => base < s.end && correction.endChar > s.start);
  if (!evidence.length || new Set(evidence.map((s) => `${s.fileId}:${s.page}`)).size !== 1) return undefined;
  const idsAt = (start, end) => evidence.filter((s) => base + start < s.end && base + end > s.start).map((s) => s.wordId);
  const anchorAt = (at, operation, mark) => {
    // Never pretend an insertion inside an OCR token is a word boundary.
    if (evidence.some((s) => s.start < base + at && s.end > base + at)) return null;
    const left = evidence.filter((s) => s.end <= base + at).at(-1);
    const right = evidence.find((s) => s.start >= base + at);
    return left ? { wordId: left.wordId, side: 'after', operation, punctuation: mark }
      : right ? { wordId: right.wordId, side: 'before', operation, punctuation: mark } : null;
  };
  const result = { version: 1, wordIds: [], anchors: [] };
  if (correction.symbol === 'SP' && evidence.length === 1)
    return { ...result, wordIds: [evidence[0].wordId] };
  if (correction.symbol === 'P') {
    const a = lexical(source), b = lexical(suggestion);
    if (!a.length || a.length !== b.length || a.some((word, i) => word.text !== b[i].text)) return undefined;
    for (let i = 0; i <= a.length; i++) {
      const start = i ? a[i - 1].end : 0, end = i < a.length ? a[i].start : source.length;
      const from = source.slice(start, end), to = suggestion.slice(i ? b[i - 1].end : 0, i < b.length ? b[i].start : suggestion.length);
      if (punctuation(from) === punctuation(to)) continue;
      if (!isPunctuation(from) || !isPunctuation(to)) return undefined;
      const operation = !punctuation(from) ? 'INSERT' : !punctuation(to) ? 'DELETE' : 'REPLACE';
      if (operation !== 'INSERT') {
        const first = start + from.search(/\S/u), last = start + from.trimEnd().length;
        result.wordIds.push(...idsAt(first, last));
      } else {
        const anchor = anchorAt(i ? a[i - 1].end : a[0].start, operation, punctuation(to));
        if (!anchor) return undefined;
        result.anchors.push(anchor);
      }
    }
  } else {
    // One uniquely positioned contiguous edit. Multiple disjoint rewrites stay legacy.
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(source.length, suggestion.length) && source[prefix] === suggestion[prefix]) prefix++;
    while (suffix < Math.min(source.length, suggestion.length) - prefix
      && source[source.length - 1 - suffix] === suggestion[suggestion.length - 1 - suffix]) suffix++;
    const removed = source.slice(prefix, source.length - suffix), added = suggestion.slice(prefix, suggestion.length - suffix);
    const positions = [];
    for (let i = 0; i <= source.length - removed.length; i++) {
      if (source.slice(0, i) + added + source.slice(i + removed.length) === suggestion) positions.push(i);
    }
    if (positions.length !== 1) return undefined;
    if (removed) {
      result.wordIds = idsAt(prefix, source.length - suffix);
      if (result.wordIds.length > 3) return undefined;
    } else if (/^[\p{L}\p{M}\p{N}]+$/u.test(added)) {
      // Inflections/prefixes change a lexical token, not an inter-word boundary.
      result.wordIds = idsAt(Math.max(0, prefix - 1), Math.min(source.length, prefix + 1));
      if (result.wordIds.length !== 1) return undefined;
    } else {
      if (!/\s/u.test(added)) return undefined;
      const anchor = anchorAt(prefix, 'INSERT', '');
      if (!anchor) return undefined;
      result.anchors.push(anchor);
    }
  }
  return validateVisualTarget(result, evidence.map((s) => s.wordId));
}

module.exports = { deriveVisualTarget, validateVisualTarget };
