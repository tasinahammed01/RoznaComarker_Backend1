'use strict';

const gateway = require('./aiGateway.service');
const MAX_OUTPUT_TOKENS = 65536;
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

function config(env = process.env) {
  try {
    const global = gateway.getAssessmentAIConfig(env);
    const primary = global.chain[0];
    return { ...global, provider: primary.provider, model: primary.model,
      timeoutMs: global.attemptTimeoutMs,
      maxOutputTokens: integer(env.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS, 6000, 256, MAX_OUTPUT_TOKENS),
      configured: true };
  } catch {
    return { provider: '', model: '', maxOutputTokens: 6000, configured: false };
  }
}

function singleProviderConfig(current, provider, model, timeoutMs) {
  return { chain: [{ provider, model, fallbackIndex: 0 }],
    attemptTimeoutMs: Math.min(current.attemptTimeoutMs, timeoutMs || current.attemptTimeoutMs),
    totalBudgetMs: current.totalBudgetMs, retriesPerModel: 0, primaryRetries: 0, fallbackRetries: 0,
    retryDelayMs: current.retryDelayMs };
}

async function generate(messages, { timeoutMs, env = process.env, fetchImpl = global.fetch,
  now = Date.now, validate, responseSchema } = {}) {
  const current = config(env);
  if (!current.configured) {
    const error = new Error('Adaptive Practice AI is not configured.');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const result = await gateway.generate({ feature: 'adaptive_practice_generation', messages,
    maxOutputTokens: current.maxOutputTokens, responseFormat: 'json', responseSchema,
    schemaName: 'adaptive_practice_activities', validate,
    googleThinkingLevel: 'minimal',
    env, fetchImpl, now, config: {
      chain: current.chain,
      attemptTimeoutMs: Math.min(current.attemptTimeoutMs, timeoutMs || current.attemptTimeoutMs),
      totalBudgetMs: current.totalBudgetMs,
      retriesPerModel: current.retriesPerModel,
      primaryRetries: current.primaryRetries,
      fallbackRetries: current.fallbackRetries,
      retryDelayMs: current.retryDelayMs
    } });
  return { content: result.content, value: result.value, usage: result.usage, provider: result.provider, model: result.model,
    metadata: result.metadata, timings: { semanticProviderMs: result.durationMs } };
}

async function repair(messages, { provider, model, timeoutMs, env = process.env,
  fetchImpl = global.fetch, now = Date.now, validate, responseSchema } = {}) {
  const current = config(env);
  const result = await gateway.generate({ feature: 'adaptive_practice_generation_repair', messages,
    maxOutputTokens: current.maxOutputTokens, responseFormat: 'json', responseSchema,
    schemaName: 'adaptive_practice_activities_repair', validate, googleThinkingLevel: 'minimal',
    env, fetchImpl, now, config: singleProviderConfig(current, provider, model, timeoutMs) });
  return { content: result.content, value: result.value, usage: result.usage,
    provider: result.provider, model: result.model, metadata: result.metadata };
}

module.exports = { config, generate, repair };
