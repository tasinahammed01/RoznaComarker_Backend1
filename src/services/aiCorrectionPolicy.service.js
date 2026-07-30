'use strict';

const CATEGORY_POLICY = Object.freeze({
  CONTENT: Object.freeze({ minimumConfidence: 0.75, primarySource: 'AI' }),
  ORGANIZATION: Object.freeze({ minimumConfidence: 0.75, primarySource: 'AI' }),
  VOCABULARY: Object.freeze({ minimumConfidence: 0.80, primarySource: 'LANGUAGETOOL' }),
  GRAMMAR: Object.freeze({ minimumConfidence: 0.85, primarySource: 'LANGUAGETOOL' }),
  MECHANICS: Object.freeze({ minimumConfidence: 0.90, primarySource: 'LANGUAGETOOL' })
});
const POLICY_VERSION = 'ai-correction-policy-v1';

const ENV_KEYS = Object.freeze({
  CONTENT: 'AI_CORRECTION_CONTENT_MIN_CONFIDENCE',
  ORGANIZATION: 'AI_CORRECTION_ORGANIZATION_MIN_CONFIDENCE',
  VOCABULARY: 'AI_CORRECTION_VOCABULARY_MIN_CONFIDENCE',
  GRAMMAR: 'AI_CORRECTION_GRAMMAR_MIN_CONFIDENCE',
  MECHANICS: 'AI_CORRECTION_MECHANICS_MIN_CONFIDENCE'
});

const MAX_AI_CORRECTIONS = 40;
const MAX_AI_CORRECTIONS_PER_CATEGORY = 12;
const SEVERITIES = new Set(['low', 'medium', 'high']);

function boundedConfidence(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function confidenceThresholds(env = process.env) {
  return Object.freeze(Object.fromEntries(Object.entries(CATEGORY_POLICY).map(([category, policy]) => [
    category, boundedConfidence(env[ENV_KEYS[category]], policy.minimumConfidence)
  ])));
}

function minimumConfidence(category, env = process.env) {
  return confidenceThresholds(env)[String(category || '').toUpperCase()];
}

module.exports = {
  CATEGORY_POLICY,
  POLICY_VERSION,
  ENV_KEYS,
  MAX_AI_CORRECTIONS,
  MAX_AI_CORRECTIONS_PER_CATEGORY,
  SEVERITIES,
  confidenceThresholds,
  minimumConfidence
};
