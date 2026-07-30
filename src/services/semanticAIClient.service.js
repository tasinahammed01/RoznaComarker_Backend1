'use strict';

// Backward-compatible facade. All provider traffic and model selection lives in
// aiGateway.service; semantic callers retain their established result shape.
const gateway = require('./aiGateway.service');

const SEMANTIC_TRANSIENT_STATUSES = new Set([402, 408, 429, 500, 502, 503, 504]);
const GOOGLE_SEMANTIC_MODELS = new Set(); // retained export; models are no longer allowlisted
const GOOGLE_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const MAX_SEMANTIC_OUTPUT_TOKENS = 65536;

const integer = (value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

function getSemanticAIConfig(env = process.env) {
  const global = gateway.getAIConfig(env);
  const primary = global.chain[0];
  return {
    provider: primary.provider,
    model: primary.model,
    chain: global.chain,
    attemptTimeoutMs: global.attemptTimeoutMs,
    totalBudgetMs: global.totalBudgetMs,
    maxRetries: global.retriesPerModel,
    retriesPerModel: global.retriesPerModel,
    retryDelayMs: global.retryDelayMs,
    minAttemptBudgetMs: 1,
    maxOutputTokens: integer(env.SEMANTIC_AI_MAX_OUTPUT_TOKENS, 5000, 256, MAX_SEMANTIC_OUTPUT_TOKENS),
    fallback: global.chain[1] || null,
    approvedModels: global.chain.map((entry) => entry.model)
  };
}

function getSemanticAIConfigStatus(config, env = process.env) {
  try {
    const resolved = config?.chain ? config : getSemanticAIConfig(env);
    return { providerConfigured: true, modelConfigured: true, credentialConfigured: true,
      configured: Array.isArray(resolved.chain) && resolved.chain.length > 0 };
  } catch {
    return { providerConfigured: false, modelConfigured: false, credentialConfigured: false, configured: false };
  }
}

function credentialFor(provider, env = process.env) { return gateway.credentialFor(provider, env); }
function endpointFor(provider, env = process.env) { return gateway.endpointFor(provider, env); }
function retryAfterMs(response, now) { return gateway.retryAfterMs(response, now); }
function classifyTransient(error) {
  const status = Number(error?.status || error?.httpStatus);
  return SEMANTIC_TRANSIENT_STATUSES.has(status)
    || ['AI_ATTEMPT_TIMEOUT', 'AI_PROVIDER_UNAVAILABLE'].includes(gateway.safeCode(error));
}
function classifyProviderFailure(error, { isPrimary = false, fallbackConfigured = false } = {}) {
  const code = gateway.safeCode(error);
  return { retrySameProvider: classifyTransient(error), tryFallbackProvider: Boolean(isPrimary && fallbackConfigured),
    terminalCode: code };
}
function approvedFallback(config) { return Boolean(config?.chain?.[1] || config?.fallback); }

async function providerAttempt(options) {
  const entry = { provider: options.provider, model: options.model, fallbackIndex: 0 };
  const result = await gateway.providerAttempt({ ...options, entry, temperature: 0.1,
    responseFormat: 'json', now: options.now || Date.now });
  return { ...result, provider: entry.provider, model: entry.model,
    hasText: Boolean(result.content), responseTextLength: result.content.length,
    timings: { semanticProviderMs: result.durationMs, semanticTimeToFirstByteMs: null,
      semanticProviderConnectMs: null } };
}

async function runSemanticCompletion({ messages, config = getSemanticAIConfig(), fetchImpl = global.fetch,
  env = process.env, now = Date.now, sleepFn, validate, feature = 'semantic', onAttempt, onRetry } = {}) {
  const chain = config.chain || gateway.getAIConfig(env).chain;
  const result = await gateway.generate({ feature, messages, maxOutputTokens: config.maxOutputTokens,
    responseFormat: 'json', validate, fetchImpl, env, now, sleepFn, onAttempt, onRetry,
    config: {
      chain,
      attemptTimeoutMs: config.attemptTimeoutMs,
      totalBudgetMs: config.totalBudgetMs,
      retriesPerModel: Number.isInteger(config.retriesPerModel) ? config.retriesPerModel : (config.maxRetries || 0),
      retryDelayMs: config.retryDelayMs
    } });
  return { content: result.content, value: result.value, usage: result.usage,
    provider: result.provider, model: result.model, metadata: result.metadata,
    timings: { semanticProviderMs: result.durationMs, semanticTimeToFirstByteMs: null,
      semanticProviderConnectMs: null },
    metrics: { attemptCount: result.attemptCount, attempts: result.attempts,
      timeoutCount: result.attempts.filter((attempt) => attempt.code === 'AI_ATTEMPT_TIMEOUT').length,
      semanticProviderMs: result.durationMs, totalBudgetMs: config.totalBudgetMs } };
}

module.exports = { SEMANTIC_TRANSIENT_STATUSES, GOOGLE_SEMANTIC_MODELS, GOOGLE_THINKING_LEVELS,
  MAX_SEMANTIC_OUTPUT_TOKENS, getSemanticAIConfig, getSemanticAIConfigStatus, credentialFor, endpointFor,
  retryAfterMs, classifyTransient, classifyProviderFailure, approvedFallback, providerAttempt,
  runSemanticCompletion };
