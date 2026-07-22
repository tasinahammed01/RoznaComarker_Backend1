'use strict';

const SEMANTIC_TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const GOOGLE_SEMANTIC_MODELS = new Set(['gemini-3.6-flash']);

const integer = (value, fallback, minimum = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

function getSemanticAIConfig(env = process.env) {
  const provider = String(env.SEMANTIC_AI_PROVIDER || env.PRIMARY_AI_PROVIDER || 'openrouter').trim().toLowerCase();
  const model = String(env.SEMANTIC_AI_MODEL || env.PRIMARY_AI_MODEL || '').trim();
  const approvedModels = new Set(String(env.SEMANTIC_AI_APPROVED_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean));
  const fallbackProvider = String(env.SEMANTIC_AI_FALLBACK_PROVIDER || '').trim().toLowerCase();
  const fallbackModel = String(env.SEMANTIC_AI_FALLBACK_MODEL || '').trim();
  const fallback = fallbackProvider && fallbackModel && approvedModels.has(fallbackModel)
    ? { provider: fallbackProvider, model: fallbackModel } : null;
  return {
    provider,
    model,
    attemptTimeoutMs: integer(env.SEMANTIC_AI_ATTEMPT_TIMEOUT_MS, 45000, 1000),
    totalBudgetMs: integer(env.SEMANTIC_AI_TOTAL_BUDGET_MS, 90000, 1000),
    maxRetries: integer(env.SEMANTIC_AI_MAX_RETRIES, 1, 0),
    retryDelayMs: integer(env.SEMANTIC_AI_RETRY_DELAY_MS, 2000, 0),
    minAttemptBudgetMs: integer(env.SEMANTIC_AI_MIN_ATTEMPT_BUDGET_MS, 10000, 1000),
    maxOutputTokens: integer(env.SEMANTIC_AI_MAX_OUTPUT_TOKENS, 2400, 256),
    fallback,
    approvedModels: [...approvedModels]
  };
}

function credentialFor(provider, env = process.env) {
  if (provider === 'openrouter') return String(env.OPENROUTER_API_KEY || '').trim();
  if (provider === 'openai') return String(env.OPENAI_API_KEY || '').trim();
  if (provider === 'google') return String(env.GEMINI_API_KEY || '').trim();
  return '';
}

function endpointFor(provider, env = process.env) {
  if (provider === 'openrouter') return `${String(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/u, '')}/chat/completions`;
  if (provider === 'openai') return `${String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/u, '')}/chat/completions`;
  if (provider === 'google') return String(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/u, '');
  return '';
}

function getSemanticAIConfigStatus(config = getSemanticAIConfig(), env = process.env) {
  const providerConfigured = ['google', 'openrouter', 'openai'].includes(config.provider);
  const modelConfigured = Boolean(config.model) && (config.provider !== 'google' || GOOGLE_SEMANTIC_MODELS.has(config.model));
  const credentialConfigured = Boolean(credentialFor(config.provider, env));
  return { providerConfigured, modelConfigured, credentialConfigured,
    configured: providerConfigured && modelConfigured && credentialConfigured };
}

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function classifyTransient(error) {
  if (SEMANTIC_TRANSIENT_STATUSES.has(Number(error?.status))) return true;
  return ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code);
}

function timeoutError() {
  const error = new Error('Semantic provider attempt timed out');
  error.name = 'TimeoutError';
  error.code = 'AI_PROVIDER_TIMEOUT';
  return error;
}

function providerResponseError(code, stage, metadata = {}) {
  const error = new Error('Semantic provider returned an unusable response');
  error.code = code;
  error.validationStage = stage;
  Object.assign(error, metadata);
  return error;
}

