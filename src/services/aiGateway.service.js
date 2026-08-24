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
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30000;
const finalizationReserve = (remainingMs) =>
  Math.min(FINALIZATION_RESERVE_MS, Math.max(1, Math.floor(remainingMs / 10)));

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
  const retriesPerModel = integer(env.AI_RETRIES_PER_MODEL, DEFAULTS.retriesPerModel, 0, MAX_RETRIES);
  const primaryRetries = integer(env.AI_PRIMARY_RETRIES, retriesPerModel, 0, MAX_RETRIES);
  const fallbackRetries = integer(env.AI_FALLBACK_RETRIES, retriesPerModel, 0, MAX_RETRIES);
  const retryDelayMs = integer(env.AI_RETRY_DELAY_MS, DEFAULTS.retryDelayMs, 0);
  if ([attemptTimeoutMs, totalBudgetMs, retriesPerModel, primaryRetries, fallbackRetries,
    retryDelayMs].includes(null)) {
    issues.push('One or more global AI timeout/retry values are invalid.');
  }
  if (issues.length) throw configurationError(issues);
  return { chain, attemptTimeoutMs, totalBudgetMs, retriesPerModel, primaryRetries,
    fallbackRetries, retryDelayMs };
}

function getAssessmentAIConfig(env = process.env, options = {}) {
  const assessmentOrGlobal = (assessmentKey, globalKey) =>
    text(env[assessmentKey]) ? env[assessmentKey] : env[globalKey];
  const assessmentEnv = { ...env,
    AI_PRIMARY_PROVIDER: text(env.ASSESSMENT_AI_PRIMARY_PROVIDER) || 'openrouter',
    AI_PRIMARY_MODEL: text(env.ASSESSMENT_AI_PRIMARY_MODEL) || 'openai/gpt-4.1',
    AI_FALLBACK_1_PROVIDER: text(env.ASSESSMENT_AI_FALLBACK_1_PROVIDER) || 'openrouter',
    AI_FALLBACK_1_MODEL: text(env.ASSESSMENT_AI_FALLBACK_1_MODEL) || 'openai/gpt-4.1-mini',
    // Assessment is intentionally a closed paid chain. Never inherit or append
    // global/free fallbacks beyond the one explicitly declared assessment fallback.
    AI_FALLBACK_2_PROVIDER: '',
    AI_FALLBACK_2_MODEL: '',
    AI_FALLBACK_3_PROVIDER: '',
    AI_FALLBACK_3_MODEL: '',
    AI_ATTEMPT_TIMEOUT_MS: assessmentOrGlobal('ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS', 'AI_ATTEMPT_TIMEOUT_MS'),
    AI_TOTAL_BUDGET_MS: assessmentOrGlobal('ASSESSMENT_AI_TOTAL_BUDGET_MS', 'AI_TOTAL_BUDGET_MS'),
    AI_PRIMARY_RETRIES: assessmentOrGlobal('ASSESSMENT_AI_PRIMARY_RETRIES', 'AI_PRIMARY_RETRIES'),
    AI_FALLBACK_RETRIES: assessmentOrGlobal('ASSESSMENT_AI_FALLBACK_RETRIES', 'AI_FALLBACK_RETRIES'),
    AI_RETRY_DELAY_MS: assessmentOrGlobal('ASSESSMENT_AI_RETRY_DELAY_MS', 'AI_RETRY_DELAY_MS')
  };
  const config = getAIConfig(assessmentEnv, options);
  if (config.primaryRetries > 1 || config.fallbackRetries !== 0) {
    throw configurationError(['Assessment AI permits at most one primary retry and no fallback retries.']);
  }
  return config;
}

function sanitizedAssessmentChain(env = process.env) {
  return getAssessmentAIConfig(env).chain.map((entry, index) => Object.freeze({
    index, role: index === 0 ? 'primary' : `fallback_${index}`,
    provider: entry.provider, model: entry.model
  }));
}

