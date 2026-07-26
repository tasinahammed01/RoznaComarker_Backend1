'use strict';

const logger = require('../utils/logger');
const {
  GOOGLE_SEMANTIC_MODELS,
  classifyTransient,
  providerAttempt
} = require('./semanticAIClient.service');

const FEATURE_DEFAULTS = Object.freeze({
  flashcard: { timeoutMs: 60000, maxOutputTokens: 4000, maxRetries: 1 },
  worksheet: { timeoutMs: 60000, maxOutputTokens: 6000, maxRetries: 1 }
});

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function getFeatureGeminiConfig(feature, env = process.env) {
  const key = String(feature || '').trim().toLowerCase();
  const defaults = FEATURE_DEFAULTS[key];
  if (!defaults) throw Object.assign(new Error('Unknown AI feature configuration.'), { code: 'GEMINI_NOT_CONFIGURED' });
  const prefix = key.toUpperCase();
  const provider = String(env[`${prefix}_AI_PROVIDER`] || '').trim().toLowerCase();
  const model = String(env[`${prefix}_AI_MODEL`] || '').trim();
  const timeoutMs = positiveInteger(env[`${prefix}_AI_TIMEOUT_MS`], defaults.timeoutMs, { minimum: 1000, maximum: 300000 });
  const maxOutputTokens = positiveInteger(env[`${prefix}_AI_MAX_OUTPUT_TOKENS`], defaults.maxOutputTokens, { minimum: 256, maximum: 65536 });
  const maxRetries = positiveInteger(env[`${prefix}_AI_MAX_RETRIES`], defaults.maxRetries, { minimum: 0, maximum: 5 });
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const configured = provider === 'google' && GOOGLE_SEMANTIC_MODELS.has(model)
    && timeoutMs !== null && maxOutputTokens !== null && maxRetries !== null && Boolean(apiKey);
  return { feature: key, provider, model, timeoutMs, maxOutputTokens, maxRetries, configured };
}

function configurationError(config) {
  const error = new Error(`${config.feature} AI service is not configured.`);
  error.code = 'GEMINI_NOT_CONFIGURED';
  error.provider = config.provider || null;
  error.model = config.model || null;
  return error;
}

function stripSingleJsonFence(value) {
  const text = String(value || '').replace(/^\uFEFF/u, '').trim();
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return match ? match[1].trim() : text;
}

function strictJson(value) {
  const text = stripSingleJsonFence(value);
  if (!text) throw Object.assign(new Error('Gemini returned no content.'), { code: 'GEMINI_RESPONSE_EMPTY' });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Gemini returned invalid JSON.'), { code: 'GEMINI_RESPONSE_INVALID' });
  }
}

function mapGeminiError(error) {
  if (String(error?.code || '').startsWith('GEMINI_')) return error;
  const status = Number(error?.status || error?.httpStatus);
  let code;
  if (error?.code === 'AI_PROVIDER_TIMEOUT' || ['AbortError', 'TimeoutError'].includes(error?.name)) code = 'GEMINI_TIMEOUT';
  else if (['GOOGLE_RESPONSE_BLOCKED'].includes(error?.code)) code = 'GEMINI_SAFETY_BLOCKED';
  else if (['GOOGLE_OUTPUT_TRUNCATED'].includes(error?.code)) code = 'GEMINI_RESPONSE_TRUNCATED';
  else if (['GOOGLE_CANDIDATES_EMPTY', 'GOOGLE_RESPONSE_TEXT_MISSING'].includes(error?.code)) code = 'GEMINI_RESPONSE_EMPTY';
  else if (status === 401 || status === 403) code = 'GEMINI_AUTHENTICATION_FAILED';
  else if (status === 429) code = Number.isFinite(error?.retryAfterMs) ? 'GEMINI_RATE_LIMITED' : 'GEMINI_QUOTA_EXCEEDED';
  else code = 'GEMINI_RESPONSE_INVALID';
  const mapped = new Error('Gemini generation failed.');
  mapped.code = code;
  mapped.status = status || null;
  mapped.provider = 'google';
  mapped.model = error?.model || null;
  mapped.cause = error;
  return mapped;
}

