'use strict';
// Handwriting spacing and capitals check (L2), pure engine: no network, no database, no logging.
// The accepted exact-source transcript is never rewritten. The model only reports, per numbered mark, whether a space is
// written before/after it, and per numbered word, whether the first letter is written as a capital. CAP and SPC candidates are
// then computed here and turned into ordinary MECHANICS findings that still go through the normal validation and merge.

const VERSION = 'handwriting-mechanics-v1';
const DETECTOR = VERSION;
const PROMPT_VERSION = 'handwriting-mechanics-prompt-v1';
const SCHEMA_VERSION = 'handwriting-mechanics-schema-v1';
const MARK_NAMES = Object.freeze({ ',': 'comma', '.': 'full stop', ';': 'semicolon', ':': 'colon', '?': 'question mark', '!': 'exclamation mark' });
const SENTENCE_END = new Set(['.', '?', '!']);
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]/gu;
const LONE_I = /^[Ii](?:['’][\p{L}]+)?$/u;
const DIGIT_END = /\p{N}$/u;
const DIGIT_START = /^\p{N}/u;
const MAX_MESSAGE = 240;

const PROMPT = `You check handwriting. The image is a crop of a student's handwritten page showing the numbered line or lines given below, top to bottom (cut-off parts of other lines may appear at the top or bottom edge; ignore them). You are given the text of those lines as already transcribed, with their words and punctuation marks numbered. Do not transcribe and do not correct anything. Judge only from the image.
1. marks: for each numbered punctuation mark, in the given order, report space_before, space_after and confidence (0 to 1). Compare the visible gap between the last letter of the word before and the mark with the normal gap between letters inside a word and with the normal gap between words. A gap clearly at least as wide as a normal word gap is space_before true; if the mark touches or nearly touches the letter, space_before is false. space_after is false when the next word starts right after the mark, true when a normal word gap follows or the mark ends the line. Judge every mark on its own; do not assume the student is consistent.
2. cases: for each numbered word, in the given order, report case_as_written for the FIRST LETTER of that word as written in the image: "capital", "small" or "unclear", and a confidence (0 to 1). Compare its height and shape with the small letters around it. Ignore where the word is in the sentence and whether it should be a capital. Do not decide whether anything is an error.
Return only JSON that matches the schema, with exactly one entry per numbered mark and per numbered word.`;

/** text -> tokens with absolute offsets. kind: word | mark (one of MARK_NAMES) | other. */
function tokenize(text, offset = 0) {
  const tokens = [];
  let previousEnd = 0;
  for (const match of String(text ?? '').matchAll(TOKEN)) {
    const value = match[0], start = match.index;
    tokens.push({ text: value, kind: /^[\p{L}\p{M}\p{N}]/u.test(value) ? 'word' : MARK_NAMES[value] ? 'mark' : 'other',
      start: offset + start, end: offset + start + value.length, spaceBefore: tokens.length > 0 && /\s/u.test(text.slice(previousEnd, start)) });
    previousEnd = start + value.length;
  }
  return tokens;
}

const letter = token => token?.kind === 'word' && token.text.length === 1;
const tightDot = token => token?.kind === 'mark' && token.text === '.' && !token.spaceBefore;
/** "i.e." / "e.g.": a dot written tight between single letters, or closing such a pair. */
function abbreviationDot(tokens, k) {
  if (!tightDot(tokens[k]) || !letter(tokens[k - 1])) return false;
  return (letter(tokens[k + 1]) && !tokens[k + 1].spaceBefore && tightDot(tokens[k + 2]))
    || (tightDot(tokens[k - 2]) && !tokens[k - 1].spaceBefore && letter(tokens[k - 3]));
}

/**
 * Over the whole transcript: starts = absolute offsets of words that start a sentence (first word, or first word after . ? !
 * that is not an abbreviation dot); abbreviations = offsets of single letters inside "i.e."-style abbreviations.
 */
function textContext(transcript) {
  const tokens = tokenize(transcript), starts = new Set(), abbreviations = new Set();
  let previous = null, previousIndex = -1;
  tokens.forEach((token, k) => {
    if (abbreviationDot(tokens, k)) abbreviations.add(tokens[k - 1].start);
    if (token.kind === 'word' && (!previous || (previous.kind === 'mark' && SENTENCE_END.has(previous.text)
      && !abbreviationDot(tokens, previousIndex)))) starts.add(token.start);
    if (token.kind !== 'other') { previous = token; previousIndex = k; }
  });
  return { starts, abbreviations };
}
const sentenceStarts = transcript => textContext(transcript).starts;

const validBox = box => box && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(box[key]))) && Number(box.w) > 0 && Number(box.h) > 0;

