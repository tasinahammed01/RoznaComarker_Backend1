'use strict';
// Draft comparison v2: per-error tracking between two drafts (fixed / remaining / new / unclear), local and deterministic (no AI).
// Input: the two drafts' VISIBLE corrections (studentCorrectionView: teacher-hidden and removed ones excluded, teacher-added ones included)
// and their transcripts. Matching is position-tolerant: same category and symbol, and the same quote, or an overlapping quote, or a similar
// sentence at a similar place. Anything that cannot be decided reliably is "unclear" and is never counted as fixed.
// Items carry text only (category, symbol, quotes, suggestions, a template explanation): no ids, offsets or hashes.

const ITEM_CAP = 100;
const QUOTE_MAX = 200;
const SENTENCE_MAX = 300;
const SENTENCE_SIMILAR = 0.5;      // word-set similarity at which two sentences count as "the same sentence, maybe reworded"
const POSITION_WINDOW = 0.2;
const AMBIGUOUS_DISTANCE = 0.05; // two equally strong candidates closer than this to each other: undecidable       // relative position (0..1 in the essay) within which a reworded sentence may have moved

const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = value => new Set(norm(value).split(' ').filter(Boolean));
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / Math.max(x.size, y.size);
}
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const categoryOf = c => String(c?.canonicalCategory || c?.category || c?.groupKey || '').trim().toUpperCase();
const symbolOf = c => String(c?.symbol || c?.code || c?.type || '').trim().toUpperCase();
const LABELS = { CONTENT: 'content', ORGANIZATION: 'organization', GRAMMAR: 'grammar', VOCABULARY: 'vocabulary', MECHANICS: 'mechanics', PRESENTATION: 'presentation' };
const label = category => LABELS[category] || (category ? category.toLowerCase() : 'writing');

/** Sentences of a text with their character ranges. */
function sentences(text) {
  const out = [];
  const source = String(text || '');
  const pattern = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (!match[0].trim()) { if (pattern.lastIndex === match.index) pattern.lastIndex += 1; continue; }
    out.push({ start: match.index, end: match.index + match[0].length, text: match[0].trim() });
  }
  return out;
}

/** Where a correction sits in its transcript: its offset (verified against the quote) or the nearest occurrence of the quote. */
function locate(correction, text) {
  const quote = String(correction?.quotedText || '');
  const start = Number(correction?.startChar), end = Number(correction?.endChar);
  if (Number.isInteger(start) && Number.isInteger(end) && end > start && norm(text.slice(start, end)) === norm(quote)) return start;
  if (!quote.trim()) return Number.isInteger(start) ? start : null;
  let best = null, at = text.indexOf(quote);
  while (at >= 0) { if (best === null || Math.abs(at - (start || 0)) < Math.abs(best - (start || 0))) best = at; at = text.indexOf(quote, at + 1); }
  return best;
}

function prepare(list, text) {
  const all = sentences(text), length = Math.max(1, text.length);
  return (Array.isArray(list) ? list : []).map(c => {
    const at = locate(c, text);
    const sentence = at === null ? null : all.find(s => at >= s.start && at < s.end) || null;
    return { category: categoryOf(c), symbol: symbolOf(c), quote: String(c?.quotedText || ''), quoteKey: norm(c?.quotedText),
      suggestion: c?.suggestedText != null ? String(c.suggestedText) : '', at, position: at === null ? null : at / length, sentence };
  }).filter(c => c.category || c.symbol || c.quoteKey);
}

/** How well a current issue continues a previous one: 3 identical quote, 2 overlapping quote, 1 same sentence reworded nearby, 0 none. */
function strength(previous, current) {
  if (previous.category !== current.category || previous.symbol !== current.symbol) return 0;
  const near = previous.position === null || current.position === null || Math.abs(previous.position - current.position) <= POSITION_WINDOW;
  if (previous.quoteKey && previous.quoteKey === current.quoteKey && near) return 3;
  if (previous.quoteKey && current.quoteKey && near && similarity(previous.quote, current.quote) >= 0.5) return 2;
  if (previous.sentence && current.sentence && near && similarity(previous.sentence.text, current.sentence.text) >= SENTENCE_SIMILAR) return 1;
  return 0;
}

