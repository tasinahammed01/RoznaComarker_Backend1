'use strict';
const { createHash } = require('crypto');
const { MODEL, VERSION, PROMPT, schema, failure } = require('./contract');
const digest = value => createHash('sha256').update(value).digest('hex');
function evidenceKey(identity) {
  return digest(JSON.stringify(['source-binding-v2', VERSION, MODEL, digest(PROMPT), digest(JSON.stringify(schema)), identity.submissionId,
    identity.fileId, identity.pageNumber, identity.runId, identity.sourceSha256,
    identity.inputSha256, identity.width, identity.height, identity.orientation]));
}
function validIdentity(i) {
  return i && ['submissionId', 'fileId', 'runId'].every(k => typeof i[k] === 'string' && i[k].length > 0)
    && ['sourceSha256', 'inputSha256'].every(k => /^[a-f0-9]{64}$/.test(i[k] || ''))
    && Number.isInteger(i.pageNumber) && i.pageNumber > 0
    && Number.isInteger(i.width) && i.width > 0 && Number.isInteger(i.height) && i.height > 0
    && Number.isInteger(i.orientation) && i.orientation >= 1 && i.orientation <= 8;
}
function polygonValid(points, i) {
  if (!(Array.isArray(points) && points.length === 4 && points.every(p => Number.isFinite(p.x)
    && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= i.width && p.y <= i.height)
    && Math.max(...points.map(p => p.x)) > Math.min(...points.map(p => p.x))
    && Math.max(...points.map(p => p.y)) > Math.min(...points.map(p => p.y)))) return false;
  const cross = points.map((p, index) => {
    const q = points[(index + 1) % 4], r = points[(index + 2) % 4];
    return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
  });
  return cross.every(v => v > 0) || cross.every(v => v < 0);
}
function sourceTokens(reader) {
  const tokens = [];
  let activeOffset = 0;
  let activeLines = 0;
  reader.lines.forEach((line, lineIndex) => {
    const active = line.classification === 'STUDENT_ACTIVE_TEXT';
    if (active && activeLines++) activeOffset++;
    for (const match of line.text.matchAll(/\S+/gu)) tokens.push({ text: match[0], lineIndex,
      classification: line.classification, confidence: line.confidence,
      start: active ? activeOffset + match.index : null,
      end: active ? activeOffset + match.index + match[0].length : null });
    if (active) activeOffset += line.text.length;
  });
  return tokens;
}
// Global monotonic edit alignment. No case folding, punctuation removal, edit-distance
// word search or first-occurrence matching. Every equally optimal path is counted;
// ambiguity withholds ALL bindings on this page rather than selecting an occurrence.
function align(left, right) {
  const n = left.length, m = right.length;
  if (n > 600 || m > 600) throw failure('OCR_SOURCE_ALIGNMENT_LIMIT');
  const cells = Array.from({ length: n + 1 }, () => Array(m + 1));
  cells[0][0] = { cost: 0, ways: 1 };
  const join = (a, start, count) => a.slice(start, start + count).map(t => t.text).join('');
  for (let a = 0; a <= n; a++) for (let b = 0; b <= m; b++) {
    const cell = cells[a][b];
    if (!cell) continue;
    const edges = [];
    if (a < n) edges.push([1, 0, 1, 'deletion']);
    if (b < m) edges.push([0, 1, 1, 'insertion']);
    if (a < n && b < m) {
      const same = left[a].text === right[b].text;
      edges.push([1, 1, same ? 0 : 1, same ? 'exact' : 'substitution']);
      for (let count = 2; count <= 3; count++) {
        if (a + count <= n && join(left, a, count) === right[b].text) edges.push([count, 1, 0, 'tokenization']);
        if (b + count <= m && left[a].text === join(right, b, count)) edges.push([1, count, 0, 'tokenization']);
      }
    }
    for (const [da, db, cost, kind] of edges) {
      const next = cells[a + da][b + db], total = cell.cost + cost;
      if (!next || total < next.cost) cells[a + da][b + db] = { cost: total,
        ways: cell.ways, previous: [a, b], da, db, kind };
      else if (total === next.cost) next.ways = Math.min(2, next.ways + cell.ways);
    }
  }
  const operations = [];
  let a = n, b = m;
  while (a || b) {
    const cell = cells[a][b], [pa, pb] = cell.previous;
    operations.unshift({ kind: cell.kind, left: [pa, a], right: [pb, b] });
    a = pa; b = pb;
  }
  return { ambiguous: cells[n][m].ways > 1, distance: cells[n][m].cost, operations };
}
// Retained for historical/offline comparisons. New worker diagnostics use
// reconcileLocal. Agreement in this compatibility path is NOT source authority.
function reconcile(reader, googleWords, identity, options = {}) {
  if (!validIdentity(identity)) throw failure('OCR_SOURCE_IDENTITY');
  const source = sourceTokens(reader);
  const alignment = align(googleWords, source);
  const uniqueIds = new Set(googleWords.map(w => w.id)).size === googleWords.length;
  const bindings = alignment.operations.map(op => {
    const words = googleWords.slice(...op.left), tokens = source.slice(...op.right);
    const active = tokens.length && tokens.every(t => t.classification === 'STUDENT_ACTIVE_TEXT');
    const agreed = ['exact', 'tokenization'].includes(op.kind) && !alignment.ambiguous;
    const geometry = uniqueIds && words.length > 0 && words.every(w =>
      typeof w.id === 'string' && w.id.startsWith(`word_${identity.fileId}_${identity.pageNumber}_`)
      && polygonValid(w.polygon, identity));
    const confident = tokens.length && tokens.every(t => t.confidence >= 0.9)
      && words.every(w => Number.isFinite(w.confidence) && w.confidence >= 0.8);
    const excluded = tokens.length && tokens.every(t => !['STUDENT_ACTIVE_TEXT', 'UNCERTAIN'].includes(t.classification));
    const candidate = { geometryUnique: Boolean(agreed && geometry && confident),
      mappedWordIds: agreed && geometry && confident ? words.map(w => w.id) : [],
      classification: active ? 'STUDENT_ACTIVE_TEXT' : tokens[0]?.classification || 'UNCERTAIN',
      sourceText: tokens.map(t => t.text).join(' ') };
    const authority = require('./sourceAuthority').authorityFor(candidate, identity, options.trustedAttestations);
    const state = agreed && geometry && confident
      ? (active && authority.verified ? 'VERIFIED_SOURCE' : excluded ? 'OCR_ARTIFACT' : 'OCR_UNCERTAIN') : 'OCR_UNCERTAIN';
    return { ...candidate, authority, state, kind: op.kind, googleRange: op.left, sourceRange: op.right,
      sourceText: tokens.map(t => t.text).join(' '), googleText: words.map(w => w.text).join(' '),
      transcriptStart: active ? tokens[0].start : null, transcriptEnd: active ? tokens.at(-1).end : null,
      wordIds: state === 'VERIFIED_SOURCE' ? words.map(w => w.id) : [],
      polygons: state === 'VERIFIED_SOURCE' ? words.map(w => w.polygon) : [] };
  });
  return { identity: { ...identity }, evidenceKey: evidenceKey(identity), model: MODEL, version: VERSION,
    // A diagnostic state is NEVER permission to publish a machine correction.
    publishable: false, state: source.length ? 'SHADOW_ONLY' : 'SOURCE_UNREADABLE',
    alignment, bindings, classCounts: Object.fromEntries([...new Set(reader.lines.map(l => l.classification))]
      .map(c => [c, reader.lines.filter(l => l.classification === c).length])) };
}
function cropBounds(binding, words, identity) {
  // Crops derive only from the disputed aligned Google span plus physical neighbors.
  if (binding.kind !== 'substitution' || !binding.googleRange) return null;
  if (binding.mappingState && !binding.geometryUnique) return null;
  if (Array.isArray(binding.contextWordIds) && binding.mappedWordIds?.length) {
    const ordered = binding.contextWordIds.map(id => words.find(w => w.id === id));
    if (ordered.some(w => !w)) return null;
    const indices = ordered.map((w, i) => binding.mappedWordIds.includes(w.id) ? i : -1).filter(i => i >= 0);
    if (!indices.length) return null;
    const region = ordered.slice(Math.max(0, Math.min(...indices) - 1), Math.max(...indices) + 2);
    if (!region.every(w => polygonValid(w.polygon, identity))) return null;
    const points = region.flatMap(w => w.polygon);
    const left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))) - 12);
    const top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))) - 12);
    return { left, top, width: Math.min(identity.width, Math.ceil(Math.max(...points.map(p => p.x))) + 12) - left,
      height: Math.min(identity.height, Math.ceil(Math.max(...points.map(p => p.y))) + 12) - top };
  }
  const [start, end] = binding.googleRange;
  const neighborhood = words.slice(Math.max(0, start - 1), Math.min(words.length, end + 1));
  if (!neighborhood.length || !neighborhood.every(w => polygonValid(w.polygon, identity))) return null;
  const points = neighborhood.flatMap(w => w.polygon);
  const left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))) - 12);
  const top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))) - 12);
  return { left, top, width: Math.min(identity.width, Math.ceil(Math.max(...points.map(p => p.x))) + 12) - left,
    height: Math.min(identity.height, Math.ceil(Math.max(...points.map(p => p.y))) + 12) - top };
}
module.exports = { digest, evidenceKey, validIdentity, polygonValid, sourceTokens, align, reconcile, cropBounds };
