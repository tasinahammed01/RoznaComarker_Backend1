'use strict';
// Offline correction-gold validation/evaluation. Never calls an AI provider or DB.
const { REQUIRED, fallbackLegend, contentHash } = require('../correctionLegendResolver.service');
const { digest } = require('./reconcile');
const { sameIdentity } = require('./sourceAuthority');
const { correctionDependency } = require('./verificationPolicy');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function occurrences(transcript, quote) {
  const result = [];
  if (!quote) return result;
  for (let start = transcript.indexOf(quote); start >= 0; start = transcript.indexOf(quote, start + 1)) result.push(start);
  return result;
}
function validateEntry(entry, transcript) {
  if (!entry || !Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0
    || entry.end <= entry.start || transcript.slice(entry.start, entry.end) !== entry.quotedText) fail('CORRECTION_GOLD_EXACT_QUOTE_REQUIRED');
  if (!REQUIRED[entry.category]?.includes(entry.symbol)) fail('CORRECTION_GOLD_UNSUPPORTED_TAXONOMY');
  if (typeof entry.suggestedText !== 'string' || entry.suggestedText === entry.quotedText) fail('CORRECTION_GOLD_UNCHANGED_SUGGESTION');
  const starts = occurrences(transcript, entry.quotedText);
  if (!Number.isInteger(entry.occurrence) || starts[entry.occurrence - 1] !== entry.start
    || entry.occurrenceId !== `${digest(transcript)}:${entry.start}:${entry.end}`) fail('CORRECTION_GOLD_OCCURRENCE_MISMATCH');
  if (typeof entry.reason !== 'string' || !entry.reason || !['OBJECTIVE_LITERAL', 'CONTEXTUAL_BOUNDARY'].includes(entry.kind)) fail('CORRECTION_GOLD_REASON_REQUIRED');
}
function validateCorrectionGold(gold, transcript, identity, geometry) {
  const legend = fallbackLegend();
  if (gold?.version !== 'human-corrections-v1' || !sameIdentity(gold.identity, identity)
    || gold.sourceTranscriptSha256 !== digest(transcript) || gold.legend.version !== legend.version
    || gold.legend.contentHash !== contentHash(legend) || !Array.isArray(gold.corrections)
    || !Array.isArray(gold.reviewCandidates) || !Array.isArray(gold.negativeCases)
    || typeof gold.review?.humanReviewed !== 'boolean' || typeof gold.review?.exhaustive !== 'boolean') fail('CORRECTION_GOLD_IDENTITY_OR_SCHEMA');
  const ids = new Set();
  for (const entry of [...gold.corrections, ...gold.reviewCandidates]) {
    validateEntry(entry, transcript);
    if (ids.has(entry.id)) fail('CORRECTION_GOLD_DUPLICATE_ID');
    ids.add(entry.id);
    if (!['EXACT_MAPPING_OFFLINE', 'MAPPING_WITHHELD'].includes(entry.mappingStatus)) fail('CORRECTION_GOLD_MAPPING_STATUS');
    if (geometry) {
      const dependency = correctionDependency(entry, geometry.bindings, identity, geometry.attestations, { transcript });
      const expected = dependency.decision === 'ALLOW_OFFLINE_BINDING' ? 'EXACT_MAPPING_OFFLINE' : 'MAPPING_WITHHELD';
      if (entry.mappingStatus !== expected || JSON.stringify(entry.expectedNativeWordIds) !== JSON.stringify(dependency.wordIds)) fail('CORRECTION_GOLD_GEOMETRY_MISMATCH');
      if (entry.mappingStatus === 'EXACT_MAPPING_OFFLINE') {
        const native = new Map(geometry.words.map(w => [w.id, w]));
        if (entry.expectedNativeWordIds.some(id => !native.has(id))
          || JSON.stringify(entry.expectedPolygons) !== JSON.stringify(entry.expectedNativeWordIds.map(id => native.get(id).polygon))) fail('CORRECTION_GOLD_POLYGON_MISMATCH');
      }
    }
  }
  if (gold.contextualReview?.status === 'HUMAN_REVIEW_COMPLETE') {
    if (!Array.isArray(gold.contextualReview.candidates)) fail('CONTEXTUAL_NEGATIVE_SCHEMA');
    for (const entry of gold.contextualReview.candidates) {
      if (entry.kind !== 'CONTEXTUAL_NEGATIVE' || entry.humanReviewed !== true || entry.reviewer !== 'USER'
        || entry.decision !== 'EXCLUDE_NO_COUNTED_CORRECTION' || entry.status !== 'HUMAN_REVIEW_COMPLETE'
        || entry.suggestedText !== null || entry.symbol !== null || entry.category !== null
        || typeof entry.reason !== 'string' || !entry.reason || ids.has(entry.id)
        || typeof entry.quotedText !== 'string' || !entry.quotedText
        || !Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0
        || entry.end !== entry.start + entry.quotedText.length || transcript.slice(entry.start, entry.end) !== entry.quotedText
        || occurrences(transcript, entry.quotedText)[entry.occurrence - 1] !== entry.start
        || entry.occurrenceId !== `${digest(transcript)}:${entry.start}:${entry.end}`) fail('CONTEXTUAL_NEGATIVE_SCHEMA');
      ids.add(entry.id);
    }
  }
  return { valid: true, humanReviewed: gold.review.humanReviewed, exhaustive: gold.review.exhaustive,
    correctionCount: gold.corrections.length, reviewCandidateCount: gold.reviewCandidates.length };
}
function compatibleCapture(record, snapshot) {
  const hashes = ['transcriptSha256', 'legendContentHash', 'modelConfigHash', 'assignmentHash'];
  if (!snapshot || hashes.some(key => !/^[a-f0-9]{64}$/.test(snapshot[key] || ''))
    || !snapshot.engineVersions || ['prompt', 'schema', 'categoryReview'].some(key => typeof snapshot.engineVersions[key] !== 'string' || !snapshot.engineVersions[key])) return false;
  return Boolean(record && record.version === 'semantic-correction-capture-v1'
    && sameIdentity(record.identity, snapshot.identity) && record.transcriptSha256 === snapshot.transcriptSha256
    && record.legendContentHash === snapshot.legendContentHash && record.modelConfigHash === snapshot.modelConfigHash
    && record.assignmentHash === snapshot.assignmentHash
    && record.engineVersions && ['prompt', 'schema', 'categoryReview'].every(key => record.engineVersions[key] === snapshot.engineVersions[key])
    && typeof record.content === 'string');
}
function evaluateCorrectionSet(gold, transcript, actual) {
  const empty = { truePositives: null, falsePositives: null, falseNegatives: null, precision: null, recall: null,
    codeCategoryAccuracy: null, exactSourceQuoteAccuracy: null, offsetAccuracy: null,
    unchangedSuggestions: null, spWcMistakes: null, unsupportedContextual: null };
  if (!gold.review.humanReviewed || !gold.review.exhaustive) return { status: 'HUMAN_CORRECTION_REVIEW_REQUIRED', ...empty };
  if (!Array.isArray(actual)) return { status: 'CONTROL_COMPLETION_UNAVAILABLE', ...empty };
  const remaining = [...gold.corrections], diagnostics = [];
  let tp = 0, codeComparable = 0, codeCorrect = 0, quoteCorrect = 0, offsetCorrect = 0, unchanged = 0, spWc = 0, contextual = 0;
  for (const item of actual) {
    const validOffset = Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0
      && item.end > item.start && transcript.slice(item.start, item.end) === item.quotedText;
    if (typeof item.quotedText === 'string' && item.quotedText && transcript.includes(item.quotedText)) quoteCorrect++;
    if (validOffset) offsetCorrect++;
    const sameSuggestion = item.quotedText === item.suggestedText;
    if (sameSuggestion) unchanged++;
    const span = gold.corrections.find(g => g.start === item.start && g.end === item.end && g.quotedText === item.quotedText);
    if (span) {
      codeComparable++;
      if (span.symbol === item.symbol && span.category === item.category) codeCorrect++;
      if (span.symbol !== item.symbol && [span.symbol, item.symbol].every(s => ['SP', 'WC'].includes(s))) spWc++;
    }
    if (!span && ['CONTENT', 'ORGANIZATION'].includes(item.category)) contextual++;
    const index = remaining.findIndex(g => g.start === item.start && g.end === item.end && g.quotedText === item.quotedText
      && g.category === item.category && g.symbol === item.symbol && g.suggestedText === item.suggestedText);
    if (index >= 0 && validOffset && !sameSuggestion) { tp++; remaining.splice(index, 1); }
    else diagnostics.push({ start: item.start, end: item.end, reason: sameSuggestion ? 'UNCHANGED_SUGGESTION'
      : !validOffset ? 'INVALID_SOURCE_QUOTE_OR_OFFSET' : span && span.symbol !== item.symbol ? 'TAXONOMY_MISMATCH' : 'UNMATCHED_OR_DUPLICATE_FINDING' });
  }
  return { status: 'EVALUATED', truePositives: tp, falsePositives: actual.length - tp, falseNegatives: remaining.length,
    precision: actual.length ? tp / actual.length : null, recall: gold.corrections.length ? tp / gold.corrections.length : null,
    codeCategoryAccuracy: codeComparable ? codeCorrect / codeComparable : null,
    exactSourceQuoteAccuracy: actual.length ? quoteCorrect / actual.length : null,
    offsetAccuracy: actual.length ? offsetCorrect / actual.length : null,
    unchangedSuggestions: unchanged, spWcMistakes: spWc, unsupportedContextual: contextual, diagnostics };
}
function ocrInducedRate(record, legacyTranscript, identity, negativeCases) {
  if (!record) return { status: 'ACTUAL_LEGACY_CORRECTIONS_UNAVAILABLE', rate: null, confirmedOcrInduced: null };
  if (!sameIdentity(record.identity, identity) || record.transcriptSha256 !== digest(legacyTranscript)
    || !Array.isArray(record.corrections)) return { status: 'LEGACY_CORRECTION_IDENTITY_MISMATCH', rate: null, confirmedOcrInduced: null };
  let confirmed = 0, unknown = 0;
  for (const c of record.corrections) {
    const negative = negativeCases.find(n => n.kind === 'OCR_LITERAL_NEGATIVE' && n.humanReviewed === true && n.legacyQuote === c.quotedText
      && n.sourceQuote === c.suggestedText && n.expectedNativeWordIds?.length
      && JSON.stringify(n.expectedNativeWordIds) === JSON.stringify(c.wordIds));
    const exact = Number.isInteger(c.start) && Number.isInteger(c.end)
      && legacyTranscript.slice(c.start, c.end) === c.quotedText;
    if (negative && exact) confirmed++;
    else if (c.humanAdjudication?.reviewer && typeof c.humanAdjudication.ocrInduced === 'boolean') {
      if (c.humanAdjudication.ocrInduced) confirmed++;
    } else unknown++;
  }
  return { status: unknown ? 'PARTIAL_ADJUDICATION' : 'EVALUATED', confirmedOcrInduced: confirmed,
    unknown, total: record.corrections.length, rate: !unknown && record.corrections.length ? confirmed / record.corrections.length : null };
}
module.exports = { occurrences, validateEntry, validateCorrectionGold, compatibleCapture, evaluateCorrectionSet, ocrInducedRate };
