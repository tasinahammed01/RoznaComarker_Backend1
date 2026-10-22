'use strict';
const { evidenceKey } = require('./reconcile');
const IDENTITY_KEYS = ['submissionId', 'fileId', 'pageNumber', 'runId', 'sourceSha256', 'inputSha256', 'width', 'height', 'orientation'];
const sameIdentity = (a, b) => Boolean(a && b && IDENTITY_KEYS.every(k => a[k] === b[k]));
function checkFaithfulness(reference, candidate) {
  return { faithful: reference === candidate,
    code: reference === candidate ? 'SOURCE_FAITHFUL' : 'SOURCE_FAITHFULNESS_FAILURE', reference, candidate };
}
// Trusted attestations are supplied by internal authorized review code, never by
// the model's JSON or an unauthenticated request. No third reader self-certifies.
function authorityFor(binding, identity, attestations = []) {
  if (!binding.geometryUnique) return { verified: false, reason: 'GEOMETRY_NOT_UNIQUE' };
  if (!Array.isArray(attestations) || attestations.length > 2000) return { verified: false, reason: 'INVALID_AUTHORITY_EVIDENCE' };
  const currentKey = evidenceKey(identity);
  const spanKey = JSON.stringify(binding.mappedWordIds);
  const matches = attestations.filter(a => a && a.kind === 'HUMAN_REVIEWED'
    && typeof a.reviewer === 'string' && a.reviewer.trim() && typeof a.reviewId === 'string' && a.reviewId
    && sameIdentity(a.identity, identity) && a.evidenceKey === currentKey
    && JSON.stringify(a.wordIds) === spanKey
    && a.classification === binding.classification);
  if (!matches.length) return { verified: false, reason: 'INDEPENDENT_SOURCE_AUTHORITY_REQUIRED' };
  const exact = matches.filter(a => checkFaithfulness(a.text, binding.sourceText).faithful);
  if (exact.length !== 1 || matches.some(a => a.text !== binding.sourceText)) return {
    verified: false, reason: 'SOURCE_FAITHFULNESS_FAILURE' };
  return { verified: true, reason: 'HUMAN_REVIEWED_CURRENT_SPAN', reviewId: exact[0].reviewId };
}
// Provider-neutral evidence envelope for a future adapter, with NO provider calls
// and no geometry authority. Independence is metadata, never automatic truth.
function acceptReaderEvidence(envelope, identity) {
  if (!envelope || envelope.version !== 'independent-source-evidence-v1'
    || !sameIdentity(envelope.identity, identity) || typeof envelope.readerId !== 'string' || !envelope.readerId.trim()
    || !Array.isArray(envelope.lines) || envelope.lines.length > 400) return { accepted: false, authoritative: false };
  try {
    const { VERSION, validate } = require('./contract');
    validate(JSON.stringify({ version: VERSION, lines: envelope.lines,
      activeTranscript: envelope.lines.filter(l => l.classification === 'STUDENT_ACTIVE_TEXT').map(l => l.text).join('\n') }));
  } catch { return { accepted: false, authoritative: false }; }
  return { accepted: true, authoritative: false, readerId: envelope.readerId,
    reason: 'READER_OUTPUT_IS_EVIDENCE_NOT_SOURCE_TRUTH' };
}
module.exports = { IDENTITY_KEYS, sameIdentity, checkFaithfulness, authorityFor, acceptReaderEvidence };
