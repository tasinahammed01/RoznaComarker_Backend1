const { reconcileLocal } = require('../src/services/hybridSource/localReconciliation');
const { groupVisualLines } = require('../src/services/hybridSource/visualLines');
const { evidenceKey, reconcile: agreementDiagnostic } = require('../src/services/hybridSource/reconcile');
const { checkFaithfulness, acceptReaderEvidence } = require('../src/services/hybridSource/sourceAuthority');
const { selectVerification, planVerification, correctionDependency } = require('../src/services/hybridSource/verificationPolicy');
const { VERSION, CLASSES } = require('../src/services/hybridSource/contract');
const identity = { submissionId: 's', fileId: 'f', pageNumber: 1, runId: 'r', sourceSha256: 'a'.repeat(64),
  inputSha256: 'b'.repeat(64), width: 1200, height: 1400, orientation: 1 };
const line = (text, classification = 'STUDENT_ACTIVE_TEXT') => ({ text, classification, confidence: 1 });
const doc = lines => ({ version: VERSION, activeTranscript: lines.filter(l => l.classification === 'STUDENT_ACTIVE_TEXT').map(l => l.text).join('\n'), lines });
function native(rows) {
  let index = 0;
  return rows.flatMap((row, ri) => row.split(' ').map((text, wi) => {
    const x = 50 + wi * 100, y = 100 + ri * 70;
    return { text, confidence: 1, id: `word_f_1_${++index}`, polygon: [{ x, y }, { x: x + 70, y }, { x: x + 70, y: y + 30 }, { x, y: y + 30 }] };
  }));
}
function mapped(reader, words, options = {}) {
  return reconcileLocal(reader, words, identity, { googleIdentity: identity, coordinateSpace: 'display-image', ...options });
}
function reviewed(reader, words) {
  const raw = mapped(reader, words);
  const attestations = raw.bindings.filter(b => b.geometryUnique).map(b => ({ kind: 'HUMAN_REVIEWED',
    reviewer: 'synthetic human-reference fixture', reviewId: `review:${b.regionId}`, identity,
    evidenceKey: evidenceKey(identity), wordIds: b.mappedWordIds, classification: b.classification, text: b.sourceText }));
  return { result: mapped(reader, words, { trustedAttestations: attestations }), attestations };
}
test('local repeated ambiguity cannot suppress independently reviewed surrounding lines', () => {
  const words = native(['alpha beta gamma', 'the the', 'delta epsilon zeta']);
  const reader = doc(['alpha beta gamma', 'the', 'delta epsilon zeta'].map(t => line(t)));
  const before = JSON.stringify(words), { result } = reviewed(reader, words);
  expect(result.summary.verifiedGroups).toBe(6);
  expect(result.summary.ambiguousRegions).toBe(1);
  expect(result.bindings.filter(b => b.lineId === 'line_f_1_2').every(b => b.state === 'OCR_UNCERTAIN')).toBe(true);
  expect(JSON.stringify(words)).toBe(before);
});
test('two identical full lines remain ambiguous while independent lines survive', () => {
  const rows = ['alpha beta gamma', 'same the line', 'same the line', 'delta epsilon zeta'];
  const { result } = reviewed(doc(rows.map(t => line(t))), native(rows));
  expect(result.summary.verifiedGroups).toBe(6);
  expect(result.bindings.filter(b => ['line_f_1_2', 'line_f_1_3'].includes(b.lineId)).every(b => !b.geometryUnique)).toBe(true);
});
test('repeated the and and keep their physical occurrence IDs inside strong context', () => {
  const words = native(['alpha the the and and omega']);
  const { result } = reviewed(doc([line('alpha the the and and omega')]), words);
  expect(result.bindings.filter(b => b.state === 'VERIFIED_SOURCE').map(b => b.wordIds[0]))
    .toEqual(words.map(w => w.id));
});
test('two expectations occurrences bind to different current polygons', () => {
  const words = native(['first expectations remain here', 'second expectations stay there']);
  const reader = doc(['first expectations remain here', 'second expectations stay there'].map(t => line(t)));
  const { result, attestations } = reviewed(reader, words);
  const targets = result.bindings.filter(b => b.sourceText === 'expectations');
  expect(targets.map(b => b.wordIds[0])).toEqual(['word_f_1_2', 'word_f_1_6']);
  for (const b of targets) {
    const correction = { start: b.transcriptStart, end: b.transcriptEnd, quotedText: 'expectations', category: 'VOCABULARY', symbol: 'WC' };
    expect(correctionDependency(correction, result.bindings, identity, attestations, { transcript: reader.activeTranscript })).toMatchObject({
      decision: 'ALLOW_OFFLINE_BINDING', wordIds: b.wordIds, polygons: b.polygons, publishable: false });
  }
});
test.each(['PROMPT_OR_INSTRUCTION', 'HEADER_OR_TEMPLATE', 'STUDENT_CROSSED_OUT', 'WATERMARK_OR_CAMERA_BRANDING', 'PAGE_ARTIFACT'])(
  'retains raw %s evidence while excluding active marker authority', classification => {
    const rows = ['Which idea matters?', 'alpha beta gamma'];
    const result = mapped(doc([line(rows[0], classification), line(rows[1])]), native(rows));
    expect(result.bindings.filter(b => b.classification === classification).every(b => b.state === 'OCR_ARTIFACT' && !b.wordIds.length)).toBe(true);
    expect(result.bindings.filter(b => b.classification === classification).every(b => b.classificationAuthority === 'READER_CANDIDATE')).toBe(true);
    expect(result.visualLines[0].text).toBe(rows[0]);
  });