/** The sentence of the new draft that is most like the previous draft's sentence, near the same place. */
function counterpart(previous, currentSentences, currentLength) {
  if (!previous.sentence) return null;
  let best = null, bestScore = 0;
  for (const s of currentSentences) {
    if (previous.position !== null && Math.abs(s.start / currentLength - previous.position) > POSITION_WINDOW) continue;
    const score = similarity(previous.sentence.text, s.text);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return bestScore >= SENTENCE_SIMILAR ? best : null;
}

const EXPLAIN = {
  fixed: c => `This ${label(c)} issue no longer appears at this place in the new draft.`,
  remaining: c => `This ${label(c)} issue still appears in the new draft.`,
  remainingReworded: c => `The sentence was changed, but this ${label(c)} issue still appears in it.`,
  new: c => `This ${label(c)} issue appears in the new draft.`,
  unclearUnchanged: () => 'The text here did not change, but this issue was not marked again. We cannot tell whether it was fixed.',
  unclearRewritten: () => 'This part was rewritten or removed, so we cannot tell whether the issue was fixed.',
  unclearAmbiguous: () => 'Several similar issues are close together, so we cannot tell which one this became.',
};

/**
 * Compares two drafts' visible corrections. Returns counts and capped item lists per status.
 * { counts: { fixed, remaining, new, unclear }, lists: { fixed: { items, total, omitted }, … } }
 */
function trackIssues({ previousCorrections, currentCorrections, previousText, currentText }) {
  const prevText = String(previousText || ''), curText = String(currentText || '');
  const previous = prepare(previousCorrections, prevText), current = prepare(currentCorrections, curText);
  const currentSentences = sentences(curText), currentLength = Math.max(1, curText.length);
  const used = new Set(), result = { fixed: [], remaining: [], new: [], unclear: [] };

  // Strongest matches first, so an identical quote is never taken by a weaker reworded match.
  const pairs = [];
  previous.forEach((p, i) => current.forEach((c, j) => { const s = strength(p, c); if (s) pairs.push({ i, j, s, d: Math.abs((p.position ?? 0) - (c.position ?? 0)) }); }));
  pairs.sort((a, b) => b.s - a.s || a.d - b.d);
  const matched = new Map();
  const ambiguous = new Set();
  for (const pair of pairs) {
    if (matched.has(pair.i) || used.has(pair.j)) continue;
    // A weak (sentence-level) match with a rival of equal strength at nearly the same distance (within 5% of the essay) cannot be decided.
    if (pair.s === 1 && pairs.some(o => o !== pair && o.i === pair.i && o.s === 1 && !used.has(o.j) && Math.abs(o.d - pair.d) < AMBIGUOUS_DISTANCE)) { ambiguous.add(pair.i); continue; }
    matched.set(pair.i, pair); used.add(pair.j);
  }

  previous.forEach((p, i) => {
    const base = { category: p.category, symbol: p.symbol, originalText: clip(p.quote, QUOTE_MAX), previousSuggestion: clip(p.suggestion, QUOTE_MAX) || null };
    const pair = matched.get(i);
    if (pair) {
      const c = current[pair.j];
      const revised = c.sentence ? clip(c.sentence.text, SENTENCE_MAX) : clip(c.quote, QUOTE_MAX);
      result.remaining.push({ ...base, status: 'remaining', revisedText: revised || null, explanation: (pair.s === 3 ? EXPLAIN.remaining : EXPLAIN.remainingReworded)(p.category) });
      return;
    }
    if (ambiguous.has(i)) { result.unclear.push({ ...base, status: 'unclear', revisedText: null, explanation: EXPLAIN.unclearAmbiguous() }); return; }
    const place = counterpart(p, currentSentences, currentLength);
    if (!place) { result.unclear.push({ ...base, status: 'unclear', revisedText: null, explanation: EXPLAIN.unclearRewritten() }); return; }
    // The flagged words are still there, unchanged: the checker did not mark them again, which is not proof of a fix.
    if (p.quoteKey && ` ${norm(place.text)} `.includes(` ${p.quoteKey} `)) {
      result.unclear.push({ ...base, status: 'unclear', revisedText: clip(place.text, SENTENCE_MAX), explanation: EXPLAIN.unclearUnchanged() });
      return;
    }
    result.fixed.push({ ...base, status: 'fixed', revisedText: clip(place.text, SENTENCE_MAX), explanation: EXPLAIN.fixed(p.category) });
  });
  current.forEach((c, j) => {
    if (used.has(j)) return;
    result.new.push({ category: c.category, symbol: c.symbol, originalText: clip(c.quote, QUOTE_MAX), previousSuggestion: null, status: 'new',
      revisedText: null, suggestion: clip(c.suggestion, QUOTE_MAX) || null, explanation: EXPLAIN.new(c.category) });
  });

  const lists = {}, counts = {};
  for (const [status, items] of Object.entries(result)) {
    counts[status] = items.length;
    lists[status] = { items: items.slice(0, ITEM_CAP), total: items.length, omitted: Math.max(0, items.length - ITEM_CAP) };
  }
  return { counts, lists };
}

module.exports = { trackIssues, sentences, similarity, ITEM_CAP };
