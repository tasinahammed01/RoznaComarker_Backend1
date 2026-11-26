'use strict';
// Speaking Coach: one model call (the task wording or a practice check) through the AI gateway, with the coach's reasoning effort, and ONE
// retry with twice the output limit (policy.truncationRetryLimit) when, and only when, the reply was cut off by its limit
// (AI_RESPONSE_TRUNCATED: a real trial showed the model's thinking using most of the budget). Any other failure is passed on as it comes.
// Used by the live coach and by the cost trial (scripts/speakingAssessmentTrial.js), so both make the same calls. Logs: codes and numbers only.
const logger = require('../../utils/logger');
const { truncationRetryLimit, reasoningEffort } = require('./policy');

const lastCode = error => String(error?.finalFailureCode || error?.attempts?.at?.(-1)?.code || error?.code || '');

/** request: the gateway.generate options without maxOutputTokens. Returns the gateway result; on failure throws the gateway's error. */
async function generateWithTruncationRetry(gateway, request, { maxOutputTokens, env = process.env }) {
  const call = limit => gateway.generate({ ...request, env: request.env || env, maxOutputTokens: limit, reasoningEffort: reasoningEffort(request.env || env) });
  try {
    return await call(maxOutputTokens);
  } catch (error) {
    if (lastCode(error) !== 'AI_RESPONSE_TRUNCATED') throw error;
    const retryLimit = truncationRetryLimit(maxOutputTokens);
    logger.metric({ event: 'speaking_coach_truncation_retry', feature: request.feature, maxOutputTokens, retryMaxOutputTokens: retryLimit });
    return call(retryLimit);
  }
}

module.exports = { generateWithTruncationRetry, lastCode };
