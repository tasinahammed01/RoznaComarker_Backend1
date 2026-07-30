'use strict';

const gateway = require('./aiGateway.service');

async function generateChatCompletion(messages, options = {}) {
  const result = await gateway.generate({
    feature: options.feature || 'general',
    messages,
    maxOutputTokens: Number(options.max_tokens || options.maxOutputTokens) || 8000,
    temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.4,
    responseFormat: options.response_format ? 'json' : 'text',
    validate: options.validate,
    metadata: options.metadata,
    env: options.env || process.env,
    fetchImpl: options.fetchImpl || global.fetch,
    now: options.now || Date.now,
    sleepFn: options.sleepFn,
    onAttempt: options.onAttempt,
    onRetry: options.onRetry
  });
  if (typeof options.onResponse === 'function') {
    await options.onResponse({ usage: result.usage, model: result.model, provider: result.provider,
      attempts: result.attempts, fallbackUsed: result.fallbackUsed });
  }
  return result.content;
}

// Legacy function names remain callable for compatibility, but they intentionally
// cannot select a provider/model. Every call executes the global ordered chain.
const generateWithOpenRouter = generateChatCompletion;
const generateWithOpenAI = generateChatCompletion;
const generateWithGemini = generateChatCompletion;

function getAIConfigStatus(env = process.env) {
  const validation = gateway.validateAIConfig(env);
  return { providerConfigured: validation.isValid, modelConfigured: validation.isValid,
    credentialConfigured: validation.isValid, configured: validation.isValid };
}

module.exports = {
  generateChatCompletion,
  generateWithOpenRouter,
  generateWithOpenAI,
  generateWithGemini,
  validateAIConfig: gateway.validateAIConfig,
  getAIConfigStatus
};
