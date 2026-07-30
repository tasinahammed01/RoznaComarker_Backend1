'use strict';

const gateway = require('./aiGateway.service');

function config(env = process.env) {
  try {
    const global = gateway.getAIConfig(env);
    const primary = global.chain[0];
    return { ...global, provider: primary.provider, model: primary.model,
      timeoutMs: global.attemptTimeoutMs,
      maxOutputTokens: Number.parseInt(env.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS, 10) || 3000,
      configured: true };
  } catch {
    return { provider: '', model: '', maxOutputTokens: 3000, configured: false };
  }
}

async function generate(messages, { timeoutMs, env = process.env, fetchImpl = global.fetch,
  now = Date.now, validate } = {}) {
  const current = config(env);
  if (!current.configured) {
    const error = new Error('Adaptive Practice AI is not configured.');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const result = await gateway.generate({ feature: 'adaptive_practice_generation', messages,
    maxOutputTokens: current.maxOutputTokens, responseFormat: 'json', validate,
    env, fetchImpl, now, config: {
      chain: current.chain,
      attemptTimeoutMs: Math.min(current.attemptTimeoutMs, timeoutMs || current.attemptTimeoutMs),
      totalBudgetMs: current.totalBudgetMs,
      retriesPerModel: current.retriesPerModel,
      retryDelayMs: current.retryDelayMs
    } });
  return { content: result.content, value: result.value, usage: result.usage, provider: result.provider, model: result.model,
    metadata: result.metadata, timings: { semanticProviderMs: result.durationMs } };
}

module.exports = { config, generate };
