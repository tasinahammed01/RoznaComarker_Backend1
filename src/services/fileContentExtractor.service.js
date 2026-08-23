/**
 * Extracts worksheet text from PDF, DOCX, TXT, PNG, and JPEG uploads.
 * Text PDFs keep the inexpensive pdf-parse path; image-only PDFs are
 * rasterized page-by-page and passed through the worksheet OCR chain.
 */
'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const logger = require('../utils/logger');
const { MIN_TEXT_LENGTH, WorksheetOcrError, extractTextFromPages } = require('./worksheetOcr.service');

const SAFE_PDF_OCR_MESSAGE = "We couldn't read enough text from this PDF. Please try a text-based PDF, a clearer scan, or another file.";
const SAFE_FILE_MESSAGE = "We couldn't read enough text from this file. Please try a clearer image, a text-based PDF, or another file.";

function extractionError(code, internalMessage, userMessage = SAFE_FILE_MESSAGE) {
  return new WorksheetOcrError(code, internalMessage, userMessage);
}

async function extractFromPDF(buffer, options = {}) {
  let parsed;
  try {
    parsed = await (options.pdfParse || pdfParse)(buffer);
  } catch (error) {
    logger.warn({ message: 'Worksheet PDF text parsing failed', feature: 'worksheet_extract_structure', code: 'WORKSHEET_PDF_PARSE_FAILED' });
    throw extractionError('WORKSHEET_PDF_PARSE_FAILED', `PDF parsing failed: ${error?.code || error?.name || 'unknown'}`,
      'Could not read this PDF. It may be corrupted or password-protected.');
  }
  const text = String(parsed?.text || '').trim();
  if (text.length >= MIN_TEXT_LENGTH) return text;

  logger.info({ message: 'Worksheet PDF has insufficient embedded text; starting scanned-PDF OCR',
    feature: 'worksheet_extract_structure', code: 'WORKSHEET_PDF_TEXT_EMPTY' });
  let pages;
  try {
    // Keep the native canvas dependency off the normal upload path. This reuses
    // the production rasterizer already used by submission feedback reports.
    const rasterPdf = options.rasterPdf || require('./submissionFeedbackReport.service').rasterPdf;
    pages = await rasterPdf(buffer, options.rasterOptions || {});
  } catch (error) {
    logger.error({ message: 'Worksheet scanned-PDF rasterization failed', feature: 'worksheet_extract_structure', code: 'WORKSHEET_PDF_RASTER_FAILED' });
    throw extractionError('WORKSHEET_PDF_RASTER_FAILED', `PDF rasterization failed: ${error?.code || error?.name || 'unknown'}`,
      SAFE_PDF_OCR_MESSAGE);
  }
  if (!Array.isArray(pages) || !pages.length) {
    throw extractionError('WORKSHEET_PDF_RASTER_EMPTY', 'PDF rasterizer returned no pages.', SAFE_PDF_OCR_MESSAGE);
  }
  const ocrPages = pages.map((page, index) => ({
    pageNumber: Number(page.pageNumber) || index + 1,
    buffer: page.buffer,
    mimeType: page.mime || page.mimeType || 'image/jpeg',
  })).sort((a, b) => a.pageNumber - b.pageNumber);
  try {
    return await (options.extractTextFromPages || extractTextFromPages)(ocrPages, options.ocrOptions || {});
  } catch (error) {
    throw extractionError(error?.code || 'WORKSHEET_OCR_FAILED',
      `Scanned PDF OCR failed: ${error?.code || error?.name || 'unknown'}`, SAFE_PDF_OCR_MESSAGE);
  }
}

async function extractFromDOCX(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch (error) {
    logger.warn({ message: 'Worksheet DOCX extraction failed', feature: 'worksheet_extract_structure', code: 'WORKSHEET_DOCX_PARSE_FAILED' });
    throw extractionError('WORKSHEET_DOCX_PARSE_FAILED', `DOCX parsing failed: ${error?.code || error?.name || 'unknown'}`,
      'Could not read this DOCX. It may be corrupted.');
  }
}

async function extractFromTXT(buffer) {
  try { return buffer.toString('utf-8'); }
  catch (error) {
    throw extractionError('WORKSHEET_TXT_PARSE_FAILED', `Text decoding failed: ${error?.code || error?.name || 'unknown'}`,
      'Could not read this text file. Its encoding may not be supported.');
  }
}

async function extractFromImage(buffer, options = {}) {
  return (options.extractTextFromPages || extractTextFromPages)([{
    pageNumber: 1, buffer, mimeType: options.mimeType || 'image/jpeg',
  }], options.ocrOptions || {});
}

async function extractContent(buffer, mimeType, originalName, options = {}) {
  const ext = path.extname(originalName || '').toLowerCase();
  let extractor;
  let fileType;
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    extractor = extractFromPDF; fileType = 'PDF';
  } else if (['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'].includes(mimeType)
      || ['.docx', '.doc'].includes(ext)) {
    extractor = extractFromDOCX; fileType = 'DOCX';
  } else if (mimeType === 'text/plain' || ext === '.txt') {
    extractor = extractFromTXT; fileType = 'TXT';
  } else if (['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType)
      || ['.png', '.jpg', '.jpeg'].includes(ext)) {
    extractor = extractFromImage; fileType = 'Image (OCR)';
  } else {
    throw extractionError('WORKSHEET_FILE_TYPE_UNSUPPORTED', `Unsupported file type: ${mimeType}.`,
      'Invalid file type. Supported formats: PDF, DOCX, TXT, PNG, JPG.');
  }

  logger.info({ message: 'Worksheet file extraction started', feature: 'worksheet_extract_structure', fileType, mimeType });
  const text = await extractor(buffer, { ...options, mimeType });
  const trimmedText = String(text || '').trim();
  if (trimmedText.length < MIN_TEXT_LENGTH) {
    throw extractionError('WORKSHEET_TEXT_INSUFFICIENT', `${fileType} extraction returned insufficient text.`,
      fileType === 'PDF' ? SAFE_PDF_OCR_MESSAGE : SAFE_FILE_MESSAGE);
  }
  logger.info({ message: 'Worksheet file extraction completed', feature: 'worksheet_extract_structure',
    fileType, characterCount: trimmedText.length });
  return trimmedText;
}

function validateFile(file, maxSizeMB = 10) {
  const { originalname, mimetype, size } = file;
  if (size > maxSizeMB * 1024 * 1024) return { valid: false, error: `File size exceeds ${maxSizeMB}MB limit.` };
  if (size === 0) return { valid: false, error: 'File is empty.' };
  const allowedMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', 'text/plain', 'image/png', 'image/jpeg', 'image/jpg'];
  const allowedExtensions = ['.pdf', '.docx', '.doc', '.txt', '.png', '.jpg', '.jpeg'];
  const ext = path.extname(originalname).toLowerCase();
  if (!allowedMimeTypes.includes(mimetype) && !allowedExtensions.includes(ext)) {
    return { valid: false, error: 'Invalid file type. Supported formats: PDF, DOCX, TXT, PNG, JPG.' };
  }
  return { valid: true };
}

module.exports = { extractContent, validateFile, extractFromPDF, extractFromDOCX,
  extractFromTXT, extractFromImage, SAFE_PDF_OCR_MESSAGE, SAFE_FILE_MESSAGE };
