const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');

const VERSION = 'canonical-1';

function legendIndex(legend = defaultLegend()) {
  const index = new Map();
  for (const group of legend.groups || []) for (const item of group.symbols || []) {
    index.set(item.symbol, { category: group.key, symbolLabel: item.label, color: group.color });
  }
  return index;
}

function locateQuote(text, quote, occurrence) {
  if (!text || !quote) return null;
  const starts = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) starts.push(at);
  if (Number.isInteger(occurrence) && occurrence >= 0 && starts[occurrence] != null)
    return { start: starts[occurrence], end: starts[occurrence] + quote.length };
  if (starts.length === 1) return { start: starts[0], end: starts[0] + quote.length };
  return null;
}

function mapOffsetsToWords(correction, spans) {
  const matches = (spans || []).filter((span) => correction.startChar < span.end && correction.endChar > span.start);
  if (!matches.length) return null;
  const fileIds = new Set(matches.map((span) => String(span.fileId || '')));
  if (fileIds.size !== 1) return null;
  return { fileId: matches[0].fileId || null, page: matches[0].page,
    wordIds: matches.map((span) => span.wordId), bboxList: matches.map((span) => span.bbox).filter(Boolean) };
}

function normalizeCorrection(raw, text, spans, legend, source) {
  const meta = legendIndex(legend).get(String(raw?.symbol || '').toUpperCase());
  if (!meta || meta.category !== raw?.category) return null;
  const quote = String(raw.quotedText || '');
  let range = Number.isFinite(raw.startChar) && Number.isFinite(raw.endChar)
    ? { start: raw.startChar, end: raw.endChar } : locateQuote(text, quote, raw.occurrence);
  if (!range || range.end <= range.start || text.slice(range.start, range.end) !== quote) return null;
  const mapped = mapOffsetsToWords({ startChar: range.start, endChar: range.end }, spans) ||
    { fileId: null, page: null, wordIds: [], bboxList: [] };
  const seed = [VERSION, source, raw.category, raw.symbol, range.start, range.end, quote].join('|');
  return { id: `${source.toLowerCase()}_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`,
    source, category: raw.category, groupKey: raw.category, groupLabel: raw.category,
    symbol: raw.symbol, symbolLabel: meta.symbolLabel, color: meta.color, quotedText: quote,
    message: String(raw.message || '').trim(), suggestedText: String(raw.suggestedText || '').trim(),
    startChar: range.start, endChar: range.end, ...mapped,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), editable: false };
}

function mergeCorrections(items) {
  const sorted = [...(items || [])].sort((a, b) => String(a.fileId).localeCompare(String(b.fileId)) || a.page - b.page || a.startChar - b.startChar || a.id.localeCompare(b.id));
  const result = [];
  for (const item of sorted) {
    const duplicate = result.find((old) => old.category === item.category && old.symbol === item.symbol && old.quotedText === item.quotedText
      && Math.max(old.startChar, item.startChar) < Math.min(old.endChar, item.endChar));
    if (!duplicate) result.push(item);
    else if (item.source === 'LANGUAGETOOL' && ['GRAMMAR', 'MECHANICS'].includes(item.category)) Object.assign(duplicate, item);
  }
  return result;
}

function statistics(items) {
  const out = { content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0 };
  for (const item of items || []) { const key = String(item.category || '').toLowerCase(); if (key in out && key !== 'total') out[key]++; }
  out.total = out.content + out.organization + out.grammar + out.vocabulary + out.mechanics;
  return out;
}

const computeCanonicalCorrectionStatistics = statistics;

module.exports = { VERSION, legendIndex, locateQuote, mapOffsetsToWords, normalizeCorrection, mergeCorrections, statistics, computeCanonicalCorrectionStatistics };
