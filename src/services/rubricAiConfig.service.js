const DEFAULT_RUBRIC_MODEL = 'openai/gpt-oss-120b';

function value(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : '';
}

function getRubricAiConfig() {
  const provider = value('PRIMARY_AI_PROVIDER') || 'openrouter';
  const model = value('RUBRIC_AI_MODEL') || value('PRIMARY_AI_MODEL') || DEFAULT_RUBRIC_MODEL;

  return {
    provider: provider.toLowerCase(),
    model,
    baseUrl: value('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1',
    timeoutMs: Math.min(60000, Math.max(1000, Number(value('OPENROUTER_TIMEOUT_MS')) || 60000)),
    maxTokens: Math.min(8000, Math.max(1200, Number(value('OPENROUTER_MAX_TOKENS')) || 4000))
  };
}

module.exports = { DEFAULT_RUBRIC_MODEL, getRubricAiConfig };
