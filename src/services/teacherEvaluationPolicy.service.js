const crypto = require('crypto');

const SCORING_POLICY_VERSION = 'teacher-evaluation-policy-v2';
const REVIEW_POLICY_VERSION = 'assessment-category-policy-v3';
const DEFAULT_POLICY = Object.freeze({
  strictness: 'balanced',
  checks: Object.freeze({ grammarSpelling: true, coherenceLogic: true, factChecking: false })
});

function normalizeTeacherEvaluationPolicy(value) {
  if (Object.isFrozen(value) && Object.isFrozen(value?.checks)
    && ['friendly', 'balanced', 'strict'].includes(value?.strictness)
    && ['grammarSpelling', 'coherenceLogic', 'factChecking'].every(key => typeof value.checks[key] === 'boolean')) return value;
  const source = value?.aiConfig && typeof value.aiConfig === 'object' ? value.aiConfig
    : value && typeof value === 'object' ? value : {};
  const strictness = ['friendly', 'balanced', 'strict'].includes(String(source.strictness || '').toLowerCase())
    ? String(source.strictness).toLowerCase() : DEFAULT_POLICY.strictness;
  const checks = source.checks && typeof source.checks === 'object' ? source.checks : {};
  return Object.freeze({
    strictness,
    checks: Object.freeze({
      grammarSpelling: typeof checks.grammarSpelling === 'boolean' ? checks.grammarSpelling : true,
      coherenceLogic: typeof checks.coherenceLogic === 'boolean' ? checks.coherenceLogic : true,
      factChecking: typeof checks.factChecking === 'boolean' ? checks.factChecking : false
    })
  });
}

function evaluationPolicyHash(value) {
  const policy = normalizeTeacherEvaluationPolicy(value);
  return crypto.createHash('sha256').update(JSON.stringify({
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    reviewPolicyVersion: REVIEW_POLICY_VERSION,
    strictness: policy.strictness,
    checks: policy.checks
  })).digest('hex');
}

function correctionsAllowedByPolicy(corrections, value) {
  const enabled = new Set(enabledCorrectionCategories(value));
  return (Array.isArray(corrections) ? corrections : []).filter((correction) => {
    const category = String(correction?.category || '').toUpperCase();
    return enabled.has(category);
  });
}

// "Check Coherence & Logic" governs meaning/development and structure together.
// Vocabulary remains part of writing quality; factual verification is separate.
function enabledCorrectionCategories(value) {
  const policy = normalizeTeacherEvaluationPolicy(value);
  return ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].filter(category =>
    (policy.checks.coherenceLogic || !['CONTENT', 'ORGANIZATION'].includes(category))
    && (policy.checks.grammarSpelling || !['GRAMMAR', 'MECHANICS'].includes(category)));
}

module.exports = {
  SCORING_POLICY_VERSION,
  REVIEW_POLICY_VERSION, enabledCorrectionCategories,
  DEFAULT_POLICY,
  normalizeTeacherEvaluationPolicy,
  evaluationPolicyHash,
  correctionsAllowedByPolicy
};