/**
 * One exact-source page -> its text lines with a pixel box from the stored token geometry (bbox {x, y, w, h} in percent of the
 * display image). page: { text, startChar, words, width, height }. A line without any boxed token gets box null (skipped later).
 * If any word on the line has no box, the line keeps the full page width so no word is cut off.
 */
function pageLines(page) {
  const text = String(page?.text ?? ''), base = Number(page?.startChar) || 0;
  const width = Number(page?.width), height = Number(page?.height);
  const words = (Array.isArray(page?.words) ? page.words : []).filter(w => Number.isInteger(w?.sourceStart) && Number.isInteger(w?.sourceEnd)
    && w.sourceEnd > w.sourceStart && w.sourceEnd <= text.length && text.slice(w.sourceStart, w.sourceEnd) === w.text);
  const lines = [];
  let cursor = 0;
  for (const lineText of text.split('\n')) {
    const start = cursor, end = cursor + lineText.length;
    cursor = end + 1;
    const tokens = tokenize(lineText, base + start);
    if (!tokens.some(t => t.kind !== 'other')) continue;
    const onLine = words.filter(w => w.sourceStart >= start && w.sourceEnd <= end);
    const boxed = onLine.filter(w => validBox(w.bbox));
    const line = { index: lines.length, text: lineText, startChar: base + start, endChar: base + end, tokens, box: null, reason: null };
    if (!(width > 0 && height > 0)) line.reason = 'PAGE_SIZE_MISSING';
    else if (!boxed.length) line.reason = 'NO_GEOMETRY';
    else {
      const px = boxed.map(w => ({ x0: Number(w.bbox.x) / 100 * width, y0: Number(w.bbox.y) / 100 * height,
        x1: (Number(w.bbox.x) + Number(w.bbox.w)) / 100 * width, y1: (Number(w.bbox.y) + Number(w.bbox.h)) / 100 * height }));
      const heights = px.map(b => b.y1 - b.y0).sort((a, b) => a - b);
      const covered = token => onLine.some(w => base + w.sourceStart <= token.start && base + w.sourceEnd >= token.end);
      const fullWidth = boxed.length < onLine.length || !tokens.filter(t => t.kind === 'word').every(covered);
      line.box = { x0: fullWidth ? 0 : Math.min(...px.map(b => b.x0)), x1: fullWidth ? width : Math.max(...px.map(b => b.x1)),
        y0: Math.min(...px.map(b => b.y0)), y1: Math.max(...px.map(b => b.y1)), wordHeight: heights[Math.floor(heights.length / 2)] };
    }
    lines.push(line);
  }
  return lines;
}

/** Consecutive boxed lines in groups of `perCrop` (default 1). Lines without a box are returned as skipped. */
function groupLines(lines, perCrop = 1) {
  const size = Math.max(1, Math.floor(Number(perCrop) || 1));
  const usable = lines.filter(l => l.box), skipped = lines.filter(l => !l.box);
  const groups = [];
  for (let i = 0; i < usable.length; i += size) groups.push(usable.slice(i, i + size));
  return { groups, skipped };
}

/** Pixel crop for a group: union of its line boxes, 35% of the word height above and below, 2% of the width at the sides. */
function cropBox(group, width, height) {
  const boxes = group.map(l => l.box);
  const wordHeight = Math.max(...boxes.map(b => b.wordHeight));
  const marginY = 0.35 * wordHeight, marginX = 0.02 * width;
  const left = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.x0)) - marginX));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.y0)) - marginY));
  const right = Math.min(width, Math.ceil(Math.max(...boxes.map(b => b.x1)) + marginX));
  const bottom = Math.min(height, Math.ceil(Math.max(...boxes.map(b => b.y1)) + marginY));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Numbered words and marks of a group, in reading order. A mark knows the token before and after it on the same line. */
