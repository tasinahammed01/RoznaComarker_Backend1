const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');

const VERSION = 'canonical-6-category-structured';
const DEDUCTION_POLICY_VERSION = 'legend-diminishing-v1';
const REPETITION_FACTORS = Object.freeze([1, 0.75, 0.55]);

function legendIndex(legend = defaultLegend()) {
  const index = new Map();
  for (const group of legend.groups || []) for (const item of group.symbols || []) {
    index.set(item.symbol, { category: group.key, groupLabel: group.label, symbolLabel: item.label,
      legendDescription: item.description, color: group.color, defaultDeduction: Number(item.defaultDeduction) });
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
  const confidences = matches.map((span) => Number(span.ocrConfidence)).filter(Number.isFinite);
  return { fileId: matches[0].fileId || null, page: matches[0].page,
    wordIds: matches.map((span) => span.wordId), bboxList: matches.map((span) => span.bbox).filter(Boolean),
    ocrConfidence: confidences.length ? Math.min(...confidences) : null,
    ocrLayoutSuspicious: matches.some((span) => span.ocrLayoutSuspicious === true) };
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
  const mechanicsOcrSuspect = raw.category === 'MECHANICS'
    && ['SP', 'CAP', 'P'].includes(String(raw.symbol || '').toUpperCase())
    && (mapped.ocrLayoutSuspicious === true || (mapped.ocrConfidence != null && mapped.ocrConfidence < 0.7));
  return { id: `${source.toLowerCase()}_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`,
    source, category: raw.category, groupKey: raw.category, groupLabel: meta.groupLabel,
    symbol: raw.symbol, symbolLabel: meta.symbolLabel, legendDescription: meta.legendDescription,
    color: meta.color, quotedText: quote,
    message: String(raw.message || '').trim(), suggestedText: String(raw.suggestedText || '').trim(),
    startChar: range.start, endChar: range.end, ...mapped,
    ...(raw.category === 'MECHANICS' && ['SP', 'CAP', 'P'].includes(String(raw.symbol || '').toUpperCase()) ? {
      ocrSuspect: mechanicsOcrSuspect,
      ocrSuspectReasons: [mapped.ocrLayoutSuspicious ? 'STRUCTURALLY_SUSPICIOUS_LAYOUT' : null,
        mapped.ocrConfidence != null && mapped.ocrConfidence < 0.7 ? 'LOW_OCR_CONFIDENCE' : null].filter(Boolean)
    } : {}),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    defaultDeduction: meta.defaultDeduction, repetitionFactor: 1,
    appliedDeduction: meta.defaultDeduction, deductionPolicyVersion: DEDUCTION_POLICY_VERSION,
    ...(raw.correctionKind ? { correctionKind: raw.correctionKind } : {}),
    ...(source === 'AI' && raw.severity ? { severity: String(raw.severity).toLowerCase() } : {}),
    editable: false };
}

const normalizedText = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const correctedText = (item) => normalizedText(item?.suggestedText || item?.quotedText);
const canonicalSort = (a, b) => String(a.fileId || '').localeCompare(String(b.fileId || ''))
  || Number(a.page || 0) - Number(b.page || 0) || Number(a.startChar) - Number(b.startChar)
  || Number(a.endChar) - Number(b.endChar) || String(a.category).localeCompare(String(b.category))
  || String(a.symbol).localeCompare(String(b.symbol)) || String(a.id).localeCompare(String(b.id));

function sameLocation(a, b) {
  return String(a.fileId || '') === String(b.fileId || '') && Number(a.page || 0) === Number(b.page || 0);
}

function equivalentCorrection(a, b) {
  return a.category === b.category && a.symbol === b.symbol && correctedText(a) === correctedText(b);
}

function substantiallyOverlaps(a, b) {
  const overlap = Math.min(a.endChar, b.endChar) - Math.max(a.startChar, b.startChar);
  if (overlap <= 0) return false;
  const shorter = Math.min(a.endChar - a.startChar, b.endChar - b.startChar);
  return shorter > 0 && overlap / shorter >= 0.8;
}

function preferredCorrection(a, b) {
  // In AI-only pipeline, prefer higher confidence
  return Number(b.confidence || 0) > Number(a.confidence || 0) ? b : a;
}

function contextualGrammarOverride(a, b) {
  // No longer needed in AI-only pipeline - kept for backward compatibility
  return null;
}

function mergeCanonicalCorrections({ languageToolCorrections = [], aiCorrections = [] } = {}) {
  const sorted = [...aiCorrections].filter(Boolean).sort(canonicalSort);
  const result = [];
  const diagnostics = { exactDuplicates: 0, overlapDuplicates: 0, conflicts: 0, contextualOverrides: 0, rejectedIds: [] };
  const exact = new Map();
  const spanSymbols = new Map();
  const buckets = new Map();
  for (const item of sorted) {
    const exactKey = [item.fileId || '', item.page || 0, item.startChar, item.endChar, item.category, item.symbol, correctedText(item)].join('|');
    const exactIndex = exact.get(exactKey);
    if (exactIndex != null) {
      const winner = preferredCorrection(result[exactIndex], item);
      const loser = winner === item ? result[exactIndex] : item;
      result[exactIndex] = winner;
      diagnostics.exactDuplicates += 1;
      diagnostics.rejectedIds.push(loser.id);
      continue;
    }
    const bucketKey = [item.fileId || '', item.page || 0, item.category, item.symbol].join('|');
    const candidates = buckets.get(bucketKey) || [];
    let duplicateIndex = null;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const index = candidates[i];
      const old = result[index];
      if (!old || old.endChar <= item.startChar) break;
      if (sameLocation(old, item) && substantiallyOverlaps(old, item) && equivalentCorrection(old, item)) {
        duplicateIndex = index; break;
      }
    }
    if (duplicateIndex != null) {
      const winner = preferredCorrection(result[duplicateIndex], item);
      const loser = winner === item ? result[duplicateIndex] : item;
      result[duplicateIndex] = winner;
      diagnostics.overlapDuplicates += 1;
      diagnostics.rejectedIds.push(loser.id);
      continue;
    }
    const conflictKey = [item.fileId || '', item.page || 0, item.startChar, item.endChar, item.category, item.symbol].join('|');
    const conflictIndex = spanSymbols.get(conflictKey);
    if (conflictIndex != null) {
      const winner = preferredCorrection(result[conflictIndex], item);
      const loser = winner === item ? result[conflictIndex] : item;
      result[conflictIndex] = winner;
      diagnostics.conflicts += 1;
      diagnostics.rejectedIds.push(loser.id);
      continue;
    }
    const index = result.length;
    result.push(item);
    exact.set(exactKey, index);
    spanSymbols.set(conflictKey, index);
    candidates.push(index);
    buckets.set(bucketKey, candidates);
  }
  const occurrences = new Map();
  const corrections = result.filter(Boolean).sort(canonicalSort).map((item) => {
    const pattern = `${item.category}|${item.symbol}|${normalizedText(item.suggestedText)}`;
    const seen = occurrences.get(pattern) || 0; occurrences.set(pattern, seen + 1);
    const repetitionFactor = REPETITION_FACTORS[seen] ?? Math.max(0.25, 0.55 * Math.pow(0.78, seen - 2));
    const base = Number(item.defaultDeduction);
    return { ...item, repetitionFactor, appliedDeduction: Number.isFinite(base) ? base * repetitionFactor : 0,
      deductionPolicyVersion: DEDUCTION_POLICY_VERSION };
  });
  return { corrections, diagnostics };
}

function mergeCorrections(items) {
  const languageToolCorrections = (items || []).filter((item) => item?.source === 'LANGUAGETOOL');
  const aiCorrections = (items || []).filter((item) => item?.source !== 'LANGUAGETOOL');
  return mergeCanonicalCorrections({ languageToolCorrections, aiCorrections }).corrections;
}

function statistics(items) {
  const out = { content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0 };
  for (const item of items || []) { const key = String(item.category || '').toLowerCase(); if (key in out && key !== 'total') out[key]++; }
  out.total = out.content + out.organization + out.grammar + out.vocabulary + out.mechanics;
  return out;
}

const computeCanonicalCorrectionStatistics = statistics;

module.exports = { VERSION, DEDUCTION_POLICY_VERSION, REPETITION_FACTORS, legendIndex, locateQuote, mapOffsetsToWords, normalizeCorrection, mergeCanonicalCorrections,
  mergeCorrections, statistics, computeCanonicalCorrectionStatistics };
