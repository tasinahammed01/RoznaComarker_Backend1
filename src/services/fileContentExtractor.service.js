/**
 * Extracts worksheet text from PDF, DOCX, TXT, PNG, and JPEG uploads.
 * Text PDFs keep the inexpensive pdf-parse path; image-only PDFs are
 * rasterized page-by-page and passed through the worksheet OCR chain.
 */
'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const sanitizeHtml = require('sanitize-html');
const path = require('path');
const logger = require('../utils/logger');
const { MIN_TEXT_LENGTH, WorksheetOcrError, extractTextFromPages } = require('./worksheetOcr.service');

const SAFE_PDF_OCR_MESSAGE = "We couldn't read enough text from this PDF. Please try a text-based PDF, a clearer scan, or another file.";
const SAFE_FILE_MESSAGE = "We couldn't read enough text from this file. Please try a clearer image, a text-based PDF, or another file.";
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

function cleanText(value) {
  return String(value || '').replace(/\r\n?/gu, '\n').replace(/[\t\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n').replace(/[ ]{2,}/gu, ' ').trim();
}

function removeRepeatedMarginLines(lines) {
  const counts = new Map();
  lines.forEach((line) => {
    const key = line.toLowerCase();
    if (line.length >= 3 && line.length <= 80) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return lines.filter((line) => {
    const repeated = (counts.get(line.toLowerCase()) || 0) >= 3;
    const obviousMargin = /^(?:page\s+\d+(?:\s+of\s+\d+)?|header\s*:|footer\s*:)/iu.test(line);
    return !(repeated && obviousMargin);
  });
}

function assertDocumentQuality(document, fileType) {
  const text = String(document?.plainText || '').trim();
  if (!text) {
    throw extractionError(fileType === 'DOCX' ? 'WORKSHEET_DOCX_TEXT_EMPTY' : 'WORKSHEET_TEXT_INSUFFICIENT',
      `${fileType} extraction returned no text.`, fileType === 'DOCX'
        ? 'No readable worksheet text was found in this Word document.' : SAFE_FILE_MESSAGE);
  }
  const controlCount = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu) || []).length;
  const meaningfulTokens = text.match(/[\p{L}\p{N}]{2,}/gu) || [];
  if (text.length < MIN_TEXT_LENGTH || controlCount / text.length > 0.2 || meaningfulTokens.length === 0) {
    throw extractionError('WORKSHEET_TEXT_LOW_QUALITY', `${fileType} extraction failed minimum quality checks.`,
      fileType === 'DOCX' ? 'No readable worksheet text was found in this Word document.' : SAFE_FILE_MESSAGE);
  }
}

function normalizePlainText(value) {
  const lines = cleanText(value).split('\n').map((line) => line.trim());
  const withoutRepeatedMargins = removeRepeatedMarginLines(lines.filter(Boolean));
  return withoutRepeatedMargins.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function blocksToPlainText(blocks) {
  return blocks.map((block) => {
    if (block.type === 'heading') return `[HEADING ${block.level}] ${block.text}`;
    if (block.type === 'list-item') return `${block.marker} ${block.text}`;
    if (block.type === 'table-row') return `TABLE ROW ${block.row}: ${block.cells.join(' | ')}`;
    return block.text;
  }).filter(Boolean).join('\n\n');
}

function normalizedTextDocument(value, sourceType) {
  const plainText = normalizePlainText(value);
  return {
    sourceType,
    title: null,
    blocks: plainText ? plainText.split(/\n{2,}/u).map((text) => ({ type: 'paragraph', text })) : [],
    plainText,
    stats: { tables: 0, characters: plainText.length },
  };
}

function normalizedDocxFromHtml(html) {
  const safeHtml = sanitizeHtml(String(html || ''), {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ol', 'ul', 'li', 'table', 'thead',
      'tbody', 'tr', 'th', 'td', 'strong', 'b', 'em', 'i', 'br'],
    allowedAttributes: {},
  });
  const $ = cheerio.load(safeHtml, null, false);
  const blocks = [];
  const readableText = (node) => (node && typeof node.contents === 'function' ? node : $(node)).contents().map((_index, child) => {
    if (child.type === 'text') return child.data || '';
    const tag = String(child.tagName || '').toLowerCase();
    if (tag === 'br') return '\n';
    const nested = readableText(child);
    return tag === 'strong' || tag === 'b' ? `**${nested}**` : nested;
  }).get().join('');
  const addText = (type, text, extra = {}) => {
    const normalized = cleanText(text);
    if (normalized) blocks.push({ type, text: normalized, ...extra });
  };
  const addList = (listNode, depth = 0) => {
    const list = $(listNode);
    const ordered = String(listNode.tagName || '').toLowerCase() === 'ol';
    list.children('li').each((index, item) => {
      const itemWithoutNestedLists = $(item).clone().children('ol,ul').remove().end();
      addText('list-item', readableText(itemWithoutNestedLists), {
        marker: ordered ? `${index + 1}.` : '-', ordered, depth,
      });
      $(item).children('ol,ul').each((_nestedIndex, nested) => addList(nested, depth + 1));
    });
  };

  $.root().children().each((_index, element) => {
    const tag = String(element.tagName || '').toLowerCase();
    const node = $(element);
    if (/^h[1-6]$/u.test(tag)) {
      addText('heading', readableText(node), { level: Number(tag.slice(1)) });
    } else if (tag === 'p') {
      addText('paragraph', readableText(node));
    } else if (tag === 'ol' || tag === 'ul') {
      addList(element);
    } else if (tag === 'table') {
      const rows = node.find('tr').toArray();
      const headers = rows.length ? $(rows[0]).children('th').map((_i, cell) => cleanText(readableText($(cell)))).get() : [];
      rows.forEach((row, rowIndex) => {
        const values = $(row).children('th,td').map((_i, cell) => cleanText(readableText($(cell)))).get();
        if (!values.some(Boolean)) return;
        const cells = rowIndex > 0 && headers.length === values.length
          ? values.map((value, index) => `${headers[index] || `Column ${index + 1}`}: ${value}`)
          : values;
        blocks.push({ type: 'table-row', row: rowIndex + 1, cells });
      });
    }
  });
  const plainText = normalizePlainText(blocksToPlainText(blocks));
  const firstHeading = blocks.find((block) => block.type === 'heading');
  return { sourceType: 'docx', title: firstHeading?.text || null, blocks, plainText,
    stats: { tables: $('table').length, characters: plainText.length } };
}

async function extractDocumentFromDOCX(buffer, options = {}) {
  try {
    const result = await (options.convertToHtml || mammoth.convertToHtml)({ buffer }, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Heading 1'] => h2:fresh",
        "p[style-name='Heading 2'] => h3:fresh"],
    });
    return normalizedDocxFromHtml(result.value);
  } catch (error) {
    logger.warn({ message: 'Worksheet DOCX extraction failed', feature: 'worksheet_extract_structure', code: 'WORKSHEET_DOCX_PARSE_FAILED' });
    throw extractionError('WORKSHEET_DOCX_PARSE_FAILED', `DOCX parsing failed: ${error?.code || error?.name || 'unknown'}`,
      'Could not read this DOCX. It may be corrupted.');
  }
}