async function generateFeatureJson(feature, messages, {
  env = process.env,
  fetchImpl = global.fetch,
  now = Date.now,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const config = getFeatureGeminiConfig(feature, env);
  if (!config.configured) throw configurationError(config);
  let lastError;
  const startedAt = now();
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    try {
      const result = await providerAttempt({
        messages, provider: 'google', model: config.model,
        maxOutputTokens: config.maxOutputTokens, googleThinkingLevel: 'low',
        attemptTimeoutMs: config.timeoutMs, fetchImpl, env, now
      });
      const value = strictJson(result.content);
      logger.info({
        message: 'Feature Gemini generation completed',
        feature: config.feature, provider: 'google', model: config.model,
        attempt, durationMs: now() - startedAt,
        finishReason: result.finishReason || null,
        candidateCount: result.candidateCount ?? null,
        outputTokenCount: Number(result.usage?.completion_tokens) || null
      });
      return { value, metadata: {
        provider: 'google', model: config.model, attemptCount: attempt,
        durationMs: now() - startedAt, usage: result.usage || null
      } };
    } catch (rawError) {
      const error = mapGeminiError(rawError);
      lastError = error;
      const retryable = classifyTransient(rawError)
        && !['GEMINI_AUTHENTICATION_FAILED', 'GEMINI_SAFETY_BLOCKED', 'GEMINI_RESPONSE_INVALID'].includes(error.code);
      if (!retryable || attempt > config.maxRetries) throw error;
      await sleepFn(0);
    }
  }
  throw lastError || Object.assign(new Error('Gemini generation failed.'), { code: 'GEMINI_RESPONSE_INVALID' });
}

function containsExecutableHtml(value) {
  return /<\s*script\b|javascript\s*:|\bon\w+\s*=/iu.test(String(value || ''));
}

function outputValidationError(message) {
  return Object.assign(new Error(message), { code: 'FEATURE_OUTPUT_VALIDATION_FAILED' });
}

function validateFlashcardOutput(value, requestedCount) {
  const cards = Array.isArray(value) ? value
    : Array.isArray(value?.flashcards) ? value.flashcards
      : Array.isArray(value?.cards) ? value.cards : null;
  if (!cards) throw outputValidationError('Flashcard output must be an array.');
  const normalized = [];
  const seen = new Set();
  for (const card of cards) {
    const front = typeof card?.front === 'string' ? card.front.replace(/\s+/gu, ' ').trim() : '';
    const back = typeof card?.back === 'string' ? card.back.replace(/\s+/gu, ' ').trim() : '';
    if (!front || !back || front.length > 500 || back.length > 4000 || containsExecutableHtml(front) || containsExecutableHtml(back)) {
      throw outputValidationError('Flashcard output contains an invalid card.');
    }
    const key = `${front.toLocaleLowerCase()}|${back.toLocaleLowerCase()}`;
    if (seen.has(key)) throw outputValidationError('Flashcard output contains duplicate cards.');
    seen.add(key);
    normalized.push({ front, back });
  }
  if (normalized.length !== requestedCount) throw outputValidationError('Flashcard output count does not match the requested count.');
  return normalized;
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim()) && !containsExecutableHtml(value);
}

