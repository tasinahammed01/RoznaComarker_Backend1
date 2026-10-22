'use strict';
// Golden-specific evaluation fixture, never runtime essay-replacement rules.
// No dotenv/provider/DB calls. Does not mark agent review as human adjudication.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { digest } = require('../src/services/hybridSource/reconcile');
const { fallbackLegend, contentHash } = require('../src/services/correctionLegendResolver.service');
const { occurrences, validateCorrectionGold, evaluateCorrectionSet, ocrInducedRate } = require('../src/services/hybridSource/correctionGold');
const { correctionDependency } = require('../src/services/hybridSource/verificationPolicy');
const { sameIdentity } = require('../src/services/hybridSource/sourceAuthority');
const semantic = require('../src/services/semanticWritingCorrections.service');
const root = path.resolve(__dirname, '../tests/fixtures/hybrid-source/private/001-louise-mallard');
const out = path.join(root, 'correction-gold'); fs.mkdirSync(out, { recursive: true });
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const source = read('human-gold.json'), replay = read('reconciliation-phase2/human-control.json');
const attestations = read('reconciliation-phase2/offline-gold-attestations.json');
const native = read('google-native.json'), identity = replay.identity, transcript = source.transcript;
const sourceHash = digest(fs.readFileSync(path.join(root, 'source.png.jpeg')));
if (sourceHash !== source.imageSha256 || identity.sourceSha256 !== sourceHash
  || !sameIdentity(identity, read('shadow-evidence.json').identity)
  || native.pages[0].ocrInputSha256 !== identity.inputSha256) throw Error('GOLDEN_CORRECTION_SOURCE_IDENTITY_MISMATCH');
const words = native.rawGoogle[0].words.map((w, i) => ({ ...w, id: `word_${identity.fileId}_${identity.pageNumber}_${i + 1}` }));
const geometry = { words, bindings: replay.bindings, attestations };
const legend = fallbackLegend();
const entry = (id, quote, occurrence, replacement, category, symbol, reason, kind = 'OBJECTIVE_LITERAL') => {
  const start = occurrences(transcript, quote)[occurrence - 1];
  if (start === undefined) throw Error(`SOURCE_OCCURRENCE_MISSING_${id}`);
  const end = start + quote.length;
  const value = { id, quotedText: quote, start, end, occurrence, occurrenceId: `${digest(transcript)}:${start}:${end}`,
    suggestedText: replacement, category, symbol, reason, kind,
    humanReviewStatus: 'USER_CONFIRMED', sourceReview: 'USER_CONFIRMED_FROZEN_TRANSCRIPT',
    publishable: false };
  const dependency = correctionDependency(value, replay.bindings, identity, attestations, { transcript });
  return { ...value, expectedNativeWordIds: dependency.wordIds, expectedPolygons: dependency.polygons,
    mappingStatus: dependency.decision === 'ALLOW_OFFLINE_BINDING' ? 'EXACT_MAPPING_OFFLINE' : 'MAPPING_WITHHELD',
    uncertainty: dependency.decision === 'ALLOW_OFFLINE_BINDING' ? [] : [dependency.reason], mappingEvidence: dependency };
};
const corrections = [
  entry('A', 'relize', 1, 'realize', 'MECHANICS', 'SP', 'User-proposed objective spelling correction; retain the source misspelling in OCR.'),
  entry('B', 'relizing', 1, 'realizing', 'MECHANICS', 'SP', 'First exact relizing occurrence; independently identified by gold offsets.'),
  entry('C', 'relizing', 2, 'realizing', 'MECHANICS', 'SP', 'Second exact relizing occurrence; never substitute the first occurrence geometry.'),
  entry('D', 'we', 1, 'We', 'MECHANICS', 'CAP', 'Lowercase we follows the human-confirmed full stop after herself.'),
  entry('E', 'got rid off', 1, 'got rid of', 'GRAMMAR', 'PREP', 'User-proposed preposition correction in the phrase; not SP or WC.'),
  entry('F', 'Social', 1, 'social', 'MECHANICS', 'CAP', 'Sentence-internal Social follows This suggests that across a handwritten line break.'),
  entry('G', 'preception', 1, 'perception', 'MECHANICS', 'SP', 'User-proposed spelling correction to the preserved student source spelling.'),
  entry('H', 'Society', 1, 'society', 'MECHANICS', 'CAP', 'The remaining uppercase Society follows Overall, the story shows that, not a sentence boundary.')
];
const boundary = entry('I', 'controlled her\nanother example', 1, 'controlled her.\nAnother example', 'GRAMMAR', 'RO',
  'User confirmed that another example begins a new independent thought without a sentence boundary. Insert a period and capitalize Another. Do not add a second CAP count for this boundary repair.', 'CONTEXTUAL_BOUNDARY');
