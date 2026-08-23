'use strict';

const vision = require('@google-cloud/vision');
const aiGateway = require('./aiGateway.service');
const logger = require('../utils/logger');

const MIN_TEXT_LENGTH = 10;

class WorksheetOcrError extends Error {
  constructor(code, message, userMessage = "We couldn't read text from this image. Please try a clearer image or another file.") {
    super(message);
    this.code = code;
    this.userMessage = userMessage;
  }
}

function hasGoogleVisionConfig(env = process.env) {
  return Boolean(String(env.GOOGLE_CLOUD_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS
    || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '').trim());
}

function createGoogleVisionClient(env = process.env) {
  if (!hasGoogleVisionConfig(env)) return null;
  const keyFilename = String(env.GOOGLE_CLOUD_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  return keyFilename ? new vision.ImageAnnotatorClient({ keyFilename }) : new vision.ImageAnnotatorClient();
}

async function googleOcrPages(pages, { env = process.env, client = createGoogleVisionClient(env) } = {}) {
  if (!client) throw new WorksheetOcrError('WORKSHEET_OCR_NOT_CONFIGURED', 'Google Vision is not configured.');
  const texts = [];
  for (const page of pages) {
    const [result] = await client.documentTextDetection({ image: { content: page.buffer } });
    const text = String(result?.fullTextAnnotation?.text || '').trim();
    texts.push({ pageNumber: page.pageNumber, text });
  }
  if (texts.reduce((total, page) => total + page.text.length, 0) < MIN_TEXT_LENGTH) {
    throw new WorksheetOcrError('WORKSHEET_OCR_TEXT_EMPTY', 'Google OCR returned insufficient worksheet text.');
  }
  return texts;
}

function validateAiOcr(content, expectedPages) {
  let parsed;
  try { parsed = JSON.parse(String(content || '').trim()); }
  catch { throw new WorksheetOcrError('WORKSHEET_OCR_INVALID_RESPONSE', 'Fallback OCR returned invalid JSON.'); }
  if (!Array.isArray(parsed?.pages) || parsed.pages.length !== expectedPages.length) {
    throw new WorksheetOcrError('WORKSHEET_OCR_INVALID_RESPONSE', 'Fallback OCR returned an invalid page list.');
  }
  const normalized = parsed.pages.map((page, index) => {
    const expected = expectedPages[index].pageNumber;
    const text = typeof page?.text === 'string' ? page.text.trim() : '';
    if (Number(page?.pageNumber) !== expected) {
      throw new WorksheetOcrError('WORKSHEET_OCR_INVALID_RESPONSE', `Fallback OCR returned the wrong page number for page ${expected}.`);
    }
    return { pageNumber: expected, text };
  });
  if (normalized.reduce((total, page) => total + page.text.length, 0) < MIN_TEXT_LENGTH) {
    throw new WorksheetOcrError('WORKSHEET_OCR_TEXT_EMPTY', 'Fallback OCR returned insufficient worksheet text.');
  }
  return normalized;
}

async function aiOcrPages(pages, { env = process.env, fetchImpl = global.fetch } = {}) {
  let config;
  try { config = aiGateway.getAssessmentAIConfig(env); }
  catch { throw new WorksheetOcrError('WORKSHEET_OCR_NOT_CONFIGURED', 'No worksheet OCR fallback is configured.'); }
  const content = pages.map((page) => ({
    type: 'image_url', image_url: { url: `data:${page.mimeType || 'image/jpeg'};base64,${page.buffer.toString('base64')}` }
  }));
  content.push({ type: 'text', text: `Transcribe every visible word from these ${pages.length} worksheet page(s).
Return JSON only in this exact shape: {"pages":[{"pageNumber":1,"text":"exact transcription"}]}.
Return one item per supplied page in the same order. Do not summarize, answer questions, add prose, or omit blank labels.` });
  try {
    const result = await aiGateway.generate({
      feature: 'worksheet_ocr_fallback',
      messages: [{ role: 'user', content }],
      maxOutputTokens: Number(env.WORKSHEET_OCR_MAX_OUTPUT_TOKENS) || 8000,
      responseFormat: 'json',
      validate: (raw) => validateAiOcr(raw, pages),
      config, env, fetchImpl,
      retryableSameModelCodes: ['AI_OUTPUT_VALIDATION_FAILED', 'AI_RESPONSE_INVALID',
        'AI_RESPONSE_EMPTY', 'AI_RESPONSE_TRUNCATED', 'AI_ATTEMPT_TIMEOUT', 'AI_PROVIDER_UNAVAILABLE'],
      terminalCodes: ['AI_CHAIN_NOT_CONFIGURED', 'AI_PROVIDER_AUTH_ERROR',
        'AI_PROVIDER_PAYMENT_REQUIRED', 'AI_PROVIDER_PERMISSION_DENIED',
        'AI_PROVIDER_INVALID_REQUEST', 'AI_RESPONSE_BLOCKED']
    });
    return result.value;
  } catch (error) {
    throw new WorksheetOcrError('WORKSHEET_OCR_FAILED', `Fallback OCR failed: ${error?.code || 'unknown'}`);
  }
}

async function extractTextFromPages(pages, options = {}) {
  if (!Array.isArray(pages) || !pages.length) {
    throw new WorksheetOcrError('WORKSHEET_OCR_FAILED', 'No OCR pages were supplied.');
  }
  try {
    const googlePages = await (options.googleOcrPages || googleOcrPages)(pages, options);
    return googlePages.sort((a, b) => a.pageNumber - b.pageNumber).map((page) => page.text.trim()).join('\n\n');
  } catch (error) {
    logger.warn({ message: 'Worksheet primary OCR unavailable', feature: 'worksheet_extract_structure',
      code: error?.code || 'WORKSHEET_OCR_FAILED', pageCount: pages.length });
  }
  try {
    const fallbackPages = await (options.aiOcrPages || aiOcrPages)(pages, options);
    return fallbackPages.sort((a, b) => a.pageNumber - b.pageNumber).map((page) => page.text.trim()).join('\n\n');
  } catch (error) {
    logger.error({ message: 'Worksheet OCR providers exhausted', feature: 'worksheet_extract_structure',
      code: error?.code || 'WORKSHEET_OCR_FAILED', pageCount: pages.length });
    throw error instanceof WorksheetOcrError ? error
      : new WorksheetOcrError('WORKSHEET_OCR_FAILED', 'All worksheet OCR providers failed.');
  }
}

module.exports = { MIN_TEXT_LENGTH, WorksheetOcrError, hasGoogleVisionConfig,
  createGoogleVisionClient, googleOcrPages, aiOcrPages, validateAiOcr, extractTextFromPages };