test.each(['Which idea matters?', 'Why do people', 'The question fragment'])('ordinary/cropped prompt %s is not dictionary-classified as an answer', prompt => {
  const words = native([prompt, 'alpha beta gamma']);
  words.slice(0, 3).forEach(w => w.polygon.forEach(p => { p.y -= 99; }));
  const result = mapped(doc([line(prompt, 'PROMPT_OR_INSTRUCTION'), line('alpha beta gamma')]), words);
  expect(result.bindings.filter(b => b.lineId === 'line_f_1_1').every(b => b.boundaryReviewRequired && !b.wordIds.length)).toBe(true);
});
test('a model calling top prompt active gains no source authority', () => {
  const result = mapped(doc([line('Which idea matters?'), line('alpha beta gamma')]), native(['Which idea matters?', 'alpha beta gamma']));
  expect(result.summary.verifiedGroups).toBe(0);
  expect(result.summary.uniquelyMappedGroups).toBe(6);
});
test('nearby crossed-out word does not steal the active span or invalidate anchors', () => {
  const words = native(['alpha beta gamma deleted delta epsilon zeta']);
  const { result } = reviewed(doc([line('alpha beta gamma'), line('deleted', 'STUDENT_CROSSED_OUT'), line('delta epsilon zeta')]), words);
  expect(result.summary.verifiedGroups).toBe(6);
  expect(result.bindings.find(b => b.sourceText === 'deleted')).toMatchObject({ state: 'OCR_ARTIFACT', wordIds: [] });
});
test.each([
  [['alpha', 'do', "n't", 'omega', 'tail', 'end'], "alpha don't omega tail end"],
  [['alpha', "don't", 'omega', 'tail', 'end'], "alpha do n't omega tail end"],
  [['alpha', 'hello', ',', 'omega', 'tail', 'end'], 'alpha hello, omega tail end']
])('split/merge transforms are local and preserve native IDs: %j', (tokens, source) => {
  const { result } = reviewed(doc([line(source)]), native([tokens.join(' ')]));
  const merge = result.bindings.find(b => b.kind === 'tokenization');
  expect(merge).toMatchObject({ geometryUnique: true, state: 'VERIFIED_SOURCE' });
  expect(merge.wordIds.length).toBeGreaterThan(0);
});
test('split/merge without proven line context is withheld', () => {
  const result = mapped(doc([line("alpha don't omega")]), native(["alpha do n't omega"]));
  expect(result.summary.uniquelyMappedGroups).toBe(0);
});
test('reader line wrap preserves independent physical anchors and exact marker occurrence', () => {
  const words = native(['alpha beta gamma', 'delta epsilon zeta']);
  const { result, attestations } = reviewed(doc([line('alpha beta gamma delta epsilon zeta')]), words);
  expect(result.summary.verifiedGroups).toBe(6);
  const start = result.bindings.find(b => b.sourceText === 'gamma').transcriptStart;
  const end = result.bindings.find(b => b.sourceText === 'delta').transcriptEnd;
  const target = correctionDependency({ start, end, quotedText: 'gamma delta', category: 'GRAMMAR', symbol: 'PREP' }, result.bindings, identity, attestations,
    { transcript: 'alpha beta gamma delta epsilon zeta' });
  expect(target.wordIds).toEqual(['word_f_1_3', 'word_f_1_4']);
  expect(target.polygons).toEqual([words[2].polygon, words[3].polygon]);
});
test.each([['got rid off', 'got rid of'], ['relizing', 'realizing'], ['relizing', 'Relizing'], ['relizing', 'reliezing']])(
  'source normalization %s → %s is a failure, never an improvement credit', (reference, candidate) => {
    expect(checkFaithfulness(reference, candidate)).toMatchObject({ faithful: false, code: 'SOURCE_FAITHFULNESS_FAILURE' });
  });
