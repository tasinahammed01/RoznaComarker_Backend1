'use strict';
// Explicit content-free projection for offline/live QA reports. Never serialize
// correction records, source, rejection hashes, provider headers or raw errors.
const { getOfficialCorrectionLegend } = require('./correctionLegendCatalog.service');
const symbols = getOfficialCorrectionLegend().groups.flatMap(group => group.symbols.map(item => item.symbol));
const reasons = ['INVALID_SCHEMA','LEGEND_MISMATCH','CATEGORY_DISABLED_BY_POLICY','INCOMPLETE_TRANSCRIPT_CONCLUSION',
  'STYLE_PREFERENCE','UNSUPPORTED_CORRECTION_KIND','CATEGORY_MISMATCH','INVALID_SEVERITY','LOW_CONFIDENCE',
  'OCCURRENCE_NOT_FOUND','QUOTE_NOT_FOUND','CONCLUSION_NOT_AT_END','INVALID_LOCATION',
  'NO_OP_CORRECTION','CORRECTION_SOURCE_MISMATCH'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function project(diagnostics = {}, expectedSymbols = []) {
  const counts = input => Object.fromEntries(symbols.map(symbol => [symbol, count(input?.[symbol])]));
  const rawSymbolCounts = counts(diagnostics.rawSymbolCounts);
  const acceptedSymbolCounts = counts(diagnostics.acceptedSymbolCounts);
  const rejectionReasonCounts = Object.fromEntries(reasons.map(reason => [reason, count(diagnostics.rejectionReasons?.[reason])]));
  const known = Object.values(rejectionReasonCounts).reduce((sum, value) => sum + value, 0);
  const rejected = count(diagnostics.rejectedCorrectionCount);
  return { rawSymbolCounts, acceptedSymbolCounts, rejectionReasonCounts,
    otherRejectedCount: Math.max(0, rejected - known),
    rejectionReasonsBySymbol: Object.fromEntries(symbols.map(symbol => [symbol,
      Object.fromEntries(reasons.map(reason => [reason, count(diagnostics.rejectionReasonsBySymbol?.[symbol]?.[reason])]))])),
    expectedSymbolPresence: [...new Set(expectedSymbols)].filter(symbol => symbols.includes(symbol)).map(symbol => ({
      symbol, presentBeforeValidation: rawSymbolCounts[symbol] > 0, acceptedAfterValidation: acceptedSymbolCounts[symbol] > 0
    })) };
}
// QA only. Source and candidate records remain transient; return counts/statuses only.
// Strict occurrence evidence and production grounding are intentionally reported separately.
function measureGrounding({ transcript, rawCorrections = [], acceptedCorrections = [], defects = [], negativeControls = [], catalog }) {
  const canonical = require('./correctionCanonical.service');
  const legend = require('./writingCorrections.service').defaultLegend();
  const literalRanges = quote => {
    const ranges = [];
    if (typeof quote !== 'string' || !quote.length) return ranges;
    for (let start = transcript.indexOf(quote); start >= 0; start = transcript.indexOf(quote, start + 1))
      ranges.push({ startChar: start, endChar: start + quote.length });
    return ranges;
  };
  const exact = c => Number.isInteger(c.startChar) && Number.isInteger(c.endChar) && c.startChar >= 0
    && c.endChar > c.startChar && c.endChar <= transcript.length && transcript.slice(c.startChar, c.endChar) === c.quotedText;
  const samePage = (a, b) => String(a.fileId || '') === String(b.fileId || '') && Number(a.page || 0) === Number(b.page || 0);
  const overlap = (a, b) => a.startChar < b.endChar && b.startChar < a.endChar;
  const raw = rawCorrections.map(c => {
    const matches = literalRanges(c.quotedText), strict = matches[c.occurrence];
    const located = canonical.locateQuote(transcript, c.quotedText, Number(c.occurrence));
    const category = canonical.getCanonicalCategoryForCorrectionCode(c.symbol, legend);
    return { candidate: c, strict: strict ? { ...c, ...strict } : null,
      grounded: located ? { ...c, category: category || c.category, startChar: located.start, endChar: located.end } : null,
      category, cause: !matches.length ? 'LITERAL_QUOTE_ABSENT' : strict ? 'EXACT_OCCURRENCE_MATCH'
        : located ? 'UNIQUE_QUOTE_OCCURRENCE_FALLBACK' : 'OCCURRENCE_NOT_FOUND' };
  });
  const strict = raw.flatMap(c => c.strict ? [c.strict] : []), located = raw.flatMap(c => c.grounded ? [c.grounded] : []);
  const accepted = acceptedCorrections.filter(exact);
  const controlRanges = negativeControls.flatMap(literalRanges);
  const controlHits = items => items.filter(c => controlRanges.some(r => overlap(c, r))).length;
  const pairs = items => {
    let coincident = 0, overlaps = 0;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (samePage(items[i], items[j])) {
      if (items[i].startChar === items[j].startChar && items[i].endChar === items[j].endChar) coincident++;
      if (overlap(items[i], items[j])) overlaps++;
    }
    return { coincident, overlaps };
  };
  const acceptedPairs = pairs(accepted), rawPairs = pairs(located);
  const merged = canonical.mergeCanonicalCorrections({ aiCorrections: accepted }).diagnostics;
  return {
    metricsVersion: 'correction-quality-grounding-v2', coordinateSystem: 'canonical_transcript_utf16',
    rawFindingCount: raw.length, acceptedFindingCount: acceptedCorrections.length,
    rawStrictOccurrenceMatchCount: strict.length, rawProductionLocatedCount: located.length,
    rawUniqueQuoteFallbackCount: raw.filter(c => c.cause === 'UNIQUE_QUOTE_OCCURRENCE_FALLBACK').length,
    rawLiteralQuoteAbsentCount: raw.filter(c => c.cause === 'LITERAL_QUOTE_ABSENT').length,
    rawOccurrenceNotFoundCount: raw.filter(c => c.cause === 'OCCURRENCE_NOT_FOUND').length,
    acceptedExactSpanMatchCount: accepted.length,
    rawUnknownSymbolCount: raw.filter(c => !c.category).length,
    rawUnknownCategoryCount: raw.filter(c => !Object.hasOwn(catalog, c.candidate.category)).length,
    rawUnknownCategoryOrSymbolCount: raw.filter(c => !c.category || !Object.hasOwn(catalog, c.candidate.category)).length,
    rawCategorySymbolMismatchCount: raw.filter(c => c.category && c.category !== c.candidate.category).length,
    rawStrictNegativeControlIntersectionCount: controlHits(strict),
    rawProductionNegativeControlIntersectionCount: controlHits(located),
    acceptedNegativeControlIntersectionCount: controlHits(accepted),
    rawProductionCoincidentSpanPairCount: rawPairs.coincident, rawProductionGeometricOverlapPairCount: rawPairs.overlaps,
    acceptedCoincidentSpanPairCount: acceptedPairs.coincident, acceptedGeometricOverlapPairCount: acceptedPairs.overlaps,
    acceptedCanonicalDuplicateRemovalCount: merged.duplicateCount, acceptedCanonicalConflictRemovalCount: merged.conflictCount,
    expectedSymbols: defects.map(f => {
      const targets = literalRanges(f.quote), target = targets.length === 1 ? targets[0] : null;
      const candidates = accepted.filter(c => c.symbol === f.symbol && c.category === f.category);
      const intersecting = target ? candidates.filter(c => overlap(c, target)) : [];
      const contained = target ? candidates.filter(c => c.startChar >= target.startChar && c.endChar <= target.endChar) : [];
      const present = raw.some(c => c.candidate.symbol === f.symbol), acceptedSymbol = acceptedCorrections.some(c => c.symbol === f.symbol);
      return { symbol: f.symbol, presentBeforeValidation: present, acceptedAfterValidation: acceptedSymbol,
        expectedDefectOverlapCount: intersecting.length, expectedDefectContainedCount: contained.length,
        targetEvidence: target ? 'FROZEN_REGION_CONTAINMENT_NOT_SEMANTIC_JUDGMENT' : 'MANIFEST_TARGET_AMBIGUOUS_OR_ABSENT',
        stage: !present ? 'SYMBOL_NOT_RETURNED' : !acceptedSymbol ? 'SYMBOL_RETURNED_SERVER_REJECTED'
          : !target ? 'FAILURE_STAGE=UNPROVEN' : contained.length ? 'SYMBOL_ACCEPTED_AT_EXPECTED_DEFECT' : 'SYMBOL_ACCEPTED_WRONG_DEFECT',
        suggestionMatch: !contained.length ? 'NOT_EVALUATED' : contained.every(c => f.allowedSuggestions.includes(c.suggestedText))
          ? 'MATCH' : 'BENCHMARK_SUGGESTION_NON_MATCH_SEMANTIC_VALIDITY_UNPROVEN' };
    })
  };
}
module.exports = { project, measureGrounding };
