'use strict';

const logger = require('../utils/logger');
const { classifyTransient, providerAttempt } = require('./semanticAIClient.service');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_TOKENS = 3000;
const DEFAULT_MAX_RETRIES = 1;
const SUPPORTED_MODELS = new Set(['gemini-3.6-flash']);

function integer(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function isPlaceholder(value) {
  return /^(?:<.*>|changeme|change_me|replace_me|your[_ -]?(?:api[_ -]?)?key|placeholder)$/iu.test(String(value || '').trim());
}

function getConfig(env = process.env) {
  const provider = String(env.ADAPTIVE_PRACTICE_AI_PROVIDER || '').trim().toLowerCase();
  const model = String(env.ADAPTIVE_PRACTICE_AI_MODEL || '').trim();
  const timeoutMs = integer(env.ADAPTIVE_PRACTICE_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 300000);
  const sharedMaximum = integer(env.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 256, 65536);
  const maxOutputTokens = integer(env.ADAPTIVE_PRACTICE_CHECK_AI_MAX_OUTPUT_TOKENS, sharedMaximum, 256, 65536);
  const maxRetries = integer(env.ADAPTIVE_PRACTICE_AI_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 3);
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const configured = provider === 'google' && SUPPORTED_MODELS.has(model)
    && timeoutMs !== null && sharedMaximum !== null && maxOutputTokens !== null && maxRetries !== null
    && Boolean(apiKey) && !isPlaceholder(apiKey);
  return { provider, model, timeoutMs, maxOutputTokens, maxRetries, configured };
}

function checkError(status, code, message, cause) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function mapError(error) {
  if (String(error?.code || '').startsWith('ADAPTIVE_CHECK_')) return error;
  const status = Number(error?.status || error?.httpStatus);
  if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED') {
    return checkError(503, 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', 'Adaptive practice checking is not configured.', error);
  }
  if (error?.code === 'AI_PROVIDER_TIMEOUT' || ['AbortError', 'TimeoutError'].includes(error?.name)) {
    return checkError(504, 'ADAPTIVE_CHECK_AI_TIMEOUT', 'Adaptive practice checking timed out. Please try again.', error);
  }
  if (error?.code === 'GOOGLE_RESPONSE_BLOCKED') {
    return checkError(502, 'ADAPTIVE_CHECK_AI_SAFETY_BLOCKED', 'The response could not be assessed safely.', error);
  }
  if (['GOOGLE_CANDIDATES_EMPTY', 'GOOGLE_RESPONSE_TEXT_MISSING'].includes(error?.code)) {
    return checkError(502, 'ADAPTIVE_CHECK_AI_RESPONSE_EMPTY', 'The checking provider returned an empty response.', error);
  }
  if (error?.code === 'GOOGLE_OUTPUT_TRUNCATED') {
    return checkError(502, 'ADAPTIVE_CHECK_AI_RESPONSE_INVALID', 'The checking provider returned an incomplete response.', error);
  }
  if (status === 401 || status === 403) {
    return checkError(503, 'ADAPTIVE_CHECK_AI_AUTHENTICATION_FAILED', 'Adaptive practice checking is unavailable.', error);
  }
  if (status === 429) {
    const quota = !Number.isFinite(error?.retryAfterMs);
    return checkError(429, quota ? 'ADAPTIVE_CHECK_AI_QUOTA_EXCEEDED' : 'ADAPTIVE_CHECK_AI_RATE_LIMITED',
      'Adaptive practice checking is temporarily rate limited. Please try again.', error);
  }
  return checkError(502, 'ADAPTIVE_CHECK_AI_RESPONSE_INVALID', 'The checking provider returned an invalid response.', error);
}

async function generateCheckCompletion(messages, {
  env = process.env,
  fetchImpl = global.fetch,
  now = Date.now,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const config = getConfig(env);
  if (!config.configured) {
    throw checkError(503, 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', 'Adaptive practice checking is not configured.');
  }
  const startedAt = now();
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    try {
      const result = await providerAttempt({
        messages,
        provider: 'google',
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        googleThinkingLevel: 'low',
        attemptTimeoutMs: config.timeoutMs,
        fetchImpl,
        env,
        now
      });
      logger.info({
        message: 'Adaptive practice answer check completed',
        provider: 'google',
        model: config.model,
        attemptCount: attempt,
        durationMs: now() - startedAt,
        finishReason: result.finishReason || null,
        inputTokens: Number(result.usage?.prompt_tokens) || null,
        outputTokens: Number(result.usage?.completion_tokens) || null
      });
      return result.content;
    } catch (rawError) {
      lastError = mapError(rawError);
      const retryable = classifyTransient(rawError)
        && !['ADAPTIVE_CHECK_AI_AUTHENTICATION_FAILED', 'ADAPTIVE_CHECK_AI_SAFETY_BLOCKED'].includes(lastError.code);
      if (!retryable || attempt > config.maxRetries) throw lastError;
      const delayMs = Number.isFinite(rawError?.retryAfterMs) ? rawError.retryAfterMs : 0;
      if (delayMs) await sleepFn(delayMs);
    }
  }
  throw lastError;
}

module.exports = { getConfig, mapError, generateCheckCompletion };
