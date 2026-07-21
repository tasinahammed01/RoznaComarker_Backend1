'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createCanvas } = require('canvas');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const { buildSubmissionFeedbackReportViewModel } = require('../pdf/sample/submissionFeedbackReportViewModel');
const { getOfficialCorrectionLegend } = require('./correctionLegendCatalog.service');
const { ApiError } = require('../middlewares/error.middleware');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };
const objectId = (value) => String(value?._id || value || '');
const limit = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new ApiError(504, message)), ms); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); });

function safeFilePath(file) {
  const uploadsRoot = path.resolve(__dirname, '..', '..', (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads');
  const raw = String(file?.path || '').trim(); if (!raw) return null;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(__dirname, '..', '..', raw);
  if (!(candidate === uploadsRoot || candidate.startsWith(`${uploadsRoot}${path.sep}`))) return null;
  try { const realRoot = fs.realpathSync(uploadsRoot); const realCandidate = fs.realpathSync(candidate); return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`) ? realCandidate : null; } catch { return null; }
}

async function rasterPdf(buffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise; const pages = [];
  if (document.numPages > limit('PDF_MAX_UPLOADED_PAGES', 20)) throw new ApiError(413, 'The uploaded document contains too many pages for a report.');
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber); const viewport = page.getViewport({ scale: 1.6 }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    if (canvas.width > limit('PDF_MAX_IMAGE_DIMENSION', 12000) || canvas.height > limit('PDF_MAX_IMAGE_DIMENSION', 12000)) throw new ApiError(413, 'An uploaded page exceeds the safe image dimensions.');
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    pages.push({ pageNumber, dataUrl: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`, width: canvas.width, height: canvas.height });
  }
  return pages;
}

async function resolvePersistedPageAssets(files) {
  const byPageKey = {}; const metadataByPageKey = {};
  for (const file of files) {
    const fileId = objectId(file); const safePath = safeFilePath(file); if (!fileId || !safePath) continue;
    let buffer; try { buffer = await fs.promises.readFile(safePath); } catch { continue; }
    if (buffer.length > limit('PDF_MAX_DECODED_ASSET_BYTES', 25 * 1024 * 1024)) throw new ApiError(413, 'An uploaded file is too large for report rendering.');
    const extension = path.extname(String(file.originalName || file.filename || safePath)).toLowerCase(); const mime = MIME[extension]; if (!mime) continue;
    if (mime === 'application/pdf') {
      try { const pages = await rasterPdf(buffer); pages.forEach((page) => { const key = `${fileId}:${page.pageNumber}`; byPageKey[key] = page.dataUrl; metadataByPageKey[key] = { width: page.width, height: page.height, fileName: file.originalName || file.filename, fileType: mime }; }); } catch (error) { if (error instanceof ApiError) throw error; /* page-level fallback is intentional */ }
    } else {
      try { const sourceMetadata = await sharp(buffer).metadata(); if ((sourceMetadata.width || 0) > limit('PDF_MAX_IMAGE_DIMENSION', 12000) || (sourceMetadata.height || 0) > limit('PDF_MAX_IMAGE_DIMENSION', 12000)) throw new ApiError(413, 'An uploaded image exceeds the safe dimensions.'); const normalized = await sharp(buffer).rotate().png().toBuffer(); if (normalized.length > limit('PDF_MAX_DECODED_ASSET_BYTES', 25 * 1024 * 1024)) throw new ApiError(413, 'A normalized image is too large for report rendering.'); const dimensions = await sharp(normalized).metadata(); const key = `${fileId}:1`; byPageKey[key] = `data:image/png;base64,${normalized.toString('base64')}`; metadataByPageKey[key] = { width: dimensions.width || 0, height: dimensions.height || 0, fileName: file.originalName || file.filename, fileType: mime }; } catch (error) { if (error instanceof ApiError) throw error; /* page-level fallback is intentional */ }
    }
  }
  return { byPageKey, metadataByPageKey };
}

