'use strict';
/**
 * Safety gate for paid calls. runEvaluation() calls authorizeRun() before ANY request is made (the free
 * catalog lookup included) and uses the returned `mode` to choose between simulated and real models.
 *
 *  - without --live the run is always a dry run: simulated models, no network
 *  - --live needs an API key in the environment and --confirm N, where N is exactly the number of calls
 *    the plan will make (calls already saved by --resume are not counted)
 */
const { isFakeModel } = require('./fakeModel.cjs');

class GuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

function authorizeRun({ live, confirm, plannedCalls, apiKeyPresent, models, maxCostUsd }) {
  if (!live) {
    if (confirm !== undefined) {
      throw new GuardError('--confirm only applies with --live. This run is a dry run: no network, no cost.', 'CONFIRM_WITHOUT_LIVE');
    }
    return { mode: 'dry-run', paidCalls: false };
  }
  const fakes = models.filter(isFakeModel);
  if (fakes.length) {
    throw new GuardError(`Fake models (${fakes.join(', ')}) are simulations and cannot be used with --live.`, 'FAKE_MODEL_IN_LIVE');
  }
  if (maxCostUsd !== undefined && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
    throw new GuardError('--max-cost-usd must be a number greater than 0.', 'BAD_COST_CAP');
  }
  if (!apiKeyPresent) {
    throw new GuardError('--live needs OPENROUTER_API_KEY in the environment. Nothing was sent.', 'NO_API_KEY');
  }
  if (confirm === undefined) {
    throw new GuardError(`This run would make ${plannedCalls} paid call(s). Nothing was sent. Re-run with --confirm ${plannedCalls} to proceed.`, 'CONFIRM_REQUIRED');
  }
  if (!Number.isInteger(confirm) || confirm !== plannedCalls) {
    throw new GuardError(`--confirm ${confirm} does not match the ${plannedCalls} call(s) this run would make. Nothing was sent. Use --confirm ${plannedCalls}.`, 'CONFIRM_MISMATCH');
  }
  return { mode: 'live', paidCalls: plannedCalls > 0 };
}

module.exports = { GuardError, isFakeModel, authorizeRun };
