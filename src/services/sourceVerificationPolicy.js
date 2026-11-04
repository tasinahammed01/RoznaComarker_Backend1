'use strict';
const IMAGE = new Set(['OCR_GPT_SOURCE_UNCERTAIN', 'OCR_GPT_SOURCE_EMPTY', 'OCR_PDF_INVALID', 'OCR_PDF_PASSWORD', 'OCR_PDF_LIMIT']);
function classify(code, status) {
  if (IMAGE.has(code)) return 'image';
  if (['OCR_GPT_SOURCE_CHECKING', 'OCR_GPT_CIRCUIT_OPEN'].includes(code)) return 'waiting';
  // One internally inconsistent response is not proof of broken model access.
  // It remains rejected; only a fresh response after bounded backoff may pass.
  if (['OCR_GPT_SOURCE_CANCELLED','OCR_GPT_PROVIDER_NETWORK', 'OCR_GPT_PROVIDER_RATE_LIMIT', 'OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH', 'OCR_GPT_SOURCE_SCHEMA'].includes(code)
    || status === 408 || status === 429 || [500, 502, 503, 504].includes(status)) return 'retryable';
  return 'operator';
}
function delay(attempt, random = Math.random) {
  return Math.round(Math.min(15 * 60 * 1000, 15000 * 2 ** Math.min(6, Math.max(0, attempt - 1))) * (0.75 + random() * 0.5));
}
// Source retry eligibility is not provider health. These errors are emitted
// after a completed response passes model identity, but never accept its text.
function classifyProviderHealth(code, status) {
  if (['OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH', 'OCR_GPT_SOURCE_SCHEMA'].includes(code))
    return status == null || status >= 200 && status < 300 ? 'source_evidence' : classify('OCR_GPT_PROVIDER_FAILED', status);
  return classify(code, status);
}
// Billing is not an automatic transient retry. A later inbound request may
// probe after this cooldown; auth/access/configuration failures stay terminal.
const isPaymentFailure = code => code === 'OCR_GPT_PROVIDER_PAYMENT_REQUIRED';
module.exports = { classify, classifyProviderHealth, delay, isPaymentFailure, PAYMENT_COOLDOWN_MS: 60000, MAX_ATTEMPTS: 5 };
