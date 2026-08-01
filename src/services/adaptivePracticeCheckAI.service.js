'use strict';

const logger = require('../utils/logger');
const aiGateway = require('./aiGateway.service');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_TOKENS = 3000;
const DEFAULT_MAX_RETRIES = 1;

function integer(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function getConfig(env = process.env) {
  let global;
  try { global = aiGateway.getAssessmentAIConfig(env); } catch { global = null; }
  const provider = global?.chain?.[0]?.provider || '';
  const model = global?.chain?.[0]?.model || '';
  const timeoutMs = global?.attemptTimeoutMs || DEFAULT_TIMEOUT_MS;
  const sharedMaximum = integer(env.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 256, 65536);
  const maxOutputTokens = integer(env.ADAPTIVE_PRACTICE_CHECK_AI_MAX_OUTPUT_TOKENS, sharedMaximum, 256, 65536);
  const maxRetries = global?.retriesPerModel ?? DEFAULT_MAX_RETRIES;
  const configured = Boolean(global && sharedMaximum !== null && maxOutputTokens !== null);
  return { provider, model, timeoutMs, maxOutputTokens, maxRetries, configured, global };
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
  const terminalAttempt = Array.isArray(error?.attempts) ? error.attempts[error.attempts.length - 1] : null;
  const normalizedCode = terminalAttempt?.code || error?.code;
  const status = Number(error?.status || error?.httpStatus);
  if (['AI_PROVIDER_NOT_CONFIGURED', 'AI_CHAIN_NOT_CONFIGURED'].includes(normalizedCode)) {
    return checkError(503, 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', 'Adaptive practice checking is not configured.', error);
  }
  if (['AI_PROVIDER_TIMEOUT', 'AI_ATTEMPT_TIMEOUT', 'AI_TOTAL_BUDGET_EXHAUSTED'].includes(normalizedCode)
    || ['AbortError', 'TimeoutError'].includes(error?.name)) {
    return checkError(504, 'ADAPTIVE_CHECK_AI_TIMEOUT', 'Adaptive practice checking timed out. Please try again.', error);
  }
  if (['GOOGLE_RESPONSE_BLOCKED', 'AI_RESPONSE_BLOCKED'].includes(normalizedCode)) {
    return checkError(502, 'ADAPTIVE_CHECK_AI_SAFETY_BLOCKED', 'The response could not be assessed safely.', error);
  }
  if (['GOOGLE_CANDIDATES_EMPTY', 'GOOGLE_RESPONSE_TEXT_MISSING', 'AI_RESPONSE_EMPTY'].includes(normalizedCode)) {
    return checkError(502, 'ADAPTIVE_CHECK_AI_RESPONSE_EMPTY', 'The checking provider returned an empty response.', error);
  }
  if (['GOOGLE_OUTPUT_TRUNCATED', 'AI_RESPONSE_TRUNCATED'].includes(normalizedCode)) {
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
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  validate
} = {}) {
  const config = getConfig(env);
  if (!config.configured) {
    throw checkError(503, 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', 'Adaptive practice checking is not configured.');
  }
  const startedAt = now();
  try {
      const result = await aiGateway.generate({
        feature: 'adaptive_practice_check', messages,
        maxOutputTokens: config.maxOutputTokens, responseFormat: 'json',
        validate, fetchImpl, env, now, sleepFn, config: config.global
      });
      logger.info({
        message: 'Adaptive practice answer check completed',
        provider: result.provider,
        model: result.model,
        attemptCount: result.attemptCount,
        durationMs: now() - startedAt,
        inputTokens: Number(result.usage?.prompt_tokens) || null,
        outputTokens: Number(result.usage?.completion_tokens) || null
      });
      return typeof validate === 'function' ? result.value : result.content;
  } catch (rawError) {
    throw mapError(rawError);
  }
}

module.exports = { getConfig, mapError, generateCheckCompletion };
