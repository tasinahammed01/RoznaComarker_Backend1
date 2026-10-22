'use strict';
const { align, sourceTokens, validIdentity, evidenceKey, digest } = require('./reconcile');
const { validate, VERSION, MODEL, failure } = require('./contract');
const { groupVisualLines } = require('./visualLines');
const { sameIdentity, authorityFor } = require('./sourceAuthority');
const EXCLUDED = new Set(['PROMPT_OR_INSTRUCTION', 'HEADER_OR_TEMPLATE', 'STUDENT_CROSSED_OUT',
  'WATERMARK_OR_CAMERA_BRANDING', 'TEACHER_MARK', 'PAGE_ARTIFACT']);

function anchorsFor(lines, tokens) {
  const candidates = [], sourceIndex = new Map(), visualIndex = new Map();
  for (let j = 0; j + 2 < tokens.length; j++) {
    const group = tokens.slice(j, j + 3);
    if (group.some(t => t.lineIndex !== group[0].lineIndex || t.classification !== group[0].classification)) continue;
    const key = JSON.stringify(group.map(t => t.text));
    if (!sourceIndex.has(key)) sourceIndex.set(key, []);
    sourceIndex.get(key).push(j);
  }
  lines.forEach((line, li) => {
    for (let wi = 0; wi + 2 < line.items.length; wi++) {
      if (line.items.slice(wi, wi + 3).some(i => i.reasons.length)) continue;
      const key = JSON.stringify(line.items.slice(wi, wi + 3).map(i => i.word.text));
      if (!visualIndex.has(key)) visualIndex.set(key, []);
      visualIndex.get(key).push({ li, wi });
    }
  });
  for (const [key, visual] of visualIndex) {
    const source = sourceIndex.get(key);
    if (visual.length === 1 && source?.length === 1) candidates.push({ ...visual[0], si: source[0], length: 3 });
  }
  candidates.sort((a, b) => a.li - b.li || a.wi - b.wi);
  const bad = new Set();
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i], b = candidates[j];
    if (b.si <= a.si || (a.li === b.li && b.wi < a.wi + 3 && b.si - a.si !== b.wi - a.wi)
      || (a.li === b.li && b.wi >= a.wi + 3 && b.si < a.si + 3)
      || (a.li !== b.li && b.si < a.si + 3)) { bad.add(i); bad.add(j); }
  }
  return { accepted: candidates.filter((_, i) => !bad.has(i)), rejected: bad.size };
}