corrections.push(boundary);
const noAutomatic = ['supposed death', 'not true to herself', 'impose\nupon another', 'free', 'untrue to yourself', 'can be controlling'];
const negatives = [
  ['N1', 'Mallard', 'Matland'], ['N2', 'shaped', 'sshaped'], ['N3', 'norms', 'world'],
  ['N4', 'body', 'heart'], ['N5', 'untrue', 'untime']
].map(([id, quote, legacyQuote]) => {
  const start = occurrences(transcript, quote)[0], end = start + quote.length;
  const target = { start, end, quotedText: quote, category: 'MECHANICS', symbol: 'SP' };
  const proof = correctionDependency(target, replay.bindings, identity, attestations, { transcript });
  return { id, kind: 'OCR_LITERAL_NEGATIVE', humanReviewed: true,
    provenance: 'User explicitly supplied these source-correct negative controls; not a model-generated error claim.',
    sourceQuote: quote, start, end, occurrence: 1, legacyQuote,
    legacyTranscriptSha256: digest(native.fullText), expectedNativeWordIds: proof.wordIds,
    mappingStatus: proof.decision === 'ALLOW_OFFLINE_BINDING' ? 'EXACT_MAPPING_OFFLINE' : 'MAPPING_WITHHELD',
    rule: 'No student correction for the OCR-created literal; count OCR-induced only if actual matching correction evidence exists.' };
});
const goldPath = path.join(root, 'human-corrections.json');
const contextualDecisions = [
  ['actual intention', 'actual intention', 'The wording is awkward/context-dependent, but there is no sufficiently unambiguous exact replacement and legend code to make it a reliable human-gold correction. Do not assign WC, CL, DEV, REL or another code speculatively.'],
  ['past ways that she walked', 'past ways that she walked', 'The phrase is stylistically awkward but understandable. A correction would require subjective rewriting rather than identifying a clear source error. Do not assign WC/CL/DEV automatically.'],
  ['the same way they can make you a good human', 'the\nsame way they can make you a good human', 'The wording is awkward but understandable and not sufficiently objective for a counted correction with an exact replacement. Do not rewrite good human to good person merely for style.']
].map(([reviewQuote, quotedText, reason], index) => {
  const start = transcript.indexOf(quotedText);
  if (start < 0) throw Error('CONTEXTUAL_NEGATIVE_SOURCE_MISSING');
  const end = start + quotedText.length;
  return { id: `NC${index + 1}`, kind: 'CONTEXTUAL_NEGATIVE', reviewQuote, quotedText, start, end,
    occurrence: occurrences(transcript, quotedText).indexOf(start) + 1, occurrenceId: `${digest(transcript)}:${start}:${end}`,
    humanReviewed: true, reviewer: 'USER', status: 'HUMAN_REVIEW_COMPLETE', decision: 'EXCLUDE_NO_COUNTED_CORRECTION',
    suggestedText: null, symbol: null, category: null, reason };
});
const proposed = { version: 'human-corrections-v1', fixture: 'golden001', identity,
  sourceTranscriptSha256: digest(transcript), sourceGoldFileSha256: digest(fs.readFileSync(path.join(root, 'human-gold.json'))),
  legend: { version: legend.version, contentHash: contentHash(legend), source: 'CODE_OWNED_VERSIONED_FALLBACK',
    reference: 'backend/src/services/correctionLegendResolver.service.js' },
  review: { humanReviewed: true, exhaustive: true, status: 'HUMAN_REVIEW_COMPLETE',
    reviewer: 'USER', provenance: 'User explicitly retained A-I unchanged, excluded all three contextual candidates and declared the review exhaustive on 2026-10-19 for the frozen active transcript and current code-owned Correction Legend.',
    contextReviewComplete: true }, corrections,
  reviewCandidates: [], negativeCases: negatives,
  noAutomaticCorrectionCases: noAutomatic.map(quote => ({ quotedText: quote,
    occurrences: occurrences(transcript, quote).map(start => ({ start, end: start + quote.length })),
    rule: 'Not an automatic error from this phrase alone; no fabricated contextual feedback.' })),
  excludedRegionControls: source.excludedSpans.map((span, index) => ({ id: `excluded:${index + 1}`, ...span,
    start: null, end: null, correctionTargetAllowed: false,
    rule: 'Outside active transcript; no fabricated quote, offsets or underlying deleted text.' })),
  contextualReview: { status: 'HUMAN_REVIEW_COMPLETE', acceptedFindings: [], candidates: contextualDecisions,
    rule: 'Explicit human-reviewed negative contextual controls, not confirmed corrections. A-I are the exhaustive correction set for this frozen transcript and legend.' } };
