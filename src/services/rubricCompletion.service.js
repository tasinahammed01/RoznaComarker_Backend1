'use strict';

const { runSemanticCompletion, getSemanticAIConfigStatus } = require('./semanticAIClient.service');
const { getRubricAiConfig } = require('./rubricAiConfig.service');
const { repairAiRubric } = require('../utils/aiRubricRepair');
const { normalizeRubricDesignerPayload } = require('../utils/rubricNormalizer');
const logger = require('../utils/logger');

class RubricCompletionError extends Error {
  constructor(code, statusCode, message, metadata = {}) { super(message); this.code = code; this.statusCode = statusCode; Object.assign(this, metadata); }
}

function validateRubric(value) {
  const rubric = normalizeRubricDesignerPayload(value);
  if (!rubric || typeof rubric.title !== 'string' || !rubric.title.trim()
    || !Array.isArray(rubric.levels) || rubric.levels.length < 3 || rubric.levels.length > 5
    || !Array.isArray(rubric.criteria) || rubric.criteria.length < 3 || rubric.criteria.length > 10) return null;
  if (!rubric.levels.every((level) => level && typeof level.title === 'string' && level.title.trim()
    && Number.isInteger(level.maxPoints) && level.maxPoints >= 0)) return null;
  if (!rubric.criteria.every((criterion) => criterion && typeof criterion.title === 'string' && criterion.title.trim()
    && Array.isArray(criterion.cells) && criterion.cells.length === rubric.levels.length
    && criterion.cells.every((cell) => typeof cell === 'string'))) return null;
  return rubric;
}

function statusFor(error) {
  if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED') return 501;
  if (error?.code === 'AI_PROVIDER_TIMEOUT') return 504;
  if (error?.code === 'HTTP_429') return 429;
  if (['GOOGLE_RESPONSE_EMPTY', 'GOOGLE_RESPONSE_BLOCKED', 'GOOGLE_OUTPUT_TRUNCATED',
    'AI_PROVIDER_RESPONSE_INVALID', 'RUBRIC_RESPONSE_INVALID'].includes(error?.code)) return 422;
  return 502;
}

async function completeRubric({ systemInstruction, userPrompt, assignmentId, submissionId }, dependencies = {}) {
  const env = dependencies.env || process.env;
  const config = dependencies.config || getRubricAiConfig(env);
  if (!getSemanticAIConfigStatus(config, env).configured) throw new RubricCompletionError('AI_PROVIDER_NOT_CONFIGURED', 501, 'AI provider not configured');
  const startedAt = Date.now();
  try {
    const completion = await (dependencies.runCompletion || runSemanticCompletion)({
      messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userPrompt }], config, env,
      fetchImpl: dependencies.fetchImpl || global.fetch, sleepFn: dependencies.sleepFn
    });
    let parsed = null;
    try { parsed = JSON.parse(String(completion.content || '').trim()); } catch { /* normalized below without content logging */ }
    const rubric = validateRubric(repairAiRubric(parsed) || parsed);
    if (!rubric) throw new RubricCompletionError('RUBRIC_RESPONSE_INVALID', 422, 'Invalid or incomplete JSON rubric returned from AI', {
      finishReason: completion.finishReason, candidateCount: completion.candidateCount, responseTextLength: completion.responseTextLength
    });
    logger.info({ message: 'Rubric AI completion', provider: completion.provider, model: completion.model,
      attempt: completion.metrics?.attemptCount || 1, durationMs: Date.now() - startedAt, httpStatus: 200,
      finishReason: completion.finishReason || null, candidateCount: completion.candidateCount ?? null,
      responseTextLength: completion.responseTextLength ?? String(completion.content || '').length,
      errorCode: null, assignmentId: assignmentId || null, submissionId: submissionId || null });
    return rubric;
  } catch (error) {
    const normalized = error instanceof RubricCompletionError ? error
      : new RubricCompletionError(error?.code || 'RUBRIC_PROVIDER_FAILED', statusFor(error),
        statusFor(error) === 429 ? 'AI quota exceeded. Please try again later.'
          : statusFor(error) === 504 ? 'AI request timed out. Please try again.'
          : statusFor(error) === 422 ? 'Invalid AI rubric response.' : 'AI rubric provider failed.', {
          httpStatus: error?.httpStatus || error?.status || null, finishReason: error?.finishReason || null,
          candidateCount: error?.candidateCount ?? null, responseTextLength: error?.responseTextLength ?? null
        });
    logger.warn({ message: 'Rubric AI completion failed', provider: config.provider, model: config.model,
      attempt: error?.attempt || 0, durationMs: Date.now() - startedAt, httpStatus: normalized.httpStatus || null,
      finishReason: normalized.finishReason || null, candidateCount: normalized.candidateCount ?? null,
      responseTextLength: normalized.responseTextLength ?? null, errorCode: normalized.code,
      assignmentId: assignmentId || null, submissionId: submissionId || null });
    throw normalized;
  }
}

module.exports = { RubricCompletionError, validateRubric, statusFor, completeRubric };