async function providerAttempt({ messages, provider, model, maxOutputTokens, attemptTimeoutMs, fetchImpl, env, now }) {
  const credential = credentialFor(provider, env);
  const endpoint = endpointFor(provider, env);
  if (!credential || !endpoint || !model) {
    const error = new Error('Semantic AI provider configuration is incomplete.');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  if (provider === 'google' && !GOOGLE_SEMANTIC_MODELS.has(model)) {
    const error = new Error('Semantic AI provider configuration is incomplete.');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  const google = provider === 'google';
  const systemText = messages.filter((item) => item?.role === 'system').map((item) => String(item.content || '')).join('\n');
  const requestBody = JSON.stringify(google ? {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents: messages.filter((item) => item?.role !== 'system').map((item) => ({
      role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(item.content || '') }]
    })),
    generationConfig: { temperature: 0.1, maxOutputTokens, responseMimeType: 'application/json' }
  } : { model, messages, temperature: 0.1, max_tokens: maxOutputTokens, response_format: { type: 'json_object' } });
  const startedAt = now();
  const signal = AbortSignal.timeout(attemptTimeoutMs);
  let response;
  try {
    const requestEndpoint = google ? `${endpoint}/models/${encodeURIComponent(model)}:generateContent` : endpoint;
    response = await fetchImpl(requestEndpoint, { method: 'POST', headers: {
      ...(google ? { 'x-goog-api-key': credential } : { Authorization: `Bearer ${credential}` }), 'Content-Type': 'application/json',
      ...(provider === 'openrouter' ? { 'HTTP-Referer': env.FRONTEND_URL || 'http://localhost:4200', 'X-Title': 'RoznaComarker' } : {})
    }, body: requestBody, signal });
  } catch (error) {
    if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw timeoutError();
    throw error;
  }
  const headersAt = now();
  if (!response.ok) {
    const rawErrorBody = await response.text().catch(() => '');
    let googleError = null;
    if (google) {
      try { googleError = JSON.parse(rawErrorBody)?.error || null; } catch { /* safe metadata unavailable */ }
    }
    const error = new Error(`Semantic provider request failed (${response.status})`);
    error.status = response.status;
    error.httpStatus = response.status;
    error.code = `HTTP_${response.status}`;
    error.retryAfterMs = retryAfterMs(response, headersAt);
    if (googleError && typeof googleError === 'object') {
      error.googleErrorStatus = typeof googleError.status === 'string' ? googleError.status.slice(0, 80) : null;
      error.googleErrorCode = Number.isFinite(Number(googleError.code)) ? Number(googleError.code) : null;
    }
    throw error;
  }
  const rawBody = await response.text();
  const completedAt = now();
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { throw providerResponseError('AI_PROVIDER_RESPONSE_INVALID', 'provider_json'); }
  const candidates = google && Array.isArray(payload?.candidates) ? payload.candidates : [];
  const candidateCount = candidates.length;
  const finishReason = google && typeof candidates[0]?.finishReason === 'string' ? candidates[0].finishReason : null;
  const blockReason = google && typeof payload?.promptFeedback?.blockReason === 'string' ? payload.promptFeedback.blockReason : null;
  const googleMetadata = { candidateCount, finishReason, blockReason };
  if (google && (blockReason || finishReason === 'SAFETY')) {
    throw providerResponseError('GOOGLE_RESPONSE_BLOCKED', 'provider_response', googleMetadata);
  }
  const content = google ? (Array.isArray(candidates[0]?.content?.parts) ? candidates[0].content.parts : [])
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text).join('') : payload?.choices?.[0]?.message?.content || '';
  if (google && !content.trim()) {
    throw providerResponseError(finishReason === 'MAX_TOKENS' ? 'GOOGLE_OUTPUT_TRUNCATED' : 'GOOGLE_RESPONSE_EMPTY',
      'provider_response', { ...googleMetadata, responseTextLength: content.length });
  }
  const usage = google && payload?.usageMetadata ? {
    prompt_tokens: payload.usageMetadata.promptTokenCount,
    completion_tokens: payload.usageMetadata.candidatesTokenCount,
    total_tokens: payload.usageMetadata.totalTokenCount
  } : payload?.usage || null;
  return { content, usage, signal, candidateCount: google ? candidateCount : null,
    finishReason: google ? finishReason : null, blockReason: google ? blockReason : null, responseTextLength: content.length,
    timings: { semanticProviderConnectMs: null, semanticTimeToFirstByteMs: headersAt - startedAt,
      semanticProviderMs: completedAt - startedAt }, provider, model };
}