async function extractFromDOCX(buffer, options = {}) {
  return (await extractDocumentFromDOCX(buffer, options)).plainText;
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
  return (await extractDocumentContent(buffer, mimeType, originalName, options)).plainText;
}

async function extractDocumentContent(buffer, mimeType, originalName, options = {}) {
  const ext = path.extname(originalName || '').toLowerCase();
  let extractor;
  let fileType;
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    extractor = extractFromPDF; fileType = 'PDF';
  } else if (mimeType === DOCX_MIME || ext === '.docx') {
    extractor = extractDocumentFromDOCX; fileType = 'DOCX';
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
  const extracted = await extractor(buffer, { ...options, mimeType });
  const document = typeof extracted === 'string' ? normalizedTextDocument(extracted, fileType.toLowerCase()) : extracted;
  const trimmedText = String(document.plainText || '').trim();
  try { assertDocumentQuality({ ...document, plainText: trimmedText }, fileType); }
  catch (error) {
    if (fileType === 'PDF' && error.code === 'WORKSHEET_TEXT_LOW_QUALITY') error.userMessage = SAFE_PDF_OCR_MESSAGE;
    throw error;
  }
  logger.info({ message: 'Worksheet file extraction completed', feature: 'worksheet_extract_structure',
    fileType, characterCount: trimmedText.length });
  return { ...document, plainText: trimmedText, stats: { ...(document.stats || {}), characters: trimmedText.length } };
}

function validateFile(file, maxSizeMB = 10) {
  const { originalname, mimetype, size } = file;
  if (size > maxSizeMB * 1024 * 1024) return { valid: false, error: `File size exceeds ${maxSizeMB}MB limit.` };
  if (size === 0) return { valid: false, error: 'File is empty.' };
  const allowedMimeTypes = ['application/pdf', DOCX_MIME, 'text/plain', 'image/png', 'image/jpeg', 'image/jpg'];
  const allowedExtensions = ['.pdf', '.docx', '.txt', '.png', '.jpg', '.jpeg'];
  const ext = path.extname(originalname).toLowerCase();
  if (!allowedMimeTypes.includes(mimetype) && !allowedExtensions.includes(ext)) {
    return { valid: false, error: 'Invalid file type. Supported formats: PDF, DOCX, TXT, PNG, JPG.' };
  }
  return { valid: true };
}

module.exports = { extractContent, extractDocumentContent, validateFile, extractFromPDF, extractFromDOCX,
  extractDocumentFromDOCX, normalizedDocxFromHtml, normalizePlainText, extractFromTXT, extractFromImage,
  assertDocumentQuality, SAFE_PDF_OCR_MESSAGE, SAFE_FILE_MESSAGE };
