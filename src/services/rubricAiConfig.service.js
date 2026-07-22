'use strict';

const { getSemanticAIConfig } = require('./semanticAIClient.service');

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.min(maximum, parsed) : fallback;
};
const value = (env, name) => typeof env[name] === 'string' ? env[name].trim() : '';

function getRubricAiConfig(env = process.env) {
  const semantic = getSemanticAIConfig(env);
  return {
    provider: (value(env, 'RUBRIC_AI_PROVIDER') || value(env, 'SEMANTIC_AI_PROVIDER') || semantic.provider).toLowerCase(),
    model: value(env, 'RUBRIC_AI_MODEL') || value(env, 'SEMANTIC_AI_MODEL') || semantic.model,
    attemptTimeoutMs: integer(value(env, 'RUBRIC_AI_TIMEOUT_MS'), 60000, 1000, 120000),
    totalBudgetMs: integer(value(env, 'RUBRIC_AI_TOTAL_BUDGET_MS'), 90000, 1000, 180000),
    maxRetries: integer(value(env, 'RUBRIC_AI_MAX_RETRIES'), 1, 0, 2),
    retryDelayMs: integer(value(env, 'RUBRIC_AI_RETRY_DELAY_MS'), 1000, 0, 30000),
    minAttemptBudgetMs: 1000,
    maxOutputTokens: integer(value(env, 'RUBRIC_AI_MAX_OUTPUT_TOKENS'), 4000, 1200, 8000),
    fallback: semantic.fallback,
    approvedModels: semantic.approvedModels
  };
}

module.exports = { getRubricAiConfig };
