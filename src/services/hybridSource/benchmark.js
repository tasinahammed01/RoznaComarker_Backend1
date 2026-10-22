'use strict';
const { REQUIRED, fallbackLegend } = require('../correctionLegendResolver.service');
const semantic = require('../semanticWritingCorrections.service');
const { failure } = require('./contract');
// Levenshtein counts with deterministic tie-breaking, bounded memory. These are
// evaluation metrics only and MUST NOT be used to map text onto source geometry.
function edits(reference, candidate) {
  if (reference.length > 20000 || candidate.length > 20000
    || reference.length * candidate.length > 4000000) throw failure('OCR_BENCHMARK_LIMIT');
  let row = Array.from({ length: candidate.length + 1 }, (_, j) => ({ distance: j, insertions: j, deletions: 0, substitutions: 0 }));
  for (let i = 1; i <= reference.length; i++) {
    const next = [{ distance: i, insertions: 0, deletions: i, substitutions: 0 }];
    for (let j = 1; j <= candidate.length; j++) {
      const add = (v, field, cost = 1) => ({ ...v, distance: v.distance + cost, [field]: v[field] + cost });
      next[j] = [add(row[j - 1], 'substitutions', reference[i - 1] === candidate[j - 1] ? 0 : 1),
        add(row[j], 'deletions'), add(next[j - 1], 'insertions')].sort((a, b) => a.distance - b.distance)[0];
    }
    row = next;
  }
  return row.at(-1);
}
function validateGold(gold) {
  if (gold?.version !== 'human-gold-v1' || gold.humanReviewed !== true
    || typeof gold.reviewer !== 'string' || !gold.reviewer.trim()
    || !/^[a-f0-9]{64}$/.test(gold.imageSha256 || '') || typeof gold.transcript !== 'string'
    || !Array.isArray(gold.expectedCorrections) || !Array.isArray(gold.excludedSpans)) {
    throw failure('OCR_BENCHMARK_HUMAN_GOLD_REQUIRED');
  }
  return gold;
}
function correctionMetrics(expected, actual, transcript) {
  const key = c => JSON.stringify([c.start, c.end, c.category, c.symbol, c.quotedText, c.suggestedText]);
  const remaining = new Map(expected.map(c => [key(c), c]));
  let valid = 0;
  const invalid = [];
  for (const c of actual) {
    const id = key(c);
    if (remaining.has(id)) { valid++; remaining.delete(id); } else invalid.push(c);
  }
  return { valid, falsePositives: invalid.length, missed: remaining.size,
    invalidCode: actual.filter(c => !REQUIRED[c.category]?.includes(c.symbol)).length,
    quoteMismatch: actual.filter(c => !Number.isInteger(c.start) || !Number.isInteger(c.end)
      || transcript.slice(c.start, c.end) !== c.quotedText).length,
    unchangedSuggestion: actual.filter(c => c.quotedText === c.suggestedText).length,
    spWcDisagreements: actual.filter(c => expected.some(e => e.start === c.start && e.end === c.end
      && new Set([e.symbol, c.symbol]).size === 2 && [e.symbol, c.symbol].every(s => ['SP', 'WC'].includes(s)))).length };
}
function evaluate(gold, candidate) {
  validateGold(gold);
  if (candidate.imageSha256 !== gold.imageSha256 || typeof candidate.transcript !== 'string') throw failure('OCR_BENCHMARK_SOURCE_MISMATCH');
  const referenceWords = gold.transcript.match(/\S+/gu) || [], candidateWords = candidate.transcript.match(/\S+/gu) || [];
  const character = edits([...gold.transcript], [...candidate.transcript]);
  const word = edits(referenceWords, candidateWords);
  const punctuation = text => [...text].filter(c => /\p{P}/u.test(c));
  const leakage = classification => gold.excludedSpans.filter(s => s.classification === classification
    && s.text && candidate.transcript.includes(s.text)).length;
  const corrections = Array.isArray(candidate.corrections) ? candidate.corrections : null;
  const labeled = corrections && corrections.every(c => typeof c.humanReviewedOcrInduced === 'boolean');
  return { CER: gold.transcript.length ? character.distance / [...gold.transcript].length : null,
    WER: referenceWords.length ? word.distance / referenceWords.length : null,
    character, word, omissions: word.deletions, hallucinations: word.insertions,
    caseOnlyTokenDifferences: referenceWords.length === candidateWords.length ? referenceWords.filter((w, i) =>
      w !== candidateWords[i] && w.toLowerCase() === candidateWords[i].toLowerCase()).length : null,
    punctuationErrors: edits(punctuation(gold.transcript), punctuation(candidate.transcript)).distance,
    lineOrderErrors: edits(gold.transcript.split('\n'), candidate.transcript.split('\n')).distance,
    promptLeakage: leakage('PROMPT_OR_INSTRUCTION'), watermarkLeakage: leakage('WATERMARK_OR_CAMERA_BRANDING'),
    crossedOutLeakage: leakage('STUDENT_CROSSED_OUT'),
    uncertainSpanCount: candidate.bindings ? candidate.bindings.filter(b => b.state === 'OCR_UNCERTAIN').length : null,
    geometryBindingSuccessRate: candidate.bindings?.length
      ? candidate.bindings.filter(b => b.state === 'VERIFIED_SOURCE' && b.wordIds?.length).length / candidate.bindings.length : null,
    OCR_INDUCED_FALSE_CORRECTION_RATE: labeled && corrections.length
      ? corrections.filter(c => c.humanReviewedOcrInduced).length / corrections.length : null,
    corrections: corrections ? correctionMetrics(gold.expectedCorrections, corrections, gold.transcript) : null };
}
async function correctionControl(gold, dependencies) {
  validateGold(gold);
  // Offline by construction. Callers must supply a recorded/mock completion adapter;
  // this harness cannot accidentally spend credits or run a live provider request.
  if (typeof dependencies?.runCompletion !== 'function') throw failure('OCR_CONTROL_OFFLINE_ADAPTER_REQUIRED');
  const { digest } = require('./reconcile');
  return semantic.analyze({ transcript: gold.transcript, transcriptHash: digest(gold.transcript),
    legend: fallbackLegend(), disableCategoryAudit: true }, dependencies);
}
module.exports = { edits, validateGold, correctionMetrics, evaluate, correctionControl };
