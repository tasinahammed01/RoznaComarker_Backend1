'use strict';
// Request profile of the handwriting spacing and capitals check. Fixed in code, never configurable: the gateway owns the rest of the
// request shape (temperature 0, reasoning low, Google AI Studio standard tier only, no fallbacks).
module.exports = Object.freeze({
  REQUEST_PROFILE: 'handwriting_mechanics_v1',
  MODEL: 'google/gemini-3.8-flash',
  SEED: 20261105,
  REASONING_EFFORT: 'low',
  MAX_OUTPUT_TOKENS: 4000
});
