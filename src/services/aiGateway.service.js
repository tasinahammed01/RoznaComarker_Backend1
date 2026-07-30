'use strict';

const logger = require('../utils/logger');

const SUPPORTED_PROVIDERS = new Set(['google', 'openrouter']);
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULTS = Object.freeze({
  attemptTimeoutMs: 30000,
  totalBudgetMs: 120000,
  retriesPerModel: 0,
  retryDelayMs: 1000
});
const FINALIZATION_RESERVE_MS = 1000;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const integer = (value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

function credentialFor(provider, env = process.env) {
  if (provider === 'google') return text(env.GEMINI_API_KEY);
  if (provider === 'openrouter') return text(env.OPENROUTER_API_KEY);
  return '';
}

function endpointFor(provider, env = process.env) {
  if (provider === 'google') return text(env.GEMINI_BASE_URL)
    || 'https://generativelanguage.googleapis.com/v1';
  if (provider === 'openrouter') return text(env.OPENROUTER_BASE_URL)
    || 'https://openrouter.ai/api/v1';
  return '';
}

function configurationError(issues) {
  const error = new Error('Global AI model chain configuration is invalid.');
  error.code = 'AI_CHAIN_NOT_CONFIGURED';
  error.issues = issues;
  return error;
}

function getAIConfig(env = process.env, { requireCredentials = true } = {}) {
  const issues = [];
  const chain = [];
  const slots = [
    ['primary', 'AI_PRIMARY_PROVIDER', 'AI_PRIMARY_MODEL'],
    ['fallback_1', 'AI_FALLBACK_1_PROVIDER', 'AI_FALLBACK_1_MODEL'],
    ['fallback_2', 'AI_FALLBACK_2_PROVIDER', 'AI_FALLBACK_2_MODEL'],
    ['fallback_3', 'AI_FALLBACK_3_PROVIDER', 'AI_FALLBACK_3_MODEL']
  ];
  slots.forEach(([name, providerKey, modelKey], index) => {
    const provider = text(env[providerKey]).toLowerCase();
    const model = text(env[modelKey]);
    if (index === 0 && (!provider || !model)) {
      issues.push(`${providerKey} and ${modelKey} are required.`);
      return;
    }
    if (!provider && !model) return;
    if (!provider || !model) {
      issues.push(`${providerKey} and ${modelKey} must be set together.`);
      return;
    }
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      issues.push(`${providerKey} uses unsupported provider "${provider}".`);
      return;
    }
    if (requireCredentials && !credentialFor(provider, env)) {
      issues.push(`${provider === 'google' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY'} is required for ${name}.`);
      return;
    }
    chain.push({ provider, model, fallbackIndex: index });
  });
  const attemptTimeoutMs = integer(env.AI_ATTEMPT_TIMEOUT_MS, DEFAULTS.attemptTimeoutMs, 1);
  const totalBudgetMs = integer(env.AI_TOTAL_BUDGET_MS, DEFAULTS.totalBudgetMs, 1);
  const retriesPerModel = integer(env.AI_RETRIES_PER_MODEL, DEFAULTS.retriesPerModel, 0, 10);
  const retryDelayMs = integer(env.AI_RETRY_DELAY_MS, DEFAULTS.retryDelayMs, 0);
  if ([attemptTimeoutMs, totalBudgetMs, retriesPerModel, retryDelayMs].includes(null)) {
    issues.push('One or more global AI timeout/retry values are invalid.');
  }
  if (issues.length) throw configurationError(issues);
  return { chain, attemptTimeoutMs, totalBudgetMs, retriesPerModel, retryDelayMs };
}

function safeCode(error) {
  const status = Number(error?.status || error?.httpStatus);
  if (error?.code && String(error.code).startsWith('AI_')) return error.code;
  if (status === 401 || status === 403) return 'AI_PROVIDER_AUTH_ERROR';
  if (status === 402) return 'AI_PROVIDER_PAYMENT_REQUIRED';
  if (status === 408 || error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return 'AI_ATTEMPT_TIMEOUT';
  if (status === 429) return 'AI_PROVIDER_RATE_LIMIT';
  if (status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
  if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code))
    return 'AI_PROVIDER_UNAVAILABLE';
  return 'AI_RESPONSE_INVALID';
}