function groupItems(group) {
  const words = [], marks = [];
  group.forEach((line, lineNo) => line.tokens.forEach((token, i) => {
    if (token.kind === 'word') words.push({ ...token, line: lineNo });
    else if (token.kind === 'mark') marks.push({ ...token, line: lineNo, before: line.tokens[i - 1] || null, after: line.tokens[i + 1] || null });
  }));
  return { words, marks };
}

function userMessage(group, items) {
  const lineLabel = item => `line ${item.line + 1}`;
  return [`Lines (top to bottom):`, ...group.map((line, i) => `${i + 1}: ${JSON.stringify(line.text)}`),
    `Words: ${items.words.map((w, i) => `${i + 1}. ${w.text} (${lineLabel(w)})`).join(' | ') || '(none)'}`,
    `Punctuation marks: ${items.marks.map((m, i) => `${i + 1}. "${m.text}" after "${m.before?.text ?? ''}" (${lineLabel(m)})`).join(' | ') || '(none)'}`]
    .join('\n');
}

const closed = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const exactly = (count, items) => ({ type: 'array', minItems: count, maxItems: count, items });
function responseSchema(items) {
  return closed({
    marks: exactly(items.marks.length, closed({ space_before: { type: 'boolean' }, space_after: { type: 'boolean' }, confidence: { type: 'number' } })),
    cases: exactly(items.words.length, closed({ case_as_written: { type: 'string', enum: ['capital', 'small', 'unclear'] }, confidence: { type: 'number' } }))
  });
}

const confidenceOk = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** Model reply -> { ok: true, marks, cases } or { ok: false, reason }. Any count or type mismatch discards the whole group. */
function parseReply(content, items) {
  let value;
  try { value = typeof content === 'string' ? JSON.parse(content) : content; } catch { return { ok: false, reason: 'REPLY_NOT_JSON' }; }
  if (!value || !Array.isArray(value.marks) || !Array.isArray(value.cases)) return { ok: false, reason: 'REPLY_SHAPE' };
  if (value.marks.length !== items.marks.length || value.cases.length !== items.words.length) return { ok: false, reason: 'REPLY_COUNT_MISMATCH' };
  if (!value.marks.every(m => m && typeof m.space_before === 'boolean' && typeof m.space_after === 'boolean' && confidenceOk(m.confidence))
    || !value.cases.every(c => c && ['capital', 'small', 'unclear'].includes(c.case_as_written) && confidenceOk(c.confidence))) {
    return { ok: false, reason: 'REPLY_SHAPE' };
  }
  return { ok: true, marks: value.marks, cases: value.cases };
}

const upperFirst = word => word.charAt(0).toLocaleUpperCase() + word.slice(1);
const lowerFirst = word => word.charAt(0).toLocaleLowerCase() + word.slice(1);
/**
 * Local CAP and SPC rules. context = textContext(transcript). Returns candidates; nothing below minConfidence is kept.
 * Decimals and times (3.5, 10:30, 1,000) and single-letter abbreviations (i.e., e.g.) are never spacing or capital findings.
 */
