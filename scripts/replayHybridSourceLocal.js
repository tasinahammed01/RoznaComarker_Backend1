'use strict';
// Offline only: deliberately no dotenv, DB, transport, AI gateway or reader adapter.
const fs = require('fs'), path = require('path');
const { digest, evidenceKey } = require('../src/services/hybridSource/reconcile');
const { reconcileLocal } = require('../src/services/hybridSource/localReconciliation');
const { validateGold } = require('../src/services/hybridSource/benchmark');
const { VERSION } = require('../src/services/hybridSource/contract');
const { correctionDependency } = require('../src/services/hybridSource/verificationPolicy');
const { sameIdentity } = require('../src/services/hybridSource/sourceAuthority');
const root = path.resolve(__dirname, '../tests/fixtures/hybrid-source/private/001-louise-mallard');
const out = path.join(root, 'reconciliation-phase2'); fs.mkdirSync(out, { recursive: true });
const load = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const start = Date.now();
const gold = load('human-gold.json'); validateGold(gold);
const identity = load('shadow-evidence.json').identity;
const sourceBytes = fs.readFileSync(path.join(root, 'source.png.jpeg'));
const google = load('google-native.json'), reader = load('latency-v2/gpt-reader.json');
const generation = load('latency-v2/diagnostics.json');
if (digest(sourceBytes) !== gold.imageSha256 || gold.imageSha256 !== identity.sourceSha256
  || google.pages[0].sourceSha256 !== identity.sourceSha256 || google.pages[0].ocrInputSha256 !== identity.inputSha256
  || google.rawGoogle[0].dimensionsMatch !== true || identity.runId !== load('paid-run-reservation.json').runId)
  throw Error('OFFLINE_SOURCE_IDENTITY_MISMATCH');
if (!sameIdentity(generation.identity, identity) || !generation.requests[0]?.bodyComplete
  || generation.requests[0].returnedModel !== 'openai/gpt-5.6-sol'
  || digest(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'latency-v2/fullPage-1-model-content.txt'), 'utf8')))) !== digest(JSON.stringify(reader)))
  throw Error('OFFLINE_READER_IDENTITY_MISMATCH');
const words = google.rawGoogle[0].words.map((w, i) => ({ ...w, id: `word_${identity.fileId}_${identity.pageNumber}_${i + 1}` }));
const before = JSON.stringify(words);
const options = { googleIdentity: identity, coordinateSpace: 'display-image' };
const timings = {};
let stage = Date.now();
const providerOnly = reconcileLocal(reader, words, identity, options);
timings.providerOnlyMs = Date.now() - stage;
const humanReader = { version: VERSION, activeTranscript: gold.transcript, lines: gold.transcript.split('\n')
  .map(text => ({ text, classification: 'STUDENT_ACTIVE_TEXT', confidence: 1 })) };
