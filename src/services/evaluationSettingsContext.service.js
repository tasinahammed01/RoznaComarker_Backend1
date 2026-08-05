'use strict';

const User = require('../models/user.model');
const canonicalEvaluation = require('./canonicalEvaluation.service');
const { normalizeAssignmentRubric, hashNormalizedRubric } = require('./assignmentRubric.service');
const { normalizeTeacherEvaluationPolicy, evaluationPolicyHash } = require('./teacherEvaluationPolicy.service');

async function currentEvaluationSettings(assignment) {
  const normalizedRubric = normalizeAssignmentRubric(assignment || {});
  const hasValidCustomRubric = normalizedRubric.status === 'valid';
  const rubricHash = hasValidCustomRubric
    ? hashNormalizedRubric(normalizedRubric)
    : canonicalEvaluation.hashRubric(assignment);
  const teacher = assignment?.teacher
    ? await User.findById(assignment.teacher).select('aiConfig').lean()
    : null;
  const policyHash = evaluationPolicyHash(normalizeTeacherEvaluationPolicy(teacher));
  return { rubricHash, policyHash, hasValidCustomRubric };
}

module.exports = { currentEvaluationSettings };