test('preception remains faithful source spelling', () => expect(checkFaithfulness('preception', 'preception').faithful).toBe(true));
test.each([['social norms', 'social world'], ['body', 'heart']])('correlated wrong agreement %s / %s cannot certify source', (truth, error) => {
  const reader = doc([line(`alpha ${error} omega tail`)]), words = native([`alpha ${error} omega tail`]);
  const result = mapped(reader, words);
  expect(result.summary.uniquelyMappedGroups).toBeGreaterThan(0);
  expect(result.summary.verifiedGroups).toBe(0);
  expect(agreementDiagnostic(reader, words, identity).bindings.some(b => b.state === 'VERIFIED_SOURCE')).toBe(false);
  expect(checkFaithfulness(truth, error).faithful).toBe(false);
});
test.each(['runId', 'sourceSha256', 'inputSha256', 'fileId', 'pageNumber', 'orientation'])(
  'stale/foreign %s rejects current binding', key => {
    expect(() => mapped(doc([line('alpha beta gamma')]), native(['alpha beta gamma']), { googleIdentity: { ...identity, [key]: 'foreign' } }))
      .toThrow('STALE_EVIDENCE');
  });
test('foreign canonical IDs cannot be repaired by equal text', () => {
  const words = native(['alpha beta gamma']); words[1].id = 'word_other_1_2';
  const result = mapped(doc([line('alpha beta gamma')]), words);
  expect(result.summary.verifiedGroups).toBe(0);
  expect(result.bindings.some(b => b.mappedWordIds.includes('word_other_1_2'))).toBe(false);
});
test('oriented display pixels are used unchanged; encoded coordinates are refused', () => {
  const current = { ...identity, orientation: 6 }, words = native(['alpha beta gamma']), before = JSON.stringify(words);
  expect(reconcileLocal(doc([line('alpha beta gamma')]), words, current, { googleIdentity: current, coordinateSpace: 'display-image' }).summary.uniquelyMappedGroups).toBe(3);
  expect(() => reconcileLocal(doc([line('alpha beta gamma')]), words, current, { googleIdentity: current, coordinateSpace: 'encoded-image' })).toThrow('COORDINATE_SPACE');
  expect(JSON.stringify(words)).toBe(before);
});
test('overlap is rejected locally without rewriting polygons', () => {
  const words = native(['alpha beta gamma', 'delta epsilon zeta']);
  words[1].polygon = words[0].polygon.map(p => ({ ...p }));
  const lines = groupVisualLines(words, identity);
  expect(lines.lines[0].items.some(i => i.reasons.includes('OVERLAPPING_WORD_GEOMETRY'))).toBe(true);
  expect(mapped(doc([line('alpha beta gamma'), line('delta epsilon zeta')]), words).summary.uniquelyMappedGroups).toBe(3);
});
test('future reader evidence is accepted as evidence, never automatic truth', () => {
  const envelope = { version: 'independent-source-evidence-v1', readerId: 'future-reader', identity, lines: [] };
  expect(acceptReaderEvidence(envelope, identity)).toMatchObject({ accepted: true, authoritative: false });
  expect(acceptReaderEvidence({ ...envelope, identity: { ...identity, runId: 'old' } }, identity).accepted).toBe(false);
});
test.each(['SP', 'WC', 'WF', 'CAP'])('unverified literal %s selects verification', symbol => {
  expect(selectVerification({ strongSourceAuthority: false }, [{ symbol }])).toMatchObject({ selected: true, publishable: false });
});
test('bad English alone is never a trigger; source-evidence anomalies are', () => {
  expect(selectVerification({ badEnglish: true }).selected).toBe(false);
  for (const field of ['unstableOrder', 'abnormalSymbolGaps', 'boundaryUncertain', 'crossedOut', 'providerMismatch', 'geometryAnomaly'])
    expect(selectVerification({ [field]: true }).selected).toBe(true);
  expect(selectVerification({ wordConfidence: 0.5 }).selected).toBe(true);
  expect(selectVerification({ lineConfidence: 0.5 }).selected).toBe(true);
});
test('admission policy is bounded and never queues images or calls providers', () => {
  const regions = Array.from({ length: 20 }, (_, i) => ({ id: String(i), identity, wordConfidence: 0.1 }));
  const plan = planVerification(regions);
  expect(plan.admitted).toHaveLength(2); expect(plan.providerCalls).toBe(0);
  expect(planVerification(regions, { submissionUsed: 4 }).admitted).toHaveLength(0);
  expect(planVerification(regions, { active: 2 }).admitted).toHaveLength(0);
});
test('correction policy rejects stale authority and unsupported quotes', () => {
  const words = native(['alpha preception omega']), reader = doc([line('alpha preception omega')]);
  const { result, attestations } = reviewed(reader, words), b = result.bindings[1];
  const correction = { start: b.transcriptStart, end: b.transcriptEnd, quotedText: 'preception', category: 'MECHANICS', symbol: 'SP' };
  const context = { transcript: reader.activeTranscript };
  expect(correctionDependency(correction, result.bindings, identity, attestations, context).wordIds).toEqual(['word_f_1_2']);
  expect(correctionDependency(correction, result.bindings, { ...identity, runId: 'old' }, attestations, context).decision).toBe('REQUIRE_SOURCE_VERIFICATION');
  expect(correctionDependency({ ...correction, quotedText: 'perception' }, result.bindings, identity, attestations, context).decision).toBe('REQUIRE_SOURCE_VERIFICATION');
});
test('case-only correction marker targets the second case-sensitive physical occurrence', () => {
  const rows = ['Society alpha beta', 'society gamma delta'];
  const reader = doc(rows.map(t => line(t))), words = native(rows);
  const { result, attestations } = reviewed(reader, words);
  const b = result.bindings.find(b => b.sourceText === 'society');
  const decision = correctionDependency({ start: b.transcriptStart, end: b.transcriptEnd,
    quotedText: 'society', category: 'MECHANICS', symbol: 'CAP' }, result.bindings, identity, attestations,
  { transcript: reader.activeTranscript });
  expect(decision.wordIds).toEqual(['word_f_1_4']);
  expect(decision.polygons).toEqual([words[3].polygon]);
});
test('a correction cannot bridge an unverified literal gap using a fabricated quote', () => {
  const reader = doc([line('alpha hidden omega tail')]), words = native(['alpha hidden omega tail']);
  const { result, attestations } = reviewed(reader, words);
  const filtered = result.bindings.filter(b => b.sourceText !== 'hidden');
  const correction = { start: 0, end: 'alpha hidden omega'.length, quotedText: 'alpha hidden omega', category: 'GRAMMAR', symbol: 'PREP' };
  expect(correctionDependency(correction, filtered, identity, attestations, { transcript: reader.activeTranscript }).reason).toBe('UNVERIFIED_GAP_IN_SOURCE');
});
test('transcript changes invalidate exact marker dependencies even when the image/run match', () => {
  const reader = doc([line('alpha beta gamma')]), { result, attestations } = reviewed(reader, native(['alpha beta gamma']));
  expect(correctionDependency({ start: 0, end: 5, quotedText: 'alpha', category: 'MECHANICS', symbol: 'SP' },
    result.bindings, identity, attestations, { transcript: 'alpha beta changed' }).decision).toBe('REQUIRE_SOURCE_VERIFICATION');
});
test('negative budget counters cannot increase admission limits', () => {
  expect(planVerification([{ id: 'one', identity, wordConfidence: 0.1 }], { active: -5 }).admitted).toHaveLength(0);
});
test('unverified high-impact contextual claims depend on source verification', () => {
  expect(selectVerification({ strongSourceAuthority: false }, [{ symbol: 'DEV', highImpact: true }]).reasons)
    .toContain('HIGH_IMPACT_UNCERTAIN_DEPENDENCY');
});
test('third-reader coordinates cannot enter the source evidence contract', () => {
  expect(acceptReaderEvidence({ version: 'independent-source-evidence-v1', identity, readerId: 'future',
    lines: [{ ...line('alpha'), polygon: [] }] }, identity).accepted).toBe(false);
});
test.each([['norms', 'world'], ['body', 'heart']])('human-backed contradiction %s / %s defeats unanimous providers locally', (truth, error) => {
  const reader = doc([line(`alpha ${error} omega tail`)]), words = native([`alpha ${error} omega tail`]);
  const raw = mapped(reader, words);
  const attestations = raw.bindings.filter(b => b.geometryUnique).map(b => ({ kind: 'HUMAN_REVIEWED',
    identity, evidenceKey: evidenceKey(identity), reviewer: 'unit-reference', reviewId: 'independent-human',
    wordIds: b.mappedWordIds, classification: b.classification, text: b.sourceText === error ? truth : b.sourceText }));
  const result = mapped(reader, words, { trustedAttestations: attestations });
  expect(result.bindings.find(b => b.sourceText === error)).toMatchObject({
    state: 'OCR_UNCERTAIN', wordIds: [], authority: { reason: 'SOURCE_FAITHFULNESS_FAILURE' } });
  expect(result.summary.verifiedGroups).toBe(3);
});
test('self-crossing native polygons are not repaired into guessed rectangles', () => {
  const words = native(['alpha beta gamma']), original = words[1].polygon;
  words[1].polygon = [original[0], original[2], original[1], original[3]];
  expect(groupVisualLines(words, identity).rejected).toEqual(expect.arrayContaining([
    expect.objectContaining({ wordId: 'word_f_1_2', reasons: ['INVALID_POLYGON'] })]));
});