function safeCode(error) {
  const status = Number(error?.status || error?.httpStatus);
  if (error?.code && String(error.code).startsWith('AI_')) return error.code;
  if (status === 400) return 'AI_PROVIDER_INVALID_REQUEST';
  if (status === 401) return 'AI_PROVIDER_AUTH_ERROR';
  if (status === 402) return 'AI_PROVIDER_PAYMENT_REQUIRED';
  if (status === 403) return 'AI_PROVIDER_PERMISSION_DENIED';
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

function googleUsage(payload) {
  const usage = payload?.usageMetadata;
  return usage ? {
    prompt_tokens: usage.promptTokenCount,
    completion_tokens: usage.candidatesTokenCount,
    thoughts_tokens: usage.thoughtsTokenCount,
    total_tokens: usage.totalTokenCount
  } : null;
}

function safeFailureMetadata(error) {
  const allowed = ['httpStatus', 'finishReason', 'promptTokenCount', 'candidateTokenCount',
    'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'maxOutputTokens',
    'responseTextLength', 'candidateCount', 'validationCode', 'validationStage', 'jsonPath',
    'expected', 'actualType', 'category', 'symbol', 'candidateIndex', 'transcriptHashMatch',
    'requiredPropertyMissing', 'unexpectedPropertyPresent', 'expectedSymbolCount',
    'receivedSymbolCount', 'missingSymbols', 'duplicateSymbols', 'unexpectedSymbols',
    'providerErrorCode', 'providerErrorMessage', 'providerErrorParameter', 'providerErrorMetadata',
    'schemaName', 'schemaPath'];
  return Object.fromEntries(allowed.filter((key) => error?.[key] !== undefined && error?.[key] !== null)
    .map((key) => [key, error[key]]));
}

function extractGoogle(payload, { maxOutputTokens } = {}) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const candidate = candidates[0];
  const finishReason = text(candidate?.finishReason).toUpperCase();
  const blockReason = text(payload?.promptFeedback?.blockReason);
  const content = Array.isArray(candidate?.content?.parts) ? candidate.content.parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text).join('') : '';
  const usage = googleUsage(payload);
  const metadata = {
    finishReason: finishReason || null,
    promptTokenCount: usage?.prompt_tokens,
    candidateTokenCount: usage?.completion_tokens,
    candidatesTokenCount: usage?.completion_tokens,
    thoughtsTokenCount: usage?.thoughts_tokens,
    totalTokenCount: usage?.total_tokens,
    maxOutputTokens,
    responseTextLength: content.length,
    candidateCount: candidates.length
  };
  if (blockReason || finishReason === 'SAFETY') throw attemptError('AI_RESPONSE_BLOCKED', 'AI response was blocked.');
  if (['MAX_TOKENS', 'LENGTH'].includes(finishReason))
    throw attemptError('AI_RESPONSE_TRUNCATED', 'AI response was truncated.', metadata);
  if (!candidates.length) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no candidates.');
  if (!Array.isArray(candidate?.content?.parts)) throw attemptError('AI_RESPONSE_INVALID', 'AI provider response structure is invalid.');
  if (!content.trim()) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no text.');
  return { content, finishReason: finishReason || null, usage, ...metadata };
}

function extractOpenRouter(payload, { maxOutputTokens } = {}) {
  const choice = payload?.choices?.[0];
  const finishReason = text(choice?.finish_reason).toLowerCase();
  const content = choice?.message?.content;
  const metadata = { finishReason: finishReason || null, maxOutputTokens,
    responseTextLength: typeof content === 'string' ? content.length : 0,
    candidateCount: Array.isArray(payload?.choices) ? payload.choices.length : 0 };
  if (['length', 'max_tokens'].includes(finishReason))
    throw attemptError('AI_RESPONSE_TRUNCATED', 'AI response was truncated.', metadata);
  if (typeof content !== 'string' || !content.trim()) throw attemptError('AI_RESPONSE_EMPTY', 'AI provider returned no text.');
  return { content, finishReason: finishReason || null, ...metadata };
}

function safeSchemaName(value) {
  const safe = String(value || 'structured_response').toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64);
  return safe || 'structured_response';
}
const boundedProviderField = (value, maximum = 240) => typeof value === 'string'
  ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, maximum) : null;

function safeProviderErrorDetails(payloadError) {
  const outer = payloadError && typeof payloadError === 'object' ? payloadError : {};
  let inner = null;
  const raw = outer?.metadata?.raw;
  if (typeof raw === 'string' && raw.length <= 12000) {
    try {
      const parsed = JSON.parse(raw);
      inner = parsed?.error && typeof parsed.error === 'object' ? parsed.error : null;
    } catch {
      inner = null;
    }
  }
  const specific = inner || outer;
  const metadata = {
    provider: boundedProviderField(outer?.metadata?.provider_name, 80),
    type: boundedProviderField(specific?.type, 80),
    reason: boundedProviderField(specific?.metadata?.reason || specific?.reason, 240)
  };
  return {
    code: boundedProviderField(String(specific?.code || outer?.code || specific?.type || ''), 80),
    message: boundedProviderField(specific?.message || outer?.message, 800),
    parameter: boundedProviderField(specific?.param || outer?.param, 160),
    path: boundedProviderField(specific?.metadata?.path || specific?.path || specific?.param
      || outer?.metadata?.path || outer?.path || outer?.param, 240),
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value))
  };
}