function attemptError(code, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, metadata);
  return error;
}

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function extractGoogle(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const candidate = candidates[0];
  const finishReason = text(candidate?.finishReason).toUpperCase();
  const blockReason = text(payload?.promptFeedback?.blockReason);
  if (blockReason || finishReason === 'SAFETY') throw attemptError('AI_RESPONSE_BLOCKED', 'AI response was blocked.');
  if (['MAX_TOKENS', 'LENGTH'].includes(finishReason)) throw attemptError('AI_RESPONSE_TRUNCATED', 'AI response was truncated.');
  if (!candidates.length) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no candidates.');
  if (!Array.isArray(candidate?.content?.parts)) throw attemptError('AI_RESPONSE_INVALID', 'AI provider response structure is invalid.');
  const content = candidate.content.parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text).join('');
  if (!content.trim()) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no text.');
  return { content, finishReason: finishReason || null };
}

function extractOpenRouter(payload) {
  const choice = payload?.choices?.[0];
  const finishReason = text(choice?.finish_reason).toLowerCase();
  if (['length', 'max_tokens'].includes(finishReason)) throw attemptError('AI_RESPONSE_TRUNCATED', 'AI response was truncated.');
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no text.');
  return { content, finishReason: finishReason || null };
}

function googleBody(messages, maxOutputTokens, temperature, responseFormat) {
  const system = messages.filter((m) => m?.role === 'system').map((m) => String(m.content || '')).join('\n');
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: messages.filter((m) => m?.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.content) ? m.content.map((part) => {
        if (part?.type === 'text') return { text: String(part.text || '') };
        const dataUrl = part?.type === 'image_url' ? String(part.image_url?.url || '') : '';
        const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/u);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } }
          : { text: JSON.stringify(part) };
      }) : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    })),
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(responseFormat === 'json' ? { responseMimeType: 'application/json' } : {})
    }
  };
}

