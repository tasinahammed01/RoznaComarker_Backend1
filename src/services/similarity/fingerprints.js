'use strict';
// 5-word sequence hashes, winnowing, and matched word runs. A shared run of W + K - 1 words (8) or more always shares at least one winnowed
// hash, so the winnowed set finds every candidate essay the 8-word minimum could report; the exact words are then marked with all hashes.

const K = 5;   // words per sequence
const W = 4;   // winnowing window, in sequences

/** FNV-1a, 32-bit unsigned. */
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** One hash per word position i for words i..i+K-1, or null when the sequence would run past the end or cross a page break. */
function shingleHashes(tokens) {
  const out = new Array(tokens.length).fill(null);
  for (let i = 0; i + K <= tokens.length; i++) {
    if (tokens[i].page !== tokens[i + K - 1].page) continue;
    out[i] = fnv1a(tokens.slice(i, i + K).map(t => t.w).join(' '));
  }
  return out;
}

/** The winnowed selection: the smallest hash of every window of W consecutive sequences (rightmost on ties), as unique values. */
function winnow(hashes) {
  const kept = new Set();
  let run = [];
  const flush = () => {
    if (run.length && run.length < W) kept.add(Math.min(...run));
    for (let i = 0; i + W <= run.length; i++) kept.add(Math.min(...run.slice(i, i + W)));
    run = [];
  };
  for (const hash of hashes) { if (hash === null) flush(); else run.push(hash); }
  flush();
  return [...kept];
}

/**
 * Word runs of the query that also occur in `shared` (a Set of hashes). Every word of a matching sequence is marked; blocked words (quotes,
 * the task brief) are then unmarked, and runs shorter than minWords are dropped. Returns [{ wordStart, wordEnd }] (end exclusive).
 */
function matchRuns(hashes, shared, { minWords, blocked = null }) {
  const marked = new Array(hashes.length).fill(false);
  hashes.forEach((hash, i) => {
    if (hash === null || !shared.has(hash)) return;
    for (let j = i; j < i + K && j < hashes.length; j++) marked[j] = true;
  });
  if (blocked) blocked.forEach((isBlocked, i) => { if (isBlocked && i < marked.length) marked[i] = false; });
  const runs = [];
  for (let i = 0; i < marked.length;) {
    if (!marked[i]) { i++; continue; }
    let j = i;
    while (j < marked.length && marked[j]) j++;
    if (j - i >= minWords) runs.push({ wordStart: i, wordEnd: j });
    i = j;
  }
  return runs;
}

module.exports = { K, W, fnv1a, shingleHashes, winnow, matchRuns };
