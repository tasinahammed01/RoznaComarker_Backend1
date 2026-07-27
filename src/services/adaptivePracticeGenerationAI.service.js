'use strict';

const { providerAttempt } = require('./semanticAIClient.service');

function config(env = process.env) {
  const provider = String(env.ADAPTIVE_PRACTICE_AI_PROVIDER || 'google').trim().toLowerCase();
  const model = String(env.ADAPTIVE_PRACTICE_AI_MODEL || 'gemini-3.6-flash').trim();
  const timeoutMs = Number.parseInt(env.ADAPTIVE_PRACTICE_AI_TIMEOUT_MS, 10) || 60000;
  const maxOutputTokens = Number.parseInt(env.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS, 10) || 4000;
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  return { provider, model, timeoutMs, maxOutputTokens,
    configured: provider === 'google' && model === 'gemini-3.6-flash' && Boolean(apiKey) };
}

async function generate(messages, { timeoutMs, env = process.env, fetchImpl = global.fetch, now = Date.now } = {}) {
  const current = config(env);
  if (!current.configured) {
    const error = new Error('Adaptive Practice Gemini is not configured.');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  return providerAttempt({
    messages,
    provider: 'google',
    model: current.model,
    maxOutputTokens: current.maxOutputTokens,
    googleThinkingLevel: 'low',
    attemptTimeoutMs: Math.max(1000, Math.min(current.timeoutMs, timeoutMs || current.timeoutMs)),
    fetchImpl,
    env,
    now
  });
}

module.exports = { config, generate };