function googleBody(messages, maxOutputTokens, temperature, responseFormat, thinkingLevel, model,
  responseSchema) {
  const supportedThinkingLevel = /^gemini-3(?:\.|[-])/iu.test(String(model || ''))
    && ['minimal', 'low', 'medium', 'high'].includes(thinkingLevel);
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
      ...(supportedThinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      ...(responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
      ...(responseFormat === 'json' && responseSchema ? { responseJsonSchema: responseSchema } : {})
    }
  };
}

async function providerAttempt({ entry, messages, maxOutputTokens, temperature, responseFormat,
  responseSchema, schemaName, attemptTimeoutMs, fetchImpl, env, now, googleThinkingLevel, feature }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
  const started = now();
  try {
    const google = entry.provider === 'google';
    const base = endpointFor(entry.provider, env).replace(/\/$/u, '');
    const url = google
      ? `${base}/models/${encodeURIComponent(entry.model)}:generateContent`
      : `${base}/chat/completions`;
    const body = google ? googleBody(messages, maxOutputTokens, temperature, responseFormat,
      googleThinkingLevel, entry.model, responseSchema) : {
      model: entry.model, messages, temperature, max_tokens: maxOutputTokens,
      ...(responseFormat === 'json' && responseSchema ? { response_format: {
        type: 'json_schema', json_schema: { name: safeSchemaName(schemaName || feature), strict: true,
          schema: responseSchema }
      } } : responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {})
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
    const responseText = await response.text();
    let payload;
    try { payload = JSON.parse(responseText); }
    catch {
      if (!response.ok) throw attemptError(safeCode({ status: response.status }),
        'AI provider request failed.', { status: response.status, retryAfterMs: retryAfterMs(response, now()) });
      throw attemptError('AI_RESPONSE_INVALID', 'AI provider returned invalid JSON transport.');
    }
    const payloadError = payload && typeof payload.error === 'object' ? payload.error : null;
    if (!response.ok || payloadError) {
      const payloadStatus = Number(payloadError?.status || payloadError?.code);
      const status = Number.isInteger(payloadStatus) && payloadStatus >= 400 && payloadStatus <= 599
        ? payloadStatus : response.ok ? 500 : response.status;
      const providerDetails = safeProviderErrorDetails(payloadError);
      throw attemptError(safeCode({ status }), 'AI provider request failed.', {
        status, retryAfterMs: retryAfterMs(response, now()),
        providerErrorCode: providerDetails.code,
        // Provider text is retained only for schema/invalid-request failures;
        // other error messages may contain billing or account details.
        providerErrorMessage: status === 400 ? providerDetails.message : null,
        providerErrorParameter: status === 400 ? providerDetails.parameter : null,
        providerErrorMetadata: status === 400 ? providerDetails.metadata : null,
        schemaName: safeSchemaName(schemaName || feature),
        schemaPath: status === 400 ? providerDetails.path : null
      });
    }
    const extracted = google ? extractGoogle(payload, { maxOutputTokens })
      : extractOpenRouter(payload, { maxOutputTokens });
    const usage = google ? extracted.usage : (payload.usage ? {
      ...payload.usage,
      thoughts_tokens: payload.usage?.completion_tokens_details?.reasoning_tokens
    } : null);
    return { ...extracted, usage, durationMs: now() - started };
  } catch (error) {
    if (controller.signal.aborted) throw attemptError('AI_ATTEMPT_TIMEOUT', 'AI provider attempt timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ feature = 'unspecified', messages, maxOutputTokens = 4000, temperature = 0.1,
  responseFormat = 'text', responseSchema, schemaName, validate, metadata = {}, googleThinkingLevel,
  env = process.env, fetchImpl = global.fetch,
  now = Date.now, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomFn = Math.random, config = getAIConfig(env), onAttempt, onRetry,
  retryableSameModelCodes = [], terminalCodes = [] } = {}) {
  if (!Array.isArray(messages) || typeof fetchImpl !== 'function') {
    throw new TypeError('AI gateway requires messages and fetch.');
  }
  const started = now();
  const requestMetadata = metadata && typeof metadata === 'object'
    ? Object.fromEntries(Object.entries(metadata).filter(([key]) =>
      /^(?:submissionId|assignmentId|jobId|ocrJobId|sourceHash|caller|purpose|requestId)$/u.test(key)))
    : {};
  const deadline = started + config.totalBudgetMs;
  const attempts = [];
  const legacyRetries = Number.isInteger(config.retriesPerModel) ? config.retriesPerModel : 0;
  const retriesFor = (entry) => entry.fallbackIndex === 0
    ? (Number.isInteger(config.primaryRetries) ? config.primaryRetries : legacyRetries)
    : (Number.isInteger(config.fallbackRetries) ? config.fallbackRetries : legacyRetries);
  const maxAttempts = config.chain.reduce((sum, entry) => sum + retriesFor(entry) + 1, 0);
  let attemptCount = 0;
  let lastError;
  for (let chainIndex = 0; chainIndex < config.chain.length; chainIndex += 1) {
    const entry = config.chain[chainIndex];
      const entryRetries = retriesFor(entry);
    for (let retry = 0; retry <= entryRetries; retry += 1) {
      const remaining = deadline - now();
      const reserve = finalizationReserve(remaining);
      if (remaining <= reserve) {
        lastError = attemptError('AI_TOTAL_BUDGET_EXHAUSTED', 'AI total budget was exhausted.');
        break;
      }
      const currentModelAttempts = entryRetries - retry + 1;
      const laterModelAttempts = config.chain.slice(chainIndex + 1)
        .reduce((sum, laterEntry) => sum + retriesFor(laterEntry) + 1, 0);
      const attemptsRemaining = currentModelAttempts + laterModelAttempts;
      // Give a configured attempt its full window whenever the total budget can
      // still fund every planned attempt. Fair-share only when the configuration
      // is intrinsically tighter or earlier calls consumed unexpected overhead.
      const fullyFunded = remaining >= config.attemptTimeoutMs * attemptsRemaining;
      const fairShare = Math.max(1, Math.floor((remaining - reserve) / attemptsRemaining));
      const timeout = fullyFunded ? config.attemptTimeoutMs : Math.min(config.attemptTimeoutMs, fairShare);
      attemptCount += 1;
      const attemptStarted = now();
      if (typeof onAttempt === 'function') await onAttempt({ attempt: attemptCount,
        attemptNumber: attemptCount, maxAttempts,
        provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
        retryIndex: retry, attemptTimeoutMs: timeout, remainingBudgetMs: remaining,
        maxOutputTokens });
      try {
        const result = await providerAttempt({ entry, messages, maxOutputTokens, temperature,
          responseFormat, responseSchema, schemaName, attemptTimeoutMs: timeout, fetchImpl, env, now,
          googleThinkingLevel, feature });
        let value = result.content;
        if (typeof validate === 'function') {
          try { value = await validate(result.content, { provider: entry.provider, model: entry.model,
            attemptIndex: attemptCount - 1, attemptNumber: attemptCount }); }
          catch (error) {
            throw attemptError('AI_OUTPUT_VALIDATION_FAILED', 'AI output failed feature validation.', {
              validationCode: error?.code || null, ...safeFailureMetadata(error), cause: error
            });
          }
        }
        attempts.push({ attemptNumber: attemptCount, maxAttempts, provider: entry.provider,
          model: entry.model, fallbackIndex: entry.fallbackIndex, retryIndex: retry,
          status: 'success', code: null, httpStatus: 200, durationMs: now() - attemptStarted,
          attemptTimeoutMs: timeout, remainingBudgetMs: Math.max(0, deadline - now()),
          maxOutputTokens, finishReason: result.finishReason || null,
          promptTokenCount: result.usage?.prompt_tokens ?? null,
          candidateTokenCount: result.usage?.completion_tokens ?? null,
          thoughtsTokenCount: result.usage?.thoughts_tokens ?? null,
          totalTokenCount: result.usage?.total_tokens ?? null,
          responseTextLength: result.responseTextLength ?? result.content.length,
          validationCode: null, retryDelayMs: null });
        const gatewayMetadata = { provider: entry.provider, model: entry.model, attemptCount,
          fallbackIndex: entry.fallbackIndex, fallbackUsed: entry.fallbackIndex > 0,
          durationMs: now() - started, usage: result.usage || null, attempts };
        logger.info({ message: 'AI gateway generation completed', feature, ...requestMetadata, ...gatewayMetadata,
          usage: undefined, attempts: attempts.map((a) => ({ ...a })) });
        return { value, content: result.content, ...gatewayMetadata, metadata: gatewayMetadata };
      } catch (error) {
        lastError = error;
        const code = safeCode(error);
        const failureMetadata = safeFailureMetadata(error);
        const httpStatus = Number(error?.status || error?.httpStatus) || null;
        const attemptRecord = { attemptNumber: attemptCount, maxAttempts,
          provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
          retryIndex: retry, status: 'failed', code, httpStatus,
          durationMs: now() - attemptStarted, attemptTimeoutMs: timeout,
          remainingBudgetMs: Math.max(0, deadline - now()), maxOutputTokens,
          retryDelayMs: null, ...failureMetadata };
        attempts.push(attemptRecord);
        logger.warn({ message: 'AI gateway attempt failed', feature, ...requestMetadata, attemptNumber: attemptCount,
          maxAttempts,
          provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
          retryIndex: retry, durationMs: now() - attemptStarted, attemptTimeoutMs: timeout,
          remainingBudgetMs: Math.max(0, deadline - now()), maxOutputTokens, code, httpStatus,
          retryDelayMs: null,
          ...failureMetadata });
        if (terminalCodes.includes(code)) {
          // Preserve sanitized attempt diagnostics for the canonical failure
          // record while preventing a terminal account/request failure from
          // being repeated against another model.
          error.attempts = attempts.map((attempt) => ({ ...attempt }));
          error.attemptCount = attempts.length;
          error.provider = entry.provider;
          error.model = entry.model;
          error.durationMs = now() - started;
          throw error;
        }
        const status = Number(error?.status || error?.httpStatus);
        const retryableSameModel = retry < entryRetries
          && (RETRYABLE_HTTP.has(status) || ['AI_ATTEMPT_TIMEOUT', 'AI_PROVIDER_UNAVAILABLE'].includes(code)
            || retryableSameModelCodes.includes(code));
        if (retryableSameModel) {
          const baseDelay = Math.min(MAX_RETRY_DELAY_MS,
            Math.max(0, config.retryDelayMs) * (2 ** retry));
          const jitter = 0.5 + Math.max(0, Math.min(1, Number(randomFn()) || 0)) * 0.5;
          const calculated = Math.round(baseDelay * jitter);
          const requested = Number.isFinite(error?.retryAfterMs)
            ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, error.retryAfterMs)) : calculated;
          const beforeSleepRemaining = deadline - now();
          const sleepBudget = beforeSleepRemaining - finalizationReserve(beforeSleepRemaining);
          if (requested > sleepBudget) {
            lastError = attemptError('AI_TOTAL_BUDGET_EXHAUSTED', 'AI total budget was exhausted.');
            break;
          }
          attemptRecord.retryDelayMs = requested;
          logger.info({ message: 'AI gateway retry scheduled', feature, ...requestMetadata,
            attemptNumber: attemptCount, maxAttempts, provider: entry.provider,
            model: entry.model, fallbackIndex: entry.fallbackIndex, retryIndex: retry,
            durationMs: attemptRecord.durationMs, attemptTimeoutMs: timeout,
            remainingBudgetMs: Math.max(0, deadline - now()), maxOutputTokens, code,
            httpStatus, finishReason: attemptRecord.finishReason || null,
            promptTokenCount: attemptRecord.promptTokenCount ?? null,
            candidateTokenCount: attemptRecord.candidateTokenCount
              ?? attemptRecord.candidatesTokenCount ?? null,
            thoughtsTokenCount: attemptRecord.thoughtsTokenCount ?? null,
            totalTokenCount: attemptRecord.totalTokenCount ?? null,
            responseTextLength: attemptRecord.responseTextLength ?? null,
            validationCode: attemptRecord.validationCode ?? null, retryDelayMs: requested });
          if (typeof onRetry === 'function') await onRetry({ attempt: attemptCount,
            attemptNumber: attemptCount, maxAttempts, delayMs: requested, retryDelayMs: requested,
            code, provider: entry.provider, model: entry.model, fallbackIndex: entry.fallbackIndex,
            retryIndex: retry, remainingBudgetMs: deadline - now() });
          if (requested > 0) await sleepFn(requested);
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
  error.validationDiagnostics = lastError?.cause?.diagnostics || lastError?.diagnostics || null;
  error.feature = feature;
  error.metadata = requestMetadata;
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
  SUPPORTED_PROVIDERS, DEFAULTS, MAX_RETRIES, MAX_RETRY_DELAY_MS, credentialFor, endpointFor,
  getAIConfig, getAssessmentAIConfig, sanitizedAssessmentChain, validateAIConfig,
  retryAfterMs, safeCode, extractGoogle, extractOpenRouter, googleUsage, safeFailureMetadata,
  safeSchemaName, safeProviderErrorDetails, googleBody, providerAttempt, generate
};