async function providerAttempt({ entry, messages, maxOutputTokens, temperature, responseFormat,
  attemptTimeoutMs, fetchImpl, env, now }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
  const started = now();
  try {
    const google = entry.provider === 'google';
    const base = endpointFor(entry.provider, env).replace(/\/$/u, '');
    const url = google
      ? `${base}/models/${encodeURIComponent(entry.model)}:generateContent`
      : `${base}/chat/completions`;
    const body = google ? googleBody(messages, maxOutputTokens, temperature, responseFormat) : {
      model: entry.model, messages, temperature, max_tokens: maxOutputTokens
      // JSON is enforced by the prompt and validator; free OpenRouter models do not
      // consistently implement response_format.
    };
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(google ? { 'x-goog-api-key': credentialFor(entry.provider, env) } : {
          Authorization: `Bearer ${credentialFor(entry.provider, env)}`,
          'HTTP-Referer': env.FRONTEND_URL || 'http://localhost:4200',
          'X-Title': 'RoznaComarker'
        })
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = attemptError(safeCode({ status: response.status }), `AI provider request failed (${response.status}).`, {
        status: response.status, retryAfterMs: retryAfterMs(response, now())
      });
      throw error;
    }
    let payload;
    try { payload = JSON.parse(await response.text()); }
    catch { throw attemptError('AI_RESPONSE_INVALID', 'AI provider returned invalid JSON transport.'); }
    const extracted = google ? extractGoogle(payload) : extractOpenRouter(payload);
    const usage = google ? (payload.usageMetadata ? {
      prompt_tokens: payload.usageMetadata.promptTokenCount,
      completion_tokens: payload.usageMetadata.candidatesTokenCount,
      total_tokens: payload.usageMetadata.totalTokenCount
    } : null) : payload.usage || null;
    return { ...extracted, usage, durationMs: now() - started };
  } catch (error) {
    if (controller.signal.aborted) throw attemptError('AI_ATTEMPT_TIMEOUT', 'AI provider attempt timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ feature = 'unspecified', messages, maxOutputTokens = 4000, temperature = 0.1,
  responseFormat = 'text', validate, metadata = {}, env = process.env, fetchImpl = global.fetch,
  now = Date.now, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  config = getAIConfig(env), onAttempt, onRetry } = {}) {
  if (!Array.isArray(messages) || typeof fetchImpl !== 'function') {
    throw new TypeError('AI gateway requires messages and fetch.');
  }
  const started = now();
  const deadline = started + config.totalBudgetMs;
  const attempts = [];
  let attemptCount = 0;
  let lastError;
  for (const entry of config.chain) {
    for (let retry = 0; retry <= config.retriesPerModel; retry += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        lastError = attemptError('AI_TOTAL_BUDGET_EXHAUSTED', 'AI total budget was exhausted.');
        break;
      }
      const chainIndex = config.chain.indexOf(entry);
      const currentModelAttempts = config.retriesPerModel - retry + 1;
      const laterModelAttempts = Math.max(0, config.chain.length - chainIndex - 1)
        * (config.retriesPerModel + 1);
      const attemptsRemaining = currentModelAttempts + laterModelAttempts;
      const reserve = Math.min(FINALIZATION_RESERVE_MS, Math.floor(remaining / 10));
      const fairShare = Math.max(1, Math.floor((remaining - reserve) / attemptsRemaining));
      const timeout = Math.min(config.attemptTimeoutMs, fairShare);
      attemptCount += 1;
      const attemptStarted = now();
      if (typeof onAttempt === 'function') await onAttempt({ attempt: attemptCount,
        provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
        attemptTimeoutMs: timeout, remainingBudgetMs: remaining });
      try {
        const result = await providerAttempt({ entry, messages, maxOutputTokens, temperature,
          responseFormat, attemptTimeoutMs: timeout, fetchImpl, env, now });
        let value = result.content;
        if (typeof validate === 'function') {
          try { value = await validate(result.content, { provider: entry.provider, model: entry.model }); }
          catch (error) {
            throw attemptError('AI_OUTPUT_VALIDATION_FAILED', 'AI output failed feature validation.', {
              validationCode: error?.code || null, cause: error
            });
          }
        }
        attempts.push({ provider: entry.provider, model: entry.model, status: 'success',
          code: null, durationMs: now() - attemptStarted, timeoutMs: timeout });
        const gatewayMetadata = { provider: entry.provider, model: entry.model, attemptCount,
          fallbackIndex: entry.fallbackIndex, fallbackUsed: entry.fallbackIndex > 0,
          durationMs: now() - started, usage: result.usage || null, attempts };
        logger.info({ message: 'AI gateway generation completed', feature, ...gatewayMetadata,
          usage: undefined, attempts: attempts.map((a) => ({ ...a })) });
        return { value, content: result.content, ...gatewayMetadata, metadata: gatewayMetadata };
      } catch (error) {
        lastError = error;
        const code = safeCode(error);
        attempts.push({ provider: entry.provider, model: entry.model, status: 'failed',
          code, durationMs: now() - attemptStarted, timeoutMs: timeout });
        logger.warn({ message: 'AI gateway attempt failed', feature, attemptNumber: attemptCount,
          provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
          durationMs: now() - attemptStarted, attemptTimeoutMs: timeout, code });
        const status = Number(error?.status);
        const retryableSameModel = retry < config.retriesPerModel
          && (RETRYABLE_HTTP.has(status) || ['AI_ATTEMPT_TIMEOUT', 'AI_PROVIDER_UNAVAILABLE'].includes(code));
        if (retryableSameModel) {
          const requested = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : config.retryDelayMs;
          if (typeof onRetry === 'function') await onRetry({ attempt: attemptCount, delayMs: requested,
            code, provider: entry.provider, model: entry.model });
          if (requested < deadline - now()) await sleepFn(requested);
          else break;
        } else break;
      }
    }
  }
  const error = new Error('All configured AI models failed.');
  error.code = lastError?.code === 'AI_TOTAL_BUDGET_EXHAUSTED'
    ? 'AI_TOTAL_BUDGET_EXHAUSTED' : 'AI_CHAIN_EXHAUSTED';
  error.attempts = attempts;
  error.attemptCount = attempts.length;
  error.timeoutCount = attempts.filter((attempt) => attempt.code === 'AI_ATTEMPT_TIMEOUT').length;
  error.durationMs = now() - started;
  error.totalDurationMs = error.durationMs;
  error.finalFailureCode = attempts[attempts.length - 1]?.code || lastError?.code || error.code;
  error.feature = feature;
  error.metadata = metadata && typeof metadata === 'object'
    ? Object.fromEntries(Object.entries(metadata).filter(([key]) => /^(?:submissionId|jobId|requestId)$/u.test(key)))
    : {};
  throw error;
}

function validateAIConfig(env = process.env) {
  try {
    const config = getAIConfig(env);
    return { isValid: true, errors: [], warnings: [], chain: config.chain };
  } catch (error) {
    return { isValid: false, errors: error.issues || [error.message], warnings: [], chain: [] };
  }
}

module.exports = {
  SUPPORTED_PROVIDERS, DEFAULTS, credentialFor, endpointFor, getAIConfig, validateAIConfig,
  retryAfterMs, safeCode, extractGoogle, extractOpenRouter, providerAttempt, generate
};