function candidates(items, reply, { starts, abbreviations = new Set(), minConfidence = 0.8 } = {}) {
  const found = [];
  items.marks.forEach((mark, i) => {
    const seen = reply.marks[i];
    if (!(seen.confidence >= minConfidence) || mark.before?.kind !== 'word') return;
    const nextWord = mark.after?.kind === 'word' ? mark.after : null;
    if ((DIGIT_END.test(mark.before.text) && nextWord && DIGIT_START.test(nextWord.text)) || abbreviations.has(mark.before.start)) return;
    const spaceBefore = seen.space_before === true, missingAfter = Boolean(nextWord) && seen.space_after === false;
    if (spaceBefore || missingAfter) found.push({ symbol: 'SPC', mark, wordBefore: mark.before, nextWord, spaceBefore, missingAfter, confidence: seen.confidence });
  });
  items.words.forEach((word, i) => {
    const seen = reply.cases[i];
    if (!(seen.confidence >= minConfidence) || abbreviations.has(word.start)) return;
    const start = starts.has(word.start), lower = /^\p{Ll}/u.test(word.text), upper = /^\p{Lu}/u.test(word.text);
    if (seen.case_as_written === 'capital' && lower && !start && !LONE_I.test(word.text)) found.push({ symbol: 'CAP', rule: 'capital_mid_sentence', word, confidence: seen.confidence });
    else if (seen.case_as_written === 'small' && start && (lower || upper)) found.push({ symbol: 'CAP', rule: 'small_sentence_start', word, confidence: seen.confidence });
    else if (seen.case_as_written === 'small' && LONE_I.test(word.text)) found.push({ symbol: 'CAP', rule: 'small_lone_i', word, confidence: seen.confidence });
  });
  return found;
}

function occurrenceAt(transcript, quote, start, locateQuote) {
  for (let occurrence = 0, at = transcript.indexOf(quote); at >= 0; occurrence += 1, at = transcript.indexOf(quote, at + 1)) {
    const range = locateQuote(transcript, quote, occurrence);
    if (range?.start === start && range.end === start + quote.length) return occurrence;
  }
  return null;
}

/**
 * Candidate -> finding in the normal correction shape, or { dropped: reason }. The quote is always the exact transcript span;
 * the message shows both what was written (from the image) and the fix, so an identical quote and fix is not confusing.
 */
function buildFinding(candidate, transcript, { locateQuote = require('../correctionCanonical.service').locateQuote } = {}) {
  let start, end, written, fix, message;
  if (candidate.symbol === 'SPC') {
    const { mark, wordBefore, nextWord, spaceBefore, missingAfter } = candidate;
    start = wordBefore.start;
    end = missingAfter ? nextWord.end : mark.end;
    written = `${wordBefore.text}${spaceBefore ? ' ' : ''}${mark.text}${missingAfter ? nextWord.text : ''}`;
    fix = `${wordBefore.text}${mark.text}${missingAfter ? ` ${nextWord.text}` : ''}`;
    message = missingAfter ? `You wrote "${written}". Write "${fix}".`
      : `You wrote "${written}". Write "${fix}" (no space before the ${MARK_NAMES[mark.text]}).`;
  } else {
    const { word, rule } = candidate;
    start = word.start;
    end = word.end;
    if (rule === 'capital_mid_sentence') {
      written = upperFirst(word.text); fix = lowerFirst(word.text);
      message = `You wrote "${written}" in the middle of a sentence. Use a small letter: "${fix}".`;
    } else {
      written = lowerFirst(word.text); fix = upperFirst(word.text);
      message = rule === 'small_sentence_start' ? `You wrote "${written}" at the start of a sentence. Use a capital letter: "${fix}".`
        : `You wrote "${written}". Use a capital letter: "${fix}".`;
    }
  }
  const quotedText = transcript.slice(start, end);
  if (!quotedText || /\n/u.test(quotedText)) return { dropped: 'QUOTE_NOT_ON_ONE_LINE' };
  if (message.length > MAX_MESSAGE) return { dropped: 'MESSAGE_TOO_LONG' };
  const occurrence = occurrenceAt(transcript, quotedText, start, locateQuote);
  if (occurrence === null) return { dropped: 'QUOTE_NOT_GROUNDED' };
  return { category: 'MECHANICS', symbol: candidate.symbol, quotedText, suggestedText: fix, message, occurrence,
    confidence: candidate.confidence, severity: 'low', correctionKind: 'localized', detector: DETECTOR, startChar: start, endChar: end };
}

module.exports = { VERSION, DETECTOR, PROMPT_VERSION, SCHEMA_VERSION, PROMPT, MARK_NAMES, tokenize, textContext, sentenceStarts, pageLines, groupLines,
  cropBox, groupItems, userMessage, responseSchema, parseReply, candidates, buildFinding };
