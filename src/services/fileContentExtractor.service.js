/**
 * fileContentExtractor.service.js
 *
 * Extracts text content from various file types for worksheet generation.
 * Supports: PDF, DOCX, TXT, and images (OCR).
 */

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const vision = require('@google-cloud/vision');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

// Initialize Google Cloud Vision client
const visionClient = process.env.GOOGLE_CLOUD_KEY_FILE
  ? new vision.ImageAnnotatorClient({ keyFilename: process.env.GOOGLE_CLOUD_KEY_FILE })
  : null;

/**
 * Extract text from a PDF file buffer.
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (error) {
    logger.error('[PDF EXTRACTION] Failed:', error.message);
    throw new Error('Could not extract text from PDF. The file may be corrupted or password-protected.');
  }
}

/**
 * Extract text from a DOCX file buffer.
 * @param {Buffer} buffer - DOCX file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractFromDOCX(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch (error) {
    logger.error('[DOCX EXTRACTION] Failed:', error.message);
    throw new Error('Could not extract text from DOCX. The file may be corrupted.');
  }
}

/**
 * Extract text from a TXT file buffer.
 * @param {Buffer} buffer - TXT file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractFromTXT(buffer) {
  try {
    return buffer.toString('utf-8');
  } catch (error) {
    logger.error('[TXT EXTRACTION] Failed:', error.message);
    throw new Error('Could not read text file. The encoding may not be supported.');
  }
}

/**
 * Extract text from an image using OCR (Google Cloud Vision).
 * @param {Buffer} buffer - Image file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractFromImage(buffer) {
  if (!visionClient) {
    throw new Error('Google Cloud Vision is not configured. Please set GOOGLE_CLOUD_KEY_FILE environment variable.');
  }

  try {
    const [result] = await visionClient.documentTextDetection({ image: { content: buffer } });
    const fullTextAnnotation = result.fullTextAnnotation;
    return fullTextAnnotation.text || '';
  } catch (error) {
    logger.error('[IMAGE OCR] Failed:', error.message);
    throw new Error('Could not extract text from image. The image may be unclear or OCR failed.');
  }
}

/**
 * Main extraction function that routes to the appropriate extractor.
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - File MIME type
 * @param {string} originalName - Original file name (for extension fallback)
 * @returns {Promise<string>} Extracted text
 */
async function extractContent(buffer, mimeType, originalName) {
  // Determine file type from MIME type or extension
  const ext = path.extname(originalName).toLowerCase();
  
  let extractor;
  let fileType;

  switch (mimeType) {
    case 'application/pdf':
      extractor = extractFromPDF;
      fileType = 'PDF';
      break;
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      extractor = extractFromDOCX;
      fileType = 'DOCX';
      break;
    case 'text/plain':
      extractor = extractFromTXT;
      fileType = 'TXT';
      break;
    case 'image/png':
    case 'image/jpeg':
    case 'image/jpg':
      extractor = extractFromImage;
      fileType = 'Image (OCR)';
      break;
    default:
      // Fallback to extension
      if (ext === '.pdf') {
        extractor = extractFromPDF;
        fileType = 'PDF';
      } else if (ext === '.docx' || ext === '.doc') {
        extractor = extractFromDOCX;
        fileType = 'DOCX';
      } else if (ext === '.txt') {
        extractor = extractFromTXT;
        fileType = 'TXT';
      } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        extractor = extractFromImage;
        fileType = 'Image (OCR)';
      } else {
        throw new Error(`Unsupported file type: ${mimeType}. Supported formats: PDF, DOCX, TXT, PNG, JPG.`);
      }
  }

  logger.info(`[FILE EXTRACTION] Extracting from ${fileType}: ${originalName}`);
  const text = await extractor(buffer);
  
  // Validate extracted content
  const trimmedText = text.trim();
  if (!trimmedText || trimmedText.length < 10) {
    throw new Error(`Could not extract enough educational content from this ${fileType}. The file may be empty, an image without text, or use an unsupported format.`);
  }

  logger.info(`[FILE EXTRACTION] Extracted ${trimmedText.length} characters from ${fileType}`);
  return trimmedText;
}

/**
 * Validate file before extraction.
 * @param {Object} file - File object with originalname, mimetype, size
 * @param {number} maxSizeMB - Maximum file size in MB (default: 10)
 * @returns {Object} Validation result { valid: boolean, error?: string }
 */
function validateFile(file, maxSizeMB = 10) {
  const { originalname, mimetype, size } = file;

  // Check file size
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  if (size > maxSizeBytes) {
    return { valid: false, error: `File size exceeds ${maxSizeMB}MB limit.` };
  }

  // Check file size minimum (avoid empty files)
  if (size === 0) {
    return { valid: false, error: 'File is empty.' };
  }

  // Check allowed MIME types
  const allowedMimeTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/jpg',
  ];

  const allowedExtensions = ['.pdf', '.docx', '.doc', '.txt', '.png', '.jpg', '.jpeg'];
  const ext = path.extname(originalname).toLowerCase();

  if (!allowedMimeTypes.includes(mimetype) && !allowedExtensions.includes(ext)) {
    return { valid: false, error: 'Invalid file type. Supported formats: PDF, DOCX, TXT, PNG, JPG.' };
  }

  return { valid: true };
}

module.exports = {
  extractContent,
  validateFile,
  extractFromPDF,
  extractFromDOCX,
  extractFromTXT,
  extractFromImage,
};
