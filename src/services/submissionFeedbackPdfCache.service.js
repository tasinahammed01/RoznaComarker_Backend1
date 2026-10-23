'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { ApiError } = require('../middlewares/error.middleware');
const logger = require('../utils/logger');
const PDF_RENDERER_VERSION = 'feedback-pdf-v3';
const PDF_ANNOTATION_VERSION = 'website-semantic-groups-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (typeof value.toObject === 'function') return stable(value.toObject());
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
  return value;
}
const digest = value => sha(JSON.stringify(stable(value)));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
// Fingerprint actual loaded source at process start; a release cannot reuse another renderer's artifact.
const rendererFingerprint = digest(['../modules/submissionFeedbackPdfGenerator.js', '../pdf/submissionFeedbackReportTemplate.js',
  '../pdf/submittedImageAnnotationLayout.js', '../pdf/websiteAnnotationPresentation.js', '../pdf/websiteAnnotationRules.generated.js',
  '../pdf/sample/submissionFeedbackReportViewModel.js', './submissionFeedbackReport.service.js', './correctionLegendResolver.service.js',
  './canonicalCorrectionRender.service.js', './canonicalCorrectionResponse.service.js', './teacherComments.service.js',
  '../utils/ocrTranscriptNormalizer.js', '../utils/legacyStudentSource.js']
  .map(file => [file, sha(fs.readFileSync(path.join(__dirname, file)))]));
const annotationFingerprint = sha(fs.readFileSync(path.join(__dirname, '../pdf/websiteAnnotationRules.generated.js')));
const pending = new Map();
function cacheIdentity({ submission, submissionFeedback, feedback, identity, marksVisible, audience, legendIdentity, fileIdentity }) {
  const pdfCorrectionIdentity = digest(pick(submission, ['writingCorrections', 'correctionSourceHash', 'correctionStatus',
    'correctionTranscriptLayoutVersion', 'correctionUpdatedAt', 'ocrStatus', 'ocrJobId', 'ocrPages', 'canonicalText', 'transcriptPages']));
  const pdfEvaluationIdentity = digest({ submissionFeedback, feedback,
    status: submission.evaluationStatus, teacherAssessmentVersion: submission.teacherAssessmentVersion });
  const contextIdentity = digest({ identity, marksVisible, audience, legendIdentity, fileIdentity,
    submissionId: String(submission._id), submittedAt: submission.submittedAt });
  const result = { pdfRendererVersion: PDF_RENDERER_VERSION, pdfAnnotationVersion: PDF_ANNOTATION_VERSION,
    rendererFingerprint, annotationFingerprint, pdfCorrectionIdentity, pdfEvaluationIdentity, contextIdentity };
  return { ...result, cacheKey: digest(result), scope: digest([String(submission._id), audience, marksVisible]) };
}
async function sourceFileIdentity(submission) {
  const files = submission.files?.length ? submission.files : submission.file ? [submission.file] : [];
  return Promise.all(files.map(async file => {
    const metadata = pick(file, ['_id', 'path', 'filename', 'originalName', 'type', 'width', 'height', 'updatedAt', 'size']);
    // Source pixels are immutable uploads. Stat identity also invalidates replaced local bytes.
    try { const stat = await fs.promises.stat(file.path); return { ...metadata, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
    catch { return { ...metadata, unavailable: true }; }
  }));
}
function cancelled(signal) { if (signal?.aborted) throw new ApiError(499, 'PDF request was cancelled.'); }
async function cachedSubmissionPdf({ identity, submissionId, generate, signal }) {
  cancelled(signal);
  const root = path.resolve(process.env.PDF_FEEDBACK_CACHE_DIR || path.join(os.tmpdir(), 'rozna-feedback-pdf-cache'));
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(root, `${identity.scope}.json`);
  let previous;
  try { previous = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); } catch { /* cache miss */ }
  let reason = !previous ? 'not_found' : previous.pdfRendererVersion !== identity.pdfRendererVersion
    || previous.rendererFingerprint !== identity.rendererFingerprint ? 'renderer_changed'
    : previous.pdfAnnotationVersion !== identity.pdfAnnotationVersion || previous.annotationFingerprint !== identity.annotationFingerprint ? 'annotation_changed'
      : previous.pdfCorrectionIdentity !== identity.pdfCorrectionIdentity ? 'corrections_changed'
        : previous.pdfEvaluationIdentity !== identity.pdfEvaluationIdentity ? 'evaluation_changed' : 'context_changed';
  const target = path.join(root, `${identity.cacheKey}.pdf`);
  if (previous && Object.entries(identity).every(([key, value]) => previous[key] === value)) {
    try {
      const bytes = await fs.promises.readFile(target);
      if (bytes.length > 5 && bytes.subarray(0, 5).toString() === '%PDF-' && sha(bytes) === previous.pdfSha256) {
        cancelled(signal);
        return logged({ ...previous, path: target, pdfCacheHit: true, pdfCacheMissReason: null });
      }
      reason = 'artifact_invalid';
    } catch { reason = 'artifact_missing'; }
  }
  if (pending.has(identity.cacheKey)) {
    const result = await pending.get(identity.cacheKey); cancelled(signal);
    return logged({ ...result, pdfCacheHit: true, pdfCacheMissReason: 'coalesced_generation' });
  }
  const task = (async () => {
    const temp = path.join(root, `${identity.cacheKey}.${crypto.randomUUID()}.tmp.pdf`);
    const manifestTemp = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    try {
      await generate(temp); cancelled(signal);
      const bytes = await fs.promises.readFile(temp);
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new ApiError(500, 'Generated PDF cache artifact is invalid.');
      const metadata = { ...identity, pdfGeneratedAt: new Date().toISOString(), pdfSha256: sha(bytes) };
      await fs.promises.chmod(temp, 0o600);
      await fs.promises.rename(temp, target);
      await fs.promises.writeFile(manifestTemp, JSON.stringify(metadata), { mode: 0o600 });
      await fs.promises.rename(manifestTemp, manifestPath);
      return { ...metadata, path: target, pdfCacheHit: false, pdfCacheMissReason: reason };
    } finally {
      await Promise.all([temp, manifestTemp].map(file => fs.promises.unlink(file).catch(() => {})));
    }
  })();
  pending.set(identity.cacheKey, task);
  try { return logged(await task); } finally { pending.delete(identity.cacheKey); }
  function logged(result) {
    logger.metric({ event: 'pdf_cache_result', submissionId: String(submissionId),
      ...pick(result, ['pdfCacheHit', 'pdfCacheMissReason', 'pdfRendererVersion', 'pdfAnnotationVersion',
        'pdfCorrectionIdentity', 'pdfEvaluationIdentity', 'pdfGeneratedAt']), rendererFingerprint });
    return result;
  }
}
module.exports = { PDF_RENDERER_VERSION, PDF_ANNOTATION_VERSION, rendererFingerprint, annotationFingerprint,
  cacheIdentity, cachedSubmissionPdf, sourceFileIdentity, digest };