// Preserve a real human adjudication if this generator is rerun. Changed source
// or legend must not silently overwrite/relabel the reviewed fixture.
let gold = proposed;
if (fs.existsSync(goldPath)) {
  const previous = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  if (previous.review?.humanReviewed === true) {
    validateCorrectionGold(previous, transcript, identity, geometry);
    gold = previous;
    if (process.argv.includes('--apply-final-human-review')) {
      // Explicitly apply the user's final adjudication to review metadata only.
      // Never regenerate A-I, including their reasons and polygon evidence.
      gold = { ...previous, review: proposed.review, contextualReview: proposed.contextualReview };
      if (JSON.stringify(gold.corrections) !== JSON.stringify(previous.corrections)) throw Error('CONFIRMED_CORRECTIONS_CHANGED');
    }
  }
}
if (gold.sourceGoldFileSha256 !== digest(fs.readFileSync(path.join(root, 'human-gold.json')))) throw Error('FROZEN_HUMAN_SOURCE_FILE_CHANGED');
const validated = validateCorrectionGold(gold, transcript, identity, geometry);
fs.writeFileSync(goldPath, JSON.stringify(gold, null, 2) + '\n');
write('validation.json', validated);
const engineVersions = { prompt: semantic.SEMANTIC_PROMPT_VERSION, schema: semantic.SEMANTIC_SCHEMA_VERSION,
  categoryReview: semantic.CATEGORY_REVIEW_POLICY_VERSION };