function validateWorksheetData(activity) {
  const data = activity.data;
  const nonEmptyArray = (value) => Array.isArray(value) && value.length > 0;
  if (!data || typeof data !== 'object') return false;
  if (activity.type === 'ordering') return nonEmptyArray(data.items) && data.items.every((item) => nonEmptyString(item?.id)
    && nonEmptyString(item?.name) && Number.isInteger(Number(item?.correctOrder)));
  if (activity.type === 'classification') return nonEmptyArray(data.categories) && nonEmptyArray(data.items)
    && data.categories.every(nonEmptyString) && data.items.every((item) => nonEmptyString(item?.id)
      && nonEmptyString(item?.name) && nonEmptyString(item?.correctCategory)
      && data.categories.includes(item.correctCategory));
  if (activity.type === 'multipleChoice') return nonEmptyArray(data.questions)
    && data.questions.every((item) => nonEmptyString(item?.id) && nonEmptyString(item?.text)
      && Array.isArray(item?.options) && item.options.length >= 2 && item.options.every(nonEmptyString)
      && nonEmptyString(item?.correctAnswer));
  if (activity.type === 'fillBlanks') return nonEmptyArray(data.wordBank) && data.wordBank.every(nonEmptyString)
    && nonEmptyArray(data.sentences)
    && data.sentences.every((sentence) => nonEmptyString(sentence?.id) && nonEmptyArray(sentence?.parts)
      && sentence.parts.some((part) => part?.type === 'blank' && nonEmptyString(part?.blankId) && nonEmptyString(part?.correctAnswer)));
  if (activity.type === 'labeling') return nonEmptyArray(data.labels)
    && data.labels.every((item) => nonEmptyString(item?.id) && nonEmptyString(item?.text)
      && item?.targetId === item.id && Number(item?.x) >= 0 && Number(item?.x) <= 100
      && Number(item?.y) >= 0 && Number(item?.y) <= 100);
  if (activity.type === 'matching') return nonEmptyArray(data.pairs)
    && data.pairs.every((item) => nonEmptyString(item?.id)
      && nonEmptyString(item?.leftItem?.text) && nonEmptyString(item?.rightItem?.text));
  if (activity.type === 'trueFalse') return nonEmptyArray(data.questions)
    && data.questions.every((item) => nonEmptyString(item?.id) && nonEmptyString(item?.text)
      && typeof item?.correctAnswer === 'boolean' && nonEmptyString(item?.explanation));
  if (activity.type === 'shortAnswer') return nonEmptyArray(data.questions)
    && data.questions.every((item) => nonEmptyString(item?.id) && nonEmptyString(item?.text)
      && nonEmptyString(item?.modelAnswer) && Number(item?.maxWords) > 0);
  return Object.keys(data).length > 0;
}

function validateWorksheetOutput(value, requestedTypes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !nonEmptyString(value.title) || !nonEmptyString(value.description)
    || !nonEmptyString(value.subject) || !Array.isArray(value.tags) || !value.tags.every(nonEmptyString)
    || !Number.isFinite(Number(value.estimatedMinutes)) || !Array.isArray(value.activities)
    || containsExecutableHtml(JSON.stringify(value))) {
    throw outputValidationError('Worksheet output metadata is invalid.');
  }
  if (value.activities.length !== requestedTypes.length) throw outputValidationError('Worksheet activity count is invalid.');
  const remaining = [...requestedTypes];
  const identifiers = new Set();
  for (const activity of value.activities) {
    if (!nonEmptyString(activity?.type) || !nonEmptyString(activity?.title)
      || !nonEmptyString(activity?.instructions) || !validateWorksheetData(activity)) {
      throw outputValidationError('Worksheet output contains an invalid activity.');
    }
    const index = remaining.indexOf(activity.type);
    if (index < 0) throw outputValidationError('Worksheet output contains an unexpected activity type.');
    remaining.splice(index, 1);
    const serialized = JSON.stringify(activity);
    for (const match of serialized.matchAll(/"(?:id|blankId)"\s*:\s*"([^"]+)"/gu)) {
      if (identifiers.has(match[1])) throw outputValidationError('Worksheet output contains duplicate IDs.');
      identifiers.add(match[1]);
    }
  }
  return value;
}

function featureErrorHttp(error) {
  const code = error?.code || 'INTERNAL_ERROR';
  if (code === 'GEMINI_NOT_CONFIGURED') return { status: 503, message: 'AI service is not configured.' };
  if (code === 'GEMINI_AUTHENTICATION_FAILED') return { status: 503, message: 'AI service authentication failed.' };
  if (['GEMINI_QUOTA_EXCEEDED', 'GEMINI_RATE_LIMITED'].includes(code)) return { status: 429, message: 'AI service is temporarily rate limited.' };
  if (code === 'GEMINI_TIMEOUT') return { status: 504, message: 'AI service request timed out. Try again.' };
  if (['GEMINI_SAFETY_BLOCKED', 'GEMINI_RESPONSE_EMPTY', 'GEMINI_RESPONSE_TRUNCATED',
    'GEMINI_RESPONSE_INVALID', 'FEATURE_OUTPUT_VALIDATION_FAILED'].includes(code)) {
    return { status: 502, message: 'AI service returned an invalid generation result.' };
  }
  return { status: 500, message: 'Generation failed.' };
}

module.exports = {
  FEATURE_DEFAULTS,
  getFeatureGeminiConfig,
  stripSingleJsonFence,
  strictJson,
  mapGeminiError,
  generateFeatureJson,
  validateFlashcardOutput,
  validateWorksheetOutput,
  featureErrorHttp
};