function reconcileLocal(reader, googleWords, identity, options = {}) {
  if (!validIdentity(identity) || !sameIdentity(identity, options.googleIdentity)) throw failure('OCR_SOURCE_STALE_EVIDENCE');
  if (options.coordinateSpace !== 'display-image') throw failure('OCR_SOURCE_COORDINATE_SPACE_UNPROVEN');
  validate(JSON.stringify(reader));
  const source = sourceTokens(reader), visual = groupVisualLines(googleWords, identity);
  const anchors = anchorsFor(visual.lines, source);
  const bindings = [], regions = [];
  const matchedSource = new Set();
  const add = (line, items, start, end, kind, unique, reason, regionId) => {
    const tokens = source.slice(start, end);
    for (let i = start; i < end; i++) matchedSource.add(i);
    const classes = new Set(tokens.map(t => t.classification));
    const classification = classes.size === 1 ? tokens[0].classification : 'UNCERTAIN';
    const active = classification === 'STUDENT_ACTIVE_TEXT';
    const geometryUnique = unique && items.length > 0 && items.every(i => !i.reasons.length);
    const sourceText = active && tokens.length
      ? reader.activeTranscript.slice(tokens[0].start, tokens.at(-1).end) : tokens.map(t => t.text).join(' ');
    const mappedWordIds = geometryUnique ? items.map(i => i.word.id) : [];
    const indices = items.map(i => i.index);
    const binding = { regionId, lineId: line?.id || null, kind, classification, geometryUnique,
      mappingState: geometryUnique ? 'UNIQUE_LOCAL_MAPPING' : 'LOCAL_MAPPING_UNCERTAIN',
      mappedWordIds, mappedPolygons: geometryUnique ? items.map(i => i.word.polygon) : [],
      candidateWordIds: items.map(i => i.word.id), candidatePolygons: items.map(i => i.word.polygon),
      googleRange: indices.length ? [Math.min(...indices), Math.max(...indices) + 1] : [0, 0],
      sourceRange: [start, end], sourceText, googleText: items.map(i => i.word.text).join(' '),
      transcriptStart: active && tokens.length ? tokens[0].start : null,
      transcriptEnd: active && tokens.length ? tokens.at(-1).end : null,
      contextWordIds: line ? line.items.map(i => i.word.id) : [],
      reasons: [...new Set([...(reason ? [reason] : []), ...items.flatMap(i => i.reasons)])],
      evidenceKey: evidenceKey(identity), sourceTranscriptSha256: digest(reader.activeTranscript), identity: { ...identity }, publishable: false };
    const firstLine = visual.lines[0], lastLine = visual.lines.at(-1);
    binding.boundaryReviewRequired = Boolean(line && (line === firstLine || line === lastLine)
      && (line.center < identity.height * 0.035 || line.center > identity.height * 0.965
        || (line === firstLine && visual.lines[1] && visual.lines[1].center - line.center > 1.8 * Math.max(line.height, visual.lines[1].height))));
    const authority = authorityFor(binding, identity, options.trustedAttestations);
    binding.authority = authority;
    binding.classificationAuthority = authority.verified ? 'HUMAN_REVIEWED' : 'READER_CANDIDATE';
    binding.semanticExclusionCandidate = EXCLUDED.has(classification);
    binding.state = EXCLUDED.has(classification) && geometryUnique ? 'OCR_ARTIFACT'
      : authority.verified && active ? 'VERIFIED_SOURCE' : 'OCR_UNCERTAIN';
    binding.wordIds = binding.state === 'VERIFIED_SOURCE' ? [...mappedWordIds] : [];
    binding.polygons = binding.state === 'VERIFIED_SOURCE' ? [...binding.mappedPolygons] : [];
    bindings.push(binding);
  };
  const handleRegion = (line, left, right, sourceStart, sourceEnd, regionId) => {
    const items = line.items.slice(left, right), tokens = source.slice(sourceStart, sourceEnd);
    if (!items.length && !tokens.length) return;
    if (items.length > 80 || tokens.length > 80) {
      add(line, items, sourceStart, sourceEnd, 'unresolved', false, 'LOCAL_REGION_LIMIT', regionId); return;
    }
    const result = align(items.map(i => i.word), tokens);
    const repeated = values => new Set(values).size !== values.length;
    regions.push({ regionId, lineId: line.id, ambiguous: result.ambiguous, sourceRange: [sourceStart, sourceEnd],
      containsRepeatedToken: repeated(items.map(i => i.word.text)) || repeated(tokens.map(t => t.text)) });
    // Only local alignment is consulted. No page-wide ambiguity veto.
    for (const op of result.operations) add(line, items.slice(...op.left),
      sourceStart + op.right[0], sourceStart + op.right[1], op.kind,
      !result.ambiguous && op.left[1] > op.left[0] && op.right[1] > op.right[0],
      result.ambiguous ? 'LOCAL_ALIGNMENT_AMBIGUOUS' : null, regionId);
  };
  visual.lines.forEach((line, li) => {
    const local = anchors.accepted.filter(a => a.li === li);
    if (!local.length) {
      // A short/changed physical line may be bounded by immediately adjacent
      // anchored lines. No search for the closest same-text word is performed.
      const previous = anchors.accepted.filter(a => a.li < li).at(-1);
      const next = anchors.accepted.find(a => a.li > li);
      if (previous && next && previous.li === li - 1 && next.li === li + 1) {
        const start = source.findIndex((t, i) => i > previous.si + 2 && t.lineIndex > source[previous.si].lineIndex);
        let end = next.si;
        while (end > 0 && source[end - 1].lineIndex === source[next.si].lineIndex) end--;
        if (start >= 0 && start <= end) handleRegion(line, 0, line.items.length, start, end, `${line.id}:bounded`);
        else add(line, line.items, 0, 0, 'unresolved', false, 'NO_PROVEN_LINE_BOUNDARIES', `${line.id}:unmapped`);
      } else add(line, line.items, 0, 0, 'unresolved', false, 'NO_UNIQUE_LINE_ANCHOR', `${line.id}:unmapped`);
      return;
    }
    // Require all anchors on this physical line to be consistent with one ordered
    // reader-line interval. Segments between anchors can contain excluded writing.
    let sourceStart = local[0].si;
    while (sourceStart > 0 && source[sourceStart - 1].lineIndex === source[local[0].si].lineIndex) sourceStart--;
    let sourceEnd = local.at(-1).si + 3;
    while (sourceEnd < source.length && source[sourceEnd].lineIndex === source[local.at(-1).si + 2].lineIndex) sourceEnd++;
    const previousAnchor = anchors.accepted.filter(a => a.li < li).at(-1);
    const nextAnchor = anchors.accepted.find(a => a.li > li);
    // A reader paragraph/line may wrap over several physical lines. Keep exact
    // anchors on each line; do not guess which unanchored edge belongs to it.
    if (previousAnchor && sourceStart < previousAnchor.si + 3) sourceStart = local[0].si;
    if (nextAnchor && sourceEnd > nextAnchor.si) sourceEnd = local.at(-1).si + 3;
    const points = new Map();
    for (const a of local) for (let k = 0; k < 3; k++) points.set(a.wi + k, a.si + k);
    const ordered = [...points].sort((a, b) => a[0] - b[0]);
    let wi = 0, si = sourceStart, interval = 0;
    for (const [wordIndex, sourceIndex] of ordered) {
      handleRegion(line, wi, wordIndex, si, sourceIndex, `${line.id}:region${interval++}`);
      add(line, [line.items[wordIndex]], sourceIndex, sourceIndex + 1, 'exact', true, null, `${line.id}:anchor${wordIndex}`);
      wi = wordIndex + 1; si = sourceIndex + 1;
    }
    handleRegion(line, wi, line.items.length, si, sourceEnd, `${line.id}:region${interval}`);
  });
  // Reader text with no unique physical line keeps explicit uncertainty and raw
  // classification. No image coordinates are invented for it.
  for (let i = 0; i < source.length; i++) if (!matchedSource.has(i)) add(null, [], i, i + 1,
    'unmapped-source', false, 'NO_PROVEN_PHYSICAL_REGION', `source:${source[i].lineIndex}`);
  for (const rejected of visual.rejected) add(null, [{ ...rejected, word: googleWords[rejected.index] }],
    0, 0, 'invalid-geometry', false, 'INVALID_GEOMETRY', 'rejected');
  // A token/word occurrence may belong to only one local proof. Conflicting
  // boundary proofs invalidate only their participating groups, never the page.
  const owners = new Map(), conflicts = new Set();
  bindings.forEach((b, index) => {
    if (!b.geometryUnique) return;
    const keys = b.mappedWordIds.map(id => `word:${id}`);
    for (let i = b.sourceRange[0]; i < b.sourceRange[1]; i++) keys.push(`source:${i}`);
    for (const key of keys) {
      if (owners.has(key)) { conflicts.add(index); conflicts.add(owners.get(key)); }
      else owners.set(key, index);
    }
  });
  for (const index of conflicts) Object.assign(bindings[index], { geometryUnique: false,
    mappingState: 'LOCAL_MAPPING_UNCERTAIN', state: 'OCR_UNCERTAIN', mappedWordIds: [], mappedPolygons: [],
    wordIds: [], polygons: [], authority: { verified: false, reason: 'OVERLAPPING_LOCAL_PROOFS' },
    reasons: [...bindings[index].reasons, 'OVERLAPPING_LOCAL_PROOFS'] });
  const ambiguousLines = new Set(regions.filter(r => r.ambiguous).map(r => r.lineId));
  const summary = { nativeWords: googleWords.length, candidateGroups: bindings.length,
    uniquelyMappedGroups: bindings.filter(b => b.geometryUnique).length,
    verifiedGroups: bindings.filter(b => b.state === 'VERIFIED_SOURCE').length,
    locallyUncertainGroups: bindings.filter(b => b.state === 'OCR_UNCERTAIN').length,
    excludedGroups: bindings.filter(b => b.state === 'OCR_ARTIFACT').length,
    mappingUncertainGroups: bindings.filter(b => !b.geometryUnique).length,
    authorityUncertainMappedGroups: bindings.filter(b => b.geometryUnique && b.state === 'OCR_UNCERTAIN').length,
    verifiedOutsideAmbiguousLines: bindings.filter(b => b.state === 'VERIFIED_SOURCE' && !ambiguousLines.has(b.lineId)).length,
    verifiedInsidePartlyAmbiguousLines: bindings.filter(b => b.state === 'VERIFIED_SOURCE' && ambiguousLines.has(b.lineId)).length,
    ambiguousRegions: regions.filter(r => r.ambiguous).length,
    repeatedTokenAmbiguousRegions: regions.filter(r => r.ambiguous && r.containsRepeatedToken).length };
  return { version: 'local-source-reconciliation-v2', sourceSchemaVersion: VERSION, model: MODEL,
    identity: { ...identity }, evidenceKey: evidenceKey(identity), publishable: false, state: 'SHADOW_ONLY',
    alignment: { ambiguous: summary.ambiguousRegions > 0, scope: 'local-regions-only' },
    visualLines: visual.lines.map(l => ({ id: l.id, wordIds: l.wordIds, text: l.text, center: l.center, height: l.height })),
    anchors, regions, bindings, summary,
    classCounts: Object.fromEntries([...new Set(reader.lines.map(l => l.classification))].map(c => [c, reader.lines.filter(l => l.classification === c).length])) };
}
module.exports = { anchorsFor, reconcileLocal };
