'use strict';
// Turning what a provider returns into spans on OUR canonical text. A provider without positions (Copyscape) gives matched text: it is located
// by its 5-word sequences. A provider with positions on its own copy of the text (Copyleaks' crawled version) is used directly when that copy
// is our text, and otherwise its passages are located the same way. Either way the result is word runs snapped to whole words.
const { tokenize } = require('./normalize');
const { shingleHashes, matchRuns } = require('./fingerprints');

const toSpans = (runs, tokens) => runs.map(run => ({ wordStart: run.wordStart, wordEnd: run.wordEnd,
  start: tokens[run.wordStart].start, end: tokens[run.wordEnd - 1].end }));

/** Spans of the canonical text matching any of the fragments (pieces joined by an ellipsis need no split: a sequence across the joint is not in the essay). */
function locateFragments(fragments, text, tokens, { minWords, blocked = null }) {
  const shared = new Set();
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    for (const hash of shingleHashes(tokenize(String(fragment || '')))) if (hash !== null) shared.add(hash);
  }
  if (!shared.size) return [];
  return toSpans(matchRuns(shingleHashes(tokens), shared, { minWords, blocked }), tokens);
}

/** Merges overlapping or touching word runs. */
function mergeRuns(runs) {
  const sorted = [...runs].sort((a, b) => a.wordStart - b.wordStart);
  const out = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    if (last && run.wordStart <= last.wordEnd) last.wordEnd = Math.max(last.wordEnd, run.wordEnd);
    else out.push({ ...run });
  }
  return out;
}

/**
 * foreignSpans: [{ start, length }] in characters on foreignText. Same text as ours: each span is snapped to the words it touches. A different
 * copy: the passages are cut from foreignText and located. Spans outside the text are ignored. Returns spans on the canonical text.
 */
function mapForeignSpans(foreignText, foreignSpans, text, tokens, { minWords, blocked = null }) {
  const valid = (Array.isArray(foreignSpans) ? foreignSpans : []).filter(s => Number.isInteger(s?.start) && Number.isInteger(s?.length)
    && s.start >= 0 && s.length > 0 && typeof foreignText === 'string' && s.start + s.length <= foreignText.length);
  if (!valid.length) return [];
  if (foreignText !== text) return locateFragments(valid.map(s => foreignText.slice(s.start, s.start + s.length)), text, tokens, { minWords, blocked });
  const runs = [];
  for (const s of valid) {
    const end = s.start + s.length;
    let a = -1;
    let b = -1;
    tokens.forEach((token, i) => { if (token.end > s.start && token.start < end) { if (a < 0) a = i; b = i + 1; } });
    if (a >= 0) runs.push({ wordStart: a, wordEnd: b });
  }
  const kept = [];
  for (const run of mergeRuns(runs)) {
    // blocked words split a run; each part must still reach the minimum
    let i = run.wordStart;
    while (i < run.wordEnd) {
      if (blocked?.[i]) { i++; continue; }
      let j = i;
      while (j < run.wordEnd && !blocked?.[j]) j++;
      if (j - i >= minWords) kept.push({ wordStart: i, wordEnd: j });
      i = j;
    }
  }
  return toSpans(kept, tokens);
}

module.exports = { locateFragments, mapForeignSpans, mergeRuns };