const roots = [path.resolve(__dirname, '../tests/fixtures'), path.resolve(__dirname, '../tmp'), path.resolve(__dirname, '../../output')].filter(fs.existsSync);
const files = execFileSync('rg', ['--files', '--hidden', '--no-ignore', ...roots, '-g', '*.json',
  '-g', '!**/node_modules/**', '-g', '!**/combined-release-source/**', '-g', '!**/baseline-src/**'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
const matches = []; let skippedLarge = 0;
for (const file of files) {
  if (fs.statSync(file).size > 8 * 1024 * 1024) { skippedLarge++; continue; }
  const data = fs.readFileSync(file, 'utf8');
  if (!data.includes(digest(transcript)) && !data.includes(digest(native.fullText))) continue;
  let value; try { value = JSON.parse(data); } catch { continue; }
  matches.push({ file: path.relative(path.resolve(__dirname, '..'), file), version: value.version || null,
    semanticCapture: value.version === 'semantic-correction-capture-v1',
    reason: value.version === 'semantic-correction-capture-v1' ? 'REQUIRES_EXACT_MODEL_AND_VERSION_COMPATIBILITY_REVIEW' : 'NOT_A_VERSIONED_CORRECTION_COMPLETION' });
}
const control = { status: 'BLOCKED_NO_VERIFIED_COMPATIBLE_CORRECTION_COMPLETION', providerCalls: 0,
  sourceTranscriptSha256: digest(transcript), engineVersions, legendContentHash: contentHash(legend),
  searchedRoots: roots.map(r => path.relative(path.resolve(__dirname, '..'), r)), filesScanned: files.length, skippedLarge,
  matchingHashArtifacts: matches, liveControlAttempted: false,
  reason: 'Existing control harness needs an offline runCompletion adapter. No compatible saved correction completion was verified. No provider call is authorized.',
  metrics: evaluateCorrectionSet(gold, transcript, null),
  OCR_INDUCED_FALSE_CORRECTION_RATE: ocrInducedRate(null, native.fullText, identity, gold.negativeCases) };
write('control-status.json', control);
const categories = new Map();
gold.corrections.forEach(c => c.expectedNativeWordIds.forEach(id => categories.set(id, { color: 'green', label: `${c.id}: ${c.symbol}; human-confirmed correction` })));
gold.negativeCases.forEach(n => n.expectedNativeWordIds.forEach(id => { if (!categories.has(id)) categories.set(id, { color: 'blue', label: `${n.id}: source-correct negative control` }); }));
for (const b of replay.bindings.filter(b => b.state === 'VERIFIED_SOURCE')) for (const id of b.wordIds)
  if (!categories.has(id)) categories.set(id, { color: 'blue', label: 'source verified in offline human control; no reviewed correction selected' });
const polygons = words.map(w => {
  const c = categories.get(w.id) || { color: 'orange', label: 'unmapped/uncertain or excluded region' };
  return `<polygon points="${w.polygon.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${c.color}" stroke-width="2"><title>${w.id}: ${c.label}</title></polygon>`;
}).join('\n');
const reviewLabel = gold.review.exhaustive ? 'Human review complete; A-I are exhaustive for the frozen transcript and current legend. Three contextual candidates are explicit human-reviewed negatives.' : 'Human-confirmed subset; exhaustive review pending.';
fs.writeFileSync(path.join(out, 'annotation-review.html'), '<!doctype html><meta charset="utf-8"><title>Private correction-gold review</title><p>' + reviewLabel + ' Green = eight confirmed correction targets with unique source geometry. I (RO) is confirmed but its marker is withheld. Blue = verified source with no confirmed correction or a negative control. Orange = uncertain/unmapped or excluded geometry.</p><p>Excluded material: prompt Sense of Self?, MAXI camera branding, adjacent non-text camera icon, and six crossed-out regions. These are outside the active transcript. Deleted extents are not manually boxed; no coordinates or deleted text are guessed. No production correction.</p><div style="position:relative;width:min(100%,1200px)"><img src="../source.png.jpeg" style="width:100%;display:block"><svg viewBox="0 0 1200 1600" style="position:absolute;inset:0;width:100%;height:100%">' + polygons + '</svg></div>');
write('ambiguous-targets.json', read('reconciliation-phase2/target-review.json').filter(r => ['controlled her', 'inside her body', 'untrue to yourself'].includes(r.target)));
console.log(JSON.stringify({ validated, correctionCandidates: gold.corrections.length, additionalReviewCandidates: gold.reviewCandidates.length,
  mappedObjectiveTargets: gold.corrections.filter(c => c.mappingStatus === 'EXACT_MAPPING_OFFLINE').length,
  controlStatus: control.status, filesScanned: control.filesScanned, providerCalls: 0 }));
