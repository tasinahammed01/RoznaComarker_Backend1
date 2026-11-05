'use strict';
// Second pass of the geometry alignment. The first pass binds only words that are unique on the whole page, so common words and misread words stay without a
// box. Here the reader's lines are first paired with the geometry provider's lines, in order. Inside a paired line the words are aligned in order, tolerating
// spelling differences, and a word between two aligned neighbours takes the one box left between them. A box always belongs to a word the provider really saw on
// that line: nothing is interpolated, no line is guessed, and a line that cannot be paired stays without boxes.
const MAX_WORD_LENGTH = 64;
/** Below this, two words are different words. "chan"/"change" passes, "the"/"they" passes, "see"/"sort" does not. */
const MIN_WORD_SIMILARITY = 0.5;
/** A pair of lines must agree on this share of the shorter line, and on at least this many words. */
const MIN_LINE_AGREEMENT = 0.5, MIN_LINE_ANCHORS = 2;
/** Between two aligned neighbours, at most this many words may be placed by position alone. */
const MAX_POSITIONAL_GAP = 3;

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
/** 1 for equal words, 0 for different ones. A word of one or two letters has to be equal: a single changed letter makes it another word. */
function similarity(a, b) {
  if (a === b) return a ? 1 : 0;
  const longest = Math.max(a.length, b.length);
  if (longest <= 2 || longest > MAX_WORD_LENGTH) return 0;
  const value = 1 - distance(a, b) / longest;
  return value >= MIN_WORD_SIMILARITY ? value : 0;
}
/** The order-preserving pairing of two word lists with the highest total similarity: [leftIndex, rightIndex, similarity]. */
function alignWords(left, right) {
  const best = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  const score = Array.from({ length: left.length }, (_, i) => right.map((_word, j) => similarity(left[i], right[j])));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], score[i][j] ? score[i][j] + best[i + 1][j + 1] : 0);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (score[i][j] && Math.abs(best[i][j] - (score[i][j] + best[i + 1][j + 1])) < 1e-9) { pairs.push([i, j, score[i][j]]); i++; j++; }
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}
/** The order-preserving pairing of reader lines and provider lines. Only lines that really agree can pair. */
function pairLines(readerLines, providerLines) {
  const agreement = readerLines.map(reader => providerLines.map(provider => {
    const pairs = alignWords(reader.map(item => item.key), provider.map(item => item.key));
    const shorter = Math.min(reader.length, provider.length);
    const value = pairs.reduce((sum, pair) => sum + pair[2], 0);
    // A very short line has no second word to agree on: one exact word is all it can offer, and only if it is the whole line.
    const enough = pairs.length >= Math.min(MIN_LINE_ANCHORS, shorter) && value / shorter >= MIN_LINE_AGREEMENT && (shorter >= MIN_LINE_ANCHORS || value === 1);
    return { pairs, value: enough ? value : 0 };
  }));
  const best = Array.from({ length: readerLines.length + 1 }, () => new Array(providerLines.length + 1).fill(0));
  for (let i = readerLines.length - 1; i >= 0; i--) for (let j = providerLines.length - 1; j >= 0; j--) {
    const here = agreement[i][j].value;
    best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], here ? here + best[i + 1][j + 1] : 0);
  }
  const paired = [];
  for (let i = 0, j = 0; i < readerLines.length && j < providerLines.length;) {
    const here = agreement[i][j].value;
    if (here && Math.abs(best[i][j] - (here + best[i + 1][j + 1])) < 1e-9) { paired.push({ reader: i, provider: j, pairs: agreement[i][j].pairs }); i++; j++; }
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  // The same words twice on a page (a question copied, then answered in its words): another line, still free for this pairing, agrees just as well. Which one
  // the reader meant cannot be known, so neither is used.
  return paired.filter(({ reader, provider }, index) => {
    const value = agreement[reader][provider].value;
    const fromProvider = index ? paired[index - 1].provider + 1 : 0, toProvider = index < paired.length - 1 ? paired[index + 1].provider : providerLines.length;
    const fromReader = index ? paired[index - 1].reader + 1 : 0, toReader = index < paired.length - 1 ? paired[index + 1].reader : readerLines.length;
    for (let j = fromProvider; j < toProvider; j++) if (j !== provider && agreement[reader][j].value >= value - 1e-9) return false;
    for (let i = fromReader; i < toReader; i++) if (i !== reader && agreement[i][provider].value >= value - 1e-9) return false;
    return true;
  });
}
/** Words left between two aligned neighbours (or a neighbour and the line's end), where both sides have the same number left: they pair by position. */
function positionalPairs(pairs, readerLength, providerLength) {
  if (pairs.length < MIN_LINE_ANCHORS) return [];
  const out = [];
  const stops = [[-1, -1], ...pairs, [readerLength, providerLength]];
  for (let n = 0; n < stops.length - 1; n++) {
    const [fromReader, fromProvider] = stops[n], [toReader, toProvider] = stops[n + 1];
    const count = toReader - fromReader - 1;
    if (count < 1 || count > MAX_POSITIONAL_GAP || count !== toProvider - fromProvider - 1) continue;
    for (let k = 1; k <= count; k++) out.push([fromReader + k, fromProvider + k]);
  }
  return out;
}
/**
 * Gives boxes to the tokens the first pass left without one. `key` is a word's normalized text. Tokens are changed in place; returns how many were bound.
 * A line whose first-pass words point at another provider line is left alone: the two passes disagree, so neither is trusted further there.
 */
function bindByLine(tokens, geometry, key) {
  const group = (items, lineOf) => {
    const lines = [], index = new Map();
    items.forEach((value, position) => {
      const line = lineOf(value, position);
      if (!index.has(line)) { index.set(line, lines.length); lines.push([]); }
      lines[index.get(line)].push({ value, key: key(value.text) });
    });
    return lines;
  };
  let tokenLine = 0;
  const lineOfToken = new Map(tokens.map((token, position) => { if (position && token.separatorBefore.includes('\n')) tokenLine++; return [token, tokenLine]; }));
  const readerLines = group(tokens, token => lineOfToken.get(token)), providerLines = group(geometry, word => word.line);
  const taken = new Set(tokens.map(token => token.geometryWordId).filter(Boolean));
  const lineOfProviderWord = new Map(geometry.map(word => [word.id, word.line]));
  let bound = 0;
  for (const { reader, provider, pairs } of pairLines(readerLines, providerLines)) {
    const readerWords = readerLines[reader], providerWords = providerLines[provider];
    const providerLine = providerWords[0].value.line;
    if (readerWords.some(({ value }) => value.geometryWordId && lineOfProviderWord.get(value.geometryWordId) !== providerLine)) continue;
    for (const [left, right] of [...pairs, ...positionalPairs(pairs, readerWords.length, providerWords.length)]) {
      const token = readerWords[left].value, word = providerWords[right].value;
      if (token.bbox || !word.bbox || (word.id && taken.has(word.id))) continue;
      token.bbox = word.bbox; token.geometryWordId = word.id || null;
      if (word.id) taken.add(word.id);
      bound++;
    }
  }
  return bound;
}

module.exports = { similarity, alignWords, pairLines, positionalPairs, bindByLine };
