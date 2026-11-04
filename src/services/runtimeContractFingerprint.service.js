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
  const contract = semanticCorrections.contractVersions(require('./aiGateway.service').correctionModel(env));
  const contracts = Object.freeze({
    correctionPrompt: contract.promptVersion,
    correctionSchema: contract.schemaVersion,
    rubricPrompt: semanticRubric.contractVersions(require('./aiGateway.service').assessmentModel(env)).promptVersion,
    rubricSchema: semanticRubric.SCHEMA_VERSION,
    ...(semanticRubric.contractVersions(require('./aiGateway.service').assessmentModel(env)).wireVersion
      ? {rubricWire:semanticRubric.contractVersions(require('./aiGateway.service').assessmentModel(env)).wireVersion}:{}),
    rubricModel: require('./aiGateway.service').assessmentModel(env),
    rubricReasoningEffort: require('./aiGateway.service').assessmentModel(env)===require('./aiGateway.service').GEMINI_RUBRIC_MODEL
      ? require('./aiGateway.service').rubricReasoningEffort(env) : 'provider_default',
    canonicalCorrection: canonicalCorrections.VERSION,
    canonicalEvaluation: canonicalEvaluation.VERSION,
    qwenSourceWire:require('./gptVisionExact/contract').QWEN_WIRE_VERSION,
    qwenSourcePrompt:require('./gptVisionExact/contract').QWEN_PROMPT_VERSION
  });
  const orderedContractValues = [
    contracts.correctionPrompt, contracts.correctionSchema, contracts.rubricPrompt,
    contracts.rubricSchema, contracts.canonicalCorrection, contracts.canonicalEvaluation, contracts.rubricModel, contracts.rubricReasoningEffort
  ];
  if(contracts.rubricWire)orderedContractValues.push(contracts.rubricWire);
  orderedContractValues.push(contracts.qwenSourceWire);
  orderedContractValues.push(contracts.qwenSourcePrompt);
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