async function runSemanticCompletion({ messages, config = getSemanticAIConfig(), fetchImpl = global.fetch,
  env = process.env, now = Date.now, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onAttempt, onRetry } = {}) {
  if (!Array.isArray(messages) || typeof fetchImpl !== 'function') throw new Error('Semantic completion input is invalid');
  if (!getSemanticAIConfigStatus(config, env).configured) {
    const error = new Error('Semantic AI provider configuration is incomplete.'); error.code = 'AI_PROVIDER_NOT_CONFIGURED'; throw error;
  }
  const startedAt = now();
  const deadline = startedAt + config.totalBudgetMs;
  const maxAttempts = config.maxRetries + 1;
  let lastError = null;
  let timeoutCount = 0;
  let retryDelayTotalMs = 0;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < config.minAttemptBudgetMs) {
      const error = new Error('Semantic processing budget exhausted before another attempt could start');
      error.code = 'SEMANTIC_BUDGET_EXHAUSTED'; error.cause = lastError; throw error;
    }
    const target = attempt > 1 && config.fallback ? config.fallback : { provider: config.provider, model: config.model };
    const attemptTimeoutMs = Math.min(config.attemptTimeoutMs, remaining);
    const attemptStartedAt = now();
    if (typeof onAttempt === 'function') await onAttempt({ attempt, maxAttempts, provider: target.provider, model: target.model,
      attemptTimeoutMs, remainingBudgetMs: remaining });
    try {
      const result = await providerAttempt({ messages, provider: target.provider, model: target.model,
        maxOutputTokens: config.maxOutputTokens, attemptTimeoutMs, fetchImpl, env, now });
      attempts.push({ attempt, provider: target.provider, model: target.model, durationMs: result.timings.semanticProviderMs, status: 'completed' });
      return { ...result, metrics: { attemptCount: attempt, timeoutCount, retryDelayMs: retryDelayTotalMs,
        semanticProviderMs: result.timings.semanticProviderMs, semanticTimeToFirstByteMs: result.timings.semanticTimeToFirstByteMs,
        semanticProviderConnectMs: null, outputTokenCount: Number(result.usage?.completion_tokens) || null,
        inputTokenCount: Number(result.usage?.prompt_tokens) || null, attempts, totalBudgetMs: config.totalBudgetMs } };
    } catch (error) {
      lastError = error;
      const transient = classifyTransient(error);
      if (error?.code === 'AI_PROVIDER_TIMEOUT' || ['AbortError', 'TimeoutError'].includes(error?.name)) timeoutCount += 1;
      attempts.push({ attempt, provider: target.provider, model: target.model, status: transient ? 'transient_failure' : 'permanent_failure',
        code: error?.code || null, durationMs: now() - attemptStartedAt });
      if (!transient || attempt >= maxAttempts) throw error;
      const requestedDelay = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : config.retryDelayMs;
      const remainingAfterFailure = deadline - now();
      if (requestedDelay + config.minAttemptBudgetMs > remainingAfterFailure) {
        const budgetError = new Error('Semantic processing budget exhausted before retry');
        budgetError.code = 'SEMANTIC_BUDGET_EXHAUSTED'; budgetError.cause = error; throw budgetError;
      }
      retryDelayTotalMs += requestedDelay;
      if (typeof onRetry === 'function') await onRetry({ attempt, maxAttempts, delayMs: requestedDelay,
        code: error?.code || 'SEMANTIC_TRANSIENT_FAILURE', remainingBudgetMs: remainingAfterFailure,
        nextProvider: attempt === 1 && config.fallback ? config.fallback.provider : config.provider,
        nextModel: attempt === 1 && config.fallback ? config.fallback.model : config.model });
      if (requestedDelay) await sleepFn(requestedDelay);
    }
  }
  throw lastError || new Error('Semantic completion failed');
}

module.exports = { SEMANTIC_TRANSIENT_STATUSES, getSemanticAIConfig, getSemanticAIConfigStatus, retryAfterMs,
  GOOGLE_SEMANTIC_MODELS, credentialFor, endpointFor, classifyTransient, providerResponseError, providerAttempt, runSemanticCompletion };
