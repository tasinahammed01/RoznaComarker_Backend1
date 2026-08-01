'use strict';

const crypto = require('crypto');
const packageJson = require('../../package.json');
const semanticCorrections = require('./semanticWritingCorrections.service');
const semanticRubric = require('./semanticRubricAssessment.service');
const canonicalCorrections = require('./correctionCanonical.service');
const canonicalEvaluation = require('./canonicalEvaluation.service');

const safeRevision = (value) => {
  const revision = String(value || '').trim();
  return /^[A-Za-z0-9._/-]{1,120}$/u.test(revision) ? revision : 'local';
};

function runtimeContractFingerprint(env = process.env) {
  const contracts = Object.freeze({
    correctionPrompt: semanticCorrections.SEMANTIC_PROMPT_VERSION,
    correctionSchema: semanticCorrections.SEMANTIC_SCHEMA_VERSION,
    rubricPrompt: semanticRubric.PROMPT_VERSION,
    rubricSchema: semanticRubric.SCHEMA_VERSION,
    canonicalCorrection: canonicalCorrections.VERSION,
    canonicalEvaluation: canonicalEvaluation.VERSION
  });
  const orderedContractValues = [
    contracts.correctionPrompt, contracts.correctionSchema, contracts.rubricPrompt,
    contracts.rubricSchema, contracts.canonicalCorrection, contracts.canonicalEvaluation
  ];
  const contractHash = crypto.createHash('sha256').update(JSON.stringify(orderedContractValues)).digest('hex').slice(0, 16);
  return Object.freeze({
    applicationVersion: String(packageJson.version || 'unknown'),
    environment: String(env.NODE_ENV || 'development'),
    deploymentRevision: safeRevision(env.APP_DEPLOYMENT_REVISION),
    contracts,
    contractHash
  });
}

module.exports = { runtimeContractFingerprint, safeRevision };
