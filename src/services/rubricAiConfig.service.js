'use strict';

const { getSemanticAIConfig } = require('./semanticAIClient.service');

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function getRubricAiConfig(env = process.env) {
  const global = getSemanticAIConfig(env);
  return { ...global, maxOutputTokens: integer(env.RUBRIC_AI_MAX_OUTPUT_TOKENS, 4000, 256, 65536) };
}

module.exports = { getRubricAiConfig };