function safeDiagnostics(submission, transcriptPages, corrections, submittedPages) {
  const groups = {};
  corrections.forEach((correction) => { const key = `${correction.source || 'UNKNOWN'}|${correction.category || 'UNKNOWN'}|${objectId(correction.fileId)}|${Number(correction.page || 1)}`; groups[key] = (groups[key] || 0) + 1; });
  return { uploadedFileIds: (submission.files || []).map(objectId), transcriptPages: transcriptPages.map((page) => ({ fileId: objectId(page.fileId), pageNumber: Number(page.pageNumber) })), correctionGroups: groups, withWordIds: corrections.filter((c) => Array.isArray(c.wordIds) && c.wordIds.length).length, withBboxList: corrections.filter((c) => Array.isArray(c.bboxList) && c.bboxList.length).length, withGlobalOffsets: corrections.filter((c) => Number.isFinite(Number(c.startChar)) && Number.isFinite(Number(c.endChar))).length, assignedPerPage: submittedPages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber, count: page.corrections.length })) };
}

async function buildPersistedSubmissionFeedbackReport({ submission, submissionFeedback, feedback, identity, generatedAt }) {
  const startedAt = Date.now(); const canonical = buildCanonicalSubmissionTranscript(submission); const normalizedAt = Date.now(); const files = Array.isArray(submission.files) && submission.files.length ? submission.files : submission.file ? [submission.file] : [];
  if (canonical.pages.length > limit('PDF_MAX_UPLOADED_PAGES', 20)) throw new ApiError(413, 'This submission contains too many pages for a single report.');
  if (canonical.text.length > limit('PDF_MAX_TRANSCRIPT_CHARACTERS', 1000000)) throw new ApiError(413, 'The submission transcript is too large for report rendering.');
  if (!canonical.pages.length && ['pending', 'processing'].includes(String(submission.ocrStatus || ''))) throw new ApiError(409, 'Submission OCR is still processing.');
  if (!canonical.pages.length) throw new ApiError(409, 'A canonical transcript is not available for this submission.');
  const persistedCorrections = Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [];
  if (!persistedCorrections.length && ['pending', 'processing'].includes(String(submission.correctionStatus || ''))) throw new ApiError(409, 'Submission corrections are still processing.');
  if (!persistedCorrections.length && submission.correctionStatus === 'failed') throw new ApiError(409, 'Submission correction analysis is unavailable.');
  const assets = await withTimeout(resolvePersistedPageAssets(files), limit('PDF_ASSET_TIMEOUT_MS', 30000), 'Submission asset preparation timed out.'); const assetsAt = Date.now(); const transcriptPages = canonical.pages.map((page) => ({ ...page, ...(assets.metadataByPageKey[`${objectId(page.fileId)}:${Number(page.pageNumber)}`] || {}) }));
  const feedbackObject = submissionFeedback?.toObject ? submissionFeedback.toObject() : { ...(submissionFeedback || {}) }; const teacherObject = feedback?.toObject ? feedback.toObject() : { ...(feedback || {}) };
  const vm = buildSubmissionFeedbackReportViewModel({ generatedAt, identity, legend: getOfficialCorrectionLegend(), submission: { ...(submission.toObject ? submission.toObject() : submission), files: files.map(objectId), canonicalText: canonical.text, transcriptPages, imageDataByPageKey: assets.byPageKey }, evaluation: { ...feedbackObject, status: submission.evaluationStatus }, feedback: { ...feedbackObject, teacherComments: teacherObject.teacherComments || teacherObject.textFeedback || '', overrideReason: teacherObject.overrideReason } });
  return { viewModel: vm, diagnostics: { ...safeDiagnostics(submission, transcriptPages, Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [], vm.submittedPages), missingAssetCount: vm.submittedPages.filter((page) => !page.imageDataUrl).length }, timings: { normalizationMs: normalizedAt - startedAt, assetResolutionMs: assetsAt - normalizedAt, viewModelMs: Date.now() - assetsAt, totalMs: Date.now() - startedAt } };
}

module.exports = { safeFilePath, resolvePersistedPageAssets, buildPersistedSubmissionFeedbackReport, _test: { rasterPdf } };
