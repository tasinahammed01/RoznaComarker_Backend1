const crypto = require('crypto');

const SCORING_POLICY_VERSION = 'teacher-evaluation-policy-v1';
const DEFAULT_POLICY = Object.freeze({
  strictness: 'balanced',
  checks: Object.freeze({ grammarSpelling: true, coherenceLogic: true, factChecking: false })
});

function normalizeTeacherEvaluationPolicy(value) {
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
    strictness: policy.strictness,
    checks: policy.checks
  })).digest('hex');
}

function correctionsAllowedByPolicy(corrections, value) {
  const policy = normalizeTeacherEvaluationPolicy(value);
  return (Array.isArray(corrections) ? corrections : []).filter((correction) => {
    const category = String(correction?.category || '').toUpperCase();
    if (!policy.checks.grammarSpelling && ['GRAMMAR', 'MECHANICS'].includes(category)) return false;
    if (!policy.checks.coherenceLogic && category === 'ORGANIZATION') return false;
    return true;
  });
}

module.exports = {
  SCORING_POLICY_VERSION,
  DEFAULT_POLICY,
  normalizeTeacherEvaluationPolicy,
  evaluationPolicyHash,
  correctionsAllowedByPolicy
};
