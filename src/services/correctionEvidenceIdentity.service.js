'use strict';
const { hash } = require('../utils/assessmentInputIdentity');
const VERSION = 'correction-evidence-v1';
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
function ocrEvidenceHash(canonical, submission = {}) {
  return hash({ version: VERSION, text: canonical?.text || '', pages: (canonical?.pages || []).map(page => ({
    fileId: String(page.fileId), page: page.pageNumber, text: page.text,
    words: (page.words || []).map(w => ({ id: w.id, text: w.text, bbox: w.bbox, separatorBefore: w.separatorBefore }))
  })), provenance: (submission.ocrPages || []).map(p => ({ fileId: String(p.fileId), page: p.pageNumber || 1,
    sourceSha256: p.sourceSha256, inputSha256: p.ocrInputSha256, width: p.ocrImageWidth || p.width,
    height: p.ocrImageHeight || p.height, coordinateSpace: p.coordinateSpace, orientation: p.ocrExifOrientation })) });
}
function correctionFingerprint(correction, canonical, submission = {}) {
  const page = canonical?.pages?.find(p => String(p.fileId) === String(correction.fileId)
    && Number(p.pageNumber || 1) === Number(correction.page || 1));
  const stored = submission.ocrPages?.find(p => String(p.fileId) === String(correction.fileId)
    && Number(p.pageNumber || 1) === Number(correction.page || 1));
  const positions = new Map((page?.words || []).map((w, index) => [w.id, index]));
  // File IDs and job IDs deliberately do not own comparison identity across uploads.
  // Offsets/word positions plus source and page order distinguish repeated occurrences.
  return hash({ version: VERSION, sourceIdentity: stored?.sourceSha256 || submission.fileContentIdentity || null,
    sourceIdentityKind: stored?.sourceSha256 ? 'source-sha256' : submission.fileContentIdentity ? 'ordered-file-hashes' : 'transcript',
    transcript: hash(page?.text || canonical?.text || ''), pageOrder: page?.fileOrder ?? 0, page: correction.page || 1,
    category: correction.canonicalCategory || correction.category, symbol: correction.symbol,
    original: normalize(correction.quotedText || correction.originalText), suggestion: normalize(correction.suggestedText),
    start: correction.startChar - Number(page?.startChar || 0), end: correction.endChar - Number(page?.startChar || 0),
    evidencePositions: (correction.evidenceWordIds || correction.wordIds || []).map(id => positions.get(id) ?? null) });
}
function bindingFailure(correction, canonical, submission = {}) {
  const run = correction.ocrRunId || submission.correctionOcrJobId;
  if (run && (!submission.ocrJobId || String(run) !== String(submission.ocrJobId))) return 'ocr_run_mismatch';
  const evidence = correction.ocrEvidenceHash || submission.correctionOcrEvidenceHash;
  if (evidence && evidence !== ocrEvidenceHash(canonical, submission)) return 'ocr_evidence_mismatch';
  const ocrTime = new Date(submission.ocrUpdatedAt || 0).getTime();
  const correctionTime = new Date(correction.createdAt || submission.correctionUpdatedAt || 0).getTime();
  if (ocrTime > 0 && correctionTime > 0 && ocrTime > correctionTime) return 'correction_predates_ocr';
  return null;
}
function bindCorrections(corrections, canonical, submission) {
  const evidenceHash = ocrEvidenceHash(canonical, submission);
  return corrections.map(c => ({ ...c, correctionFingerprint: correctionFingerprint(c, canonical, submission),
    ocrEvidenceHash: evidenceHash, ...(submission.ocrJobId ? { ocrRunId: String(submission.ocrJobId) } : {}) }));
}
module.exports = { VERSION, ocrEvidenceHash, correctionFingerprint, bindingFailure, bindCorrections };
