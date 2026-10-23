'use strict';
// Opt-in internal observer. Never logs messages, URLs, headers, bodies or stacks.
const STAGES = Object.freeze(['REQUEST_BUILD_FAILURE', 'TRANSPORT_FAILURE', 'REQUEST_ABORTED',
  'HTTP_ERROR_RESPONSE', 'RESPONSE_BODY_READ_FAILURE', 'RESPONSE_JSON_PARSE_FAILURE',
  'PROVIDER_RESPONSE_SHAPE_INVALID', 'MODEL_STRUCTURED_OUTPUT_INVALID',
  'CORRECTION_SCHEMA_VALIDATION_FAILURE', 'NORMALIZATION_FAILURE']);
const safeIdentifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(value) ? value : null;
function notify(observer, { failureStage, error, safeCode, httpStatus = null, responseReceived = false, bodyRead = false,timeoutOrigin=null }) {
  if (typeof observer !== 'function') return;
  const causes = []; let current = error;
  for (let i = 0; current && i < 4; i++, current = current.cause) {
    causes.push({ name: safeIdentifier(current.name), code: safeIdentifier(current.code),
      errno: Number.isInteger(current.errno) ? current.errno : null });
  }
  const diagnostic = { failureStage, safeCode, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    responseReceived, bodyRead, internalCauseCode: causes.find(c => c.code)?.code || null, causes,
    ...(['caller_cancelled','shared_stage_deadline','local_attempt_timeout'].includes(timeoutOrigin)?{timeoutOrigin}:{}) };
  try { observer(Object.freeze(diagnostic)); } catch { /* Observer must not change gateway semantics. */ }
}
function validationStage(error) {
  if (error?.validationStage === 'json_parse' || error instanceof SyntaxError) return 'MODEL_STRUCTURED_OUTPUT_INVALID';
  if (error?.validationStage === 'canonical_validation') return 'NORMALIZATION_FAILURE';
  return 'CORRECTION_SCHEMA_VALIDATION_FAILURE';
}
function createBudgetFetch({ fetchImpl, admit, onResponseText }) {
  if (typeof fetchImpl !== 'function' || typeof admit !== 'function') throw new TypeError('Explicit transport and reservation required');
  return async (url, options) => {
    await admit(url, options); // Must reserve before transport; rejection spends nothing.
    const response = await fetchImpl(url, options);
    if (typeof onResponseText === 'function') {
      const read = response.text.bind(response);
      response.text = async () => {
        const body = await read();
        try { await onResponseText(body, response); } catch { /* Diagnostic storage failure cannot invalidate a provider response. */ }
        return body;
      };
    }
    return response;
  };
}
module.exports = { STAGES, notify, validationStage, createBudgetFetch };
