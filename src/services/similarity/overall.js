'use strict';
// The percentages of a report, computed on the server from the stored sources and exclusions on every read (never stored, never taken from a
// provider). The overall percentage is the union of matched words over the sources that are not excluded, divided by the essay's words: a
// word found in several sources counts once. Each word is credited to the highest-ranked source containing it (ranked by how many of the
// essay's words it matches, ties by source number), so the source percentages add up to the overall (before rounding).

const percentOf = (words, total) => (total > 0 ? Math.round((words * 100) / total) : 0);
const sourceNumber = id => Number(String(id).replace(/\D/gu, '')) || 0;

/**
 * sources: [{ sourceId, spans: [{ wordStart, wordEnd }], excluded, compared }], tokens: the canonical text's words.
 * Returns { totalWords, matchedWords, overallPercent, sources: [{ sourceId, rank, words, ownWords, percent, excluded, compared }] (ranked
 * sources first, then the others by number), highlights: [{ start, end, sourceId }] }.
 */
function computeView(sources, tokens) {
  const totalWords = tokens.length;
  const list = (Array.isArray(sources) ? sources : []).map(source => {
    const own = new Set();
    for (const span of source.spans || []) {
      for (let i = Math.max(0, span.wordStart); i < Math.min(totalWords, span.wordEnd); i++) own.add(i);
    }
    return { source, own, counted: !source.excluded && source.compared !== false && own.size > 0 };
  });
  const ranked = list.filter(x => x.counted)
    .sort((a, b) => b.own.size - a.own.size || sourceNumber(a.source.sourceId) - sourceNumber(b.source.sourceId));
  const owner = new Array(totalWords).fill(null);
  const assigned = new Map();
  for (const x of ranked) {
    let count = 0;
    for (const i of x.own) if (owner[i] === null) { owner[i] = x.source.sourceId; count++; }
    assigned.set(x.source.sourceId, count);
  }
  const matchedWords = owner.filter(Boolean).length;
  const rankOf = new Map(ranked.map((x, i) => [x.source.sourceId, i + 1]));
  const rows = list.map(({ source, own, counted }) => ({
    sourceId: source.sourceId,
    rank: counted ? rankOf.get(source.sourceId) : null,
    words: counted ? assigned.get(source.sourceId) : 0,
    ownWords: own.size,
    percent: counted ? percentOf(assigned.get(source.sourceId), totalWords) : null,
    excluded: Boolean(source.excluded),
    compared: source.compared !== false
  })).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || sourceNumber(a.sourceId) - sourceNumber(b.sourceId));
  const highlights = [];
  for (let i = 0; i < totalWords; i++) {
    if (!owner[i]) continue;
    const last = highlights[highlights.length - 1];
    if (last && last.sourceId === owner[i] && last.lastWord === i - 1) { last.end = tokens[i].end; last.lastWord = i; continue; }
    highlights.push({ start: tokens[i].start, end: tokens[i].end, sourceId: owner[i], lastWord: i });
  }
  return { totalWords, matchedWords, overallPercent: percentOf(matchedWords, totalWords), sources: rows,
    highlights: highlights.map(({ start, end, sourceId }) => ({ start, end, sourceId })) };
}

module.exports = { computeView, percentOf };
