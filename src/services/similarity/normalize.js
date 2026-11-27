'use strict';
// Words of an essay with their character offsets on the ORIGINAL text (the canonical transcript every highlight is drawn on). Each word is
// compared in a normalised form (NFKC, lower case, curly apostrophe as straight), so case, ligatures and punctuation never hide a match.
// The page separator of an exact transcript contains a form feed: words are numbered by page so a 5-word sequence never crosses pages.

const PAGE_BREAK = '\f';
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** [{ w, start, end, page }] in text order; [] for anything that is not a non-empty string. */
function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const tokens = [];
  let page = 0;
  let scanned = 0;
  for (const match of text.matchAll(WORD)) {
    for (let i = scanned; i < match.index; i++) if (text[i] === PAGE_BREAK) page++;
    scanned = match.index + match[0].length;
    tokens.push({ w: match[0].normalize('NFKC').toLowerCase().replace(/’/gu, "'"), start: match.index, end: scanned, page });
  }
  return tokens;
}

const QUOTE_PAIRS = Object.freeze([['“', '”'], ['"', '"'], ['„', '“'], ['«', '»']]);
/** One boolean per token: true when the word sits inside a closed pair of double quotes. An unclosed quote marks nothing. */
function quoteMask(text, tokens) {
  const mask = new Array(tokens.length).fill(false);
  if (typeof text !== 'string') return mask;
  const ranges = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    for (;;) {
      const a = text.indexOf(open, from);
      if (a < 0) break;
      const b = text.indexOf(close, a + 1);
      if (b < 0) break;
      ranges.push([a, b]);
      from = b + 1;
    }
  }
  tokens.forEach((token, i) => { mask[i] = ranges.some(([a, b]) => token.start > a && token.end <= b); });
  return mask;
}

module.exports = { tokenize, quoteMask, PAGE_BREAK };