stage = Date.now();
const humanMapping = reconcileLocal(humanReader, words, identity, options);
timings.humanMappingMs = Date.now() - stage;
// This evidence is explicitly derived from the user's separately reviewed gold,
// not from provider agreement. Geometry is still independently required to be
// locally unique. It is an OFFLINE control, never installed into a live submission.
const reviewed = humanMapping.bindings.filter(b => b.geometryUnique && b.classification === 'STUDENT_ACTIVE_TEXT');
const attestations = [];
const addAttestation = group => {
  const first = group[0], last = group.at(-1);
  const ids = group.flatMap(b => b.mappedWordIds);
  if (new Set(ids).size !== ids.length) return;
  const text = gold.transcript.slice(first.transcriptStart, last.transcriptEnd);
  attestations.push({ kind: 'HUMAN_REVIEWED', reviewer: gold.reviewer,
    reviewId: `gold:${digest(fs.readFileSync(path.join(root, 'human-gold.json')))}:${first.transcriptStart}:${last.transcriptEnd}`,
    identity, evidenceKey: evidenceKey(identity), wordIds: ids, classification: 'STUDENT_ACTIVE_TEXT', text });
};
reviewed.forEach((b, i) => {
  addAttestation([b]);
  for (let count = 2; count <= 3; count++) {
    const group = reviewed.slice(i, i + count);
    if (group.length !== count || group.some(g => g.lineId !== b.lineId)) continue;
    if (group.slice(1).some((g, j) => !/^\s*$/u.test(gold.transcript.slice(group[j].transcriptEnd, g.transcriptStart)))) continue;
    addAttestation(group);
  }
});
// Remove equivalent witnesses; multiple text claims for the same IDs remain
// contradictory and will fail the authority gate instead of picking one.
const unique = [...new Map(attestations.map(a => [JSON.stringify([a.wordIds, a.text]), a])).values()];
stage = Date.now();
const withHuman = reconcileLocal(reader, words, identity, { ...options, trustedAttestations: unique });
timings.humanBackedCandidateMs = Date.now() - stage;
stage = Date.now();
const humanControl = reconcileLocal(humanReader, words, identity, { ...options, trustedAttestations: unique });
timings.humanControlMs = Date.now() - stage;
write('provider-only.json', providerOnly); write('human-backed-candidate.json', withHuman);
write('human-control.json', humanControl); write('offline-gold-attestations.json', unique);
const targetRows = [];
const historicalReview = load('latency-v2/review-targets.json');
for (const target of ['Louise Mallard', 'shaped', 'social norms', 'the way she felt', 'supposed death', 'to herself',
  'controlled her', 'got rid off', 'inside her body', 'expectations', 'untrue to yourself', 'preception']) {
  let occurrence = 0;
  for (const match of gold.transcript.matchAll(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    const start = match.index, end = start + target.length;
    const controls = humanControl.bindings.filter(b => b.transcriptStart !== null && b.transcriptStart < end && b.transcriptEnd > start);
    const ids = [...new Set(controls.flatMap(b => b.mappedWordIds))];
    const source = withHuman.bindings.filter(b => b.mappedWordIds.some(id => ids.includes(id)));
    const exact = controls.length && controls[0].transcriptStart <= start && controls.at(-1).transcriptEnd >= end;
    const proof = exact ? correctionDependency({ start, end, quotedText: target, category: 'GRAMMAR', symbol: 'PREP' },
      humanControl.bindings, identity, unique, { transcript: gold.transcript }) : { decision: 'REQUIRE_SOURCE_VERIFICATION', reason: 'INEXACT_OR_MISSING_SOURCE_BOUNDARIES', wordIds: [] };
    const display = historicalReview.find(r => r.target === target && r.goldStart === start);
    const unresolvedRegions = new Set(controls.filter(b => !b.geometryUnique).map(b => b.regionId));
    const candidates = [...new Set([...controls, ...humanControl.bindings.filter(b => unresolvedRegions.has(b.regionId))].flatMap(b => b.candidateWordIds))];
    let candidateDependency = { decision: 'REQUIRE_SOURCE_VERIFICATION', reason: 'INCOMPLETE_TARGET_MAPPING', publishable: false };
    if (proof.decision === 'ALLOW_OFFLINE_BINDING' && source.length
      && ids.every(id => source.some(b => b.mappedWordIds.includes(id)))) {
      const first = Math.min(...source.map(b => b.transcriptStart)), last = Math.max(...source.map(b => b.transcriptEnd));
      candidateDependency = correctionDependency({ start: first, end: last, quotedText: reader.activeTranscript.slice(first, last),
        category: 'GRAMMAR', symbol: 'PREP' }, withHuman.bindings, identity, unique, { transcript: reader.activeTranscript });
    }
    targetRows.push({ target, occurrence: ++occurrence, start, end,
      google: display?.google || controls.map(b => b.googleText).join(' '), gpt: display?.gpt || source.map(b => b.sourceText).join(' '),
      readingDisplayProvenance: 'retained diagnostic alignment only; never used to choose geometry',
      controlStates: controls.map(b => b.state), candidateStates: source.map(b => b.state),
      wordIds: ids, uncertainCandidateWordIds: candidates.filter(id => !ids.includes(id)), polygons: controls.flatMap(b => b.mappedPolygons),
      localAlignmentStatus: controls.length && controls.every(b => b.geometryUnique) ? 'UNIQUE_LOCAL_MAPPING' : 'LOCAL_MAPPING_UNCERTAIN',
      humanControlBinding: proof, futureOfflineBinding: candidateDependency,
      verificationState: candidateDependency.decision === 'ALLOW_OFFLINE_BINDING' ? 'VERIFIED_SOURCE_OFFLINE_HUMAN_BACKED' : 'OCR_UNCERTAIN',
      polygonStatus: controls.length && controls.every(b => b.geometryUnique) ? 'CURRENT_NATIVE_POLYGONS_UNCHANGED' : 'AMBIGUOUS_EXTENT_NOT_SELECTED',
      publishable: false });
  }
}
write('target-review.json', targetRows);
const summary = { providerCalls: 0, sourceImageSha256: gold.imageSha256, identity,
  before: { candidateGroups: 159, verifiedGroups: 0, uncertainGroups: 159 },
  providerOnly: providerOnly.summary, humanBackedCandidate: withHuman.summary, humanControl: humanControl.summary,
  visualLines: providerOnly.visualLines.length, acceptedAnchors: providerOnly.anchors.accepted.length,
  rawGeometryUnchanged: JSON.stringify(words) === before, elapsedMs: Date.now() - start,
  timings,
  explanation: 'Unique geometry is distinct from verified source. Only explicit offline human-gold witnesses can verify text in this replay. No provider agreement grants source authority.' };
write('summary.json', summary);
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
fs.writeFileSync(path.join(out, 'target-review.md'), '| Human target | Occurrence | Google reading | GPT reading | Local alignment | Unique native IDs | Uncertain native IDs (not selected) | Polygon status | Full candidate target state | Candidate dependency | Human-only control |\n|---|---|---|---|---|---|---|---|---|---|\n'
  + targetRows.map(r => `| ${escape(r.target)} | ${r.occurrence} | ${escape(r.google)} | ${escape(r.gpt)} | ${r.localAlignmentStatus} | ${r.wordIds.join(', ')} | ${r.uncertainCandidateWordIds.join(', ')} | ${r.polygonStatus} | ${r.verificationState} | ${r.futureOfflineBinding.decision} | ${r.humanControlBinding.decision} |`).join('\n') + '\n');
const bindingByWord = new Map(withHuman.bindings.flatMap(b => b.mappedWordIds.map(id => [id, b])));
const polygons = words.map(w => { const binding = bindingByWord.get(w.id), color = binding?.state === 'VERIFIED_SOURCE' ? 'green' : binding?.geometryUnique ? 'blue' : 'orange';
  return `<polygon points="${w.polygon.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"><title>${w.id}: ${binding?.state || 'unmapped'}</title></polygon>`;
}).join('\n');
fs.writeFileSync(path.join(out, 'geometry-review.html'), '<!doctype html><meta charset="utf-8"><title>Private phase 2 reconciliation</title><p>Green: offline human-backed source; blue: unique mapping with unverified/conflicting text; orange: unmapped/ambiguous. No production markers.</p><div style="position:relative;width:min(100%,1200px)"><img src="../source.png.jpeg" style="width:100%;display:block"><svg viewBox="0 0 1200 1600" style="position:absolute;inset:0;width:100%;height:100%">' + polygons + '</svg></div>');
console.log(JSON.stringify(summary, null, 2));
