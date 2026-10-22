'use strict';
const { sameIdentity, authorityFor } = require('./sourceAuthority');
const { REQUIRED } = require('../correctionLegendResolver.service');
const { validIdentity, digest } = require('./reconcile');
const LIMITS = Object.freeze({ concurrency: 2, queueLimit: 0, maxPerPage: 2, maxPerSubmission: 4,
  attemptTimeoutMs: 20000, sourceDeadlineMs: 40000, fallback: 'OCR_UNCERTAIN', automaticRetries: 0 });
const LITERAL_CODES = new Set(['SP', 'WC', 'WF', 'CAP']);
function selectVerification(region, corrections = []) {
  const reasons = [];
  if (Number.isFinite(region.wordConfidence) && region.wordConfidence < 0.8) reasons.push('LOW_WORD_CONFIDENCE');
  if (Number.isFinite(region.lineConfidence) && region.lineConfidence < 0.85) reasons.push('LOW_LINE_CONFIDENCE');
  for (const [key, reason] of Object.entries({ unstableOrder: 'UNSTABLE_ORDER', abnormalSymbolGaps: 'ABNORMAL_SYMBOL_GAPS',
    boundaryUncertain: 'PROMPT_BODY_BOUNDARY', crossedOut: 'CROSSED_OUT_OR_OVERWRITTEN',
    providerMismatch: 'PROVIDER_CANONICAL_MISMATCH', geometryAnomaly: 'GEOMETRY_ANOMALY' })) if (region[key]) reasons.push(reason);
  for (const c of corrections) {
    if (!region.strongSourceAuthority && LITERAL_CODES.has(c.symbol)) reasons.push('CORRECTION_LITERAL_SOURCE_REQUIRED');
    if (c.highImpact && !region.strongSourceAuthority) reasons.push('HIGH_IMPACT_UNCERTAIN_DEPENDENCY');
  }
  return { selected: reasons.length > 0, reasons: [...new Set(reasons)], asynchronous: true,
    publishable: false, priority: reasons.includes('HIGH_IMPACT_UNCERTAIN_DEPENDENCY') ? 0
      : reasons.includes('CORRECTION_LITERAL_SOURCE_REQUIRED') ? 1 : 2 };
}
function planVerification(regions, { submissionUsed = 0, pageUsed = {}, active = 0 } = {}) {
  if (!Number.isInteger(active) || active < 0 || !Number.isInteger(submissionUsed) || submissionUsed < 0 || regions.length > 400)
    return { admitted: [], deferred: [], limits: LIMITS, providerCalls: 0, error: 'INVALID_BUDGET_CONTEXT' };
  const slots = Math.max(0, Math.min(LIMITS.concurrency - active, LIMITS.maxPerSubmission - submissionUsed));
  const counts = { ...pageUsed }, admitted = [], deferred = [], seen = new Set();
  const submissionId = regions.find(r => validIdentity(r.identity))?.identity.submissionId;
  const requested = regions.map(r => ({ region: r, policy: selectVerification(r, r.corrections || []) }))
    .filter(r => r.policy.selected).sort((a, b) => a.policy.priority - b.policy.priority || String(a.region.id).localeCompare(String(b.region.id)));
  for (const item of requested) {
    if (!validIdentity(item.region.identity) || item.region.identity.submissionId !== submissionId) {
      deferred.push({ regionId: item.region.id, reason: 'INVALID_OR_FOREIGN_SOURCE_IDENTITY' }); continue;
    }
    const key = JSON.stringify([item.region.identity, item.region.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const page = `${item.region.identity?.fileId}:${item.region.identity?.pageNumber}`;
    if (admitted.length >= slots || (counts[page] || 0) >= LIMITS.maxPerPage) deferred.push({ regionId: item.region.id, reason: 'BUDGET_OR_CAPACITY' });
    else { admitted.push({ regionId: item.region.id, identity: item.region.identity, reasons: item.policy.reasons }); counts[page] = (counts[page] || 0) + 1; }
  }
  // This is an offline admission plan; it stores no image, creates no job and
  // does not enqueue deferred work. The existing production path is unchanged.
  return { admitted, deferred, limits: LIMITS, providerCalls: 0 };
}
function correctionDependency(correction, bindings, identity, attestations = [], context = {}) {
  const reject = reason => ({ decision: 'REQUIRE_SOURCE_VERIFICATION', reason, wordIds: [], polygons: [], publishable: false });
  if (!REQUIRED[correction.category]?.includes(correction.symbol)) return reject('UNSUPPORTED_LEGEND_CODE');
  if (typeof context.transcript !== 'string' || typeof correction.quotedText !== 'string') return reject('CURRENT_TRANSCRIPT_REQUIRED');
  const transcriptHash = digest(context.transcript);
  if (!Number.isInteger(correction.start) || !Number.isInteger(correction.end) || correction.start >= correction.end) return reject('EXACT_OFFSETS_REQUIRED');
  const relevant = bindings.filter(b => Number.isInteger(b.transcriptStart) && b.transcriptStart < correction.end
    && b.transcriptEnd > correction.start);
  if (context.transcript.slice(correction.start, correction.end) !== correction.quotedText) return reject('EXACT_QUOTE_REQUIRED');
  if (!relevant.length || relevant.some(b => !sameIdentity(b.identity, identity) || b.sourceTranscriptSha256 !== transcriptHash || !b.geometryUnique
    || b.state !== 'VERIFIED_SOURCE' || !authorityFor(b, identity, attestations).verified)) return reject('UNCERTAIN_SOURCE_DEPENDENCY');
  relevant.sort((a, b) => a.transcriptStart - b.transcriptStart);
  if (relevant[0].transcriptStart > correction.start || relevant.at(-1).transcriptEnd < correction.end) return reject('SPAN_BOUNDARIES_MISMATCH');
  if (relevant.some(b => context.transcript.slice(b.transcriptStart, b.transcriptEnd) !== b.sourceText)) return reject('STALE_TRANSCRIPT_BINDING');
  if (relevant.slice(1).some((b, i) => b.transcriptStart < relevant[i].transcriptEnd
    || !/^\s*$/u.test(context.transcript.slice(relevant[i].transcriptEnd, b.transcriptStart)))) return reject('UNVERIFIED_GAP_IN_SOURCE');
  const ids = relevant.flatMap(b => b.mappedWordIds);
  if (new Set(ids).size !== ids.length) return reject('DUPLICATE_OCCURRENCE');
  return { decision: 'ALLOW_OFFLINE_BINDING', reason: 'CURRENT_REVIEWED_SOURCE_AND_UNIQUE_GEOMETRY',
    wordIds: ids, polygons: relevant.flatMap(b => b.mappedPolygons), publishable: false };
}
module.exports = { LIMITS, LITERAL_CODES, selectVerification, planVerification, correctionDependency };
