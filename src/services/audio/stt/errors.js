'use strict';
// One error type for every speech-to-text failure. Messages are fixed, safe texts: never the provider's reply, a key, a path, a file name or
// any transcript text. `retryable` drives the job worker: 408, 429, 5xx, network failures and timeouts are worth another try; every other 4xx
// and bad input are final. `retryAfterMs` is the provider's Retry-After, as a hint only, capped at the worker's backoff ceiling.
const { MAX_STT_BACKOFF_MS } = require('../policy');

const MESSAGES = Object.freeze({
  AUDIO_STT_NOT_CONFIGURED: 'Speech-to-text is not configured.',
  AUDIO_STT_FILE_UNAVAILABLE: 'The recording could not be read.',
  AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER: 'The recording is too large for the speech-to-text provider.',
  AUDIO_STT_REJECTED: 'The speech-to-text provider refused the recording.',
  AUDIO_STT_RATE_LIMITED: 'The speech-to-text provider is busy.',
  AUDIO_STT_PROVIDER_ERROR: 'The speech-to-text provider is unavailable.',
  AUDIO_STT_NETWORK: 'The speech-to-text provider could not be reached.',
  AUDIO_STT_TIMEOUT: 'The speech-to-text provider took too long to answer.',
  AUDIO_STT_CANCELLED: 'Transcription was cancelled.',
  AUDIO_STT_BAD_RESPONSE: 'The speech-to-text provider sent an unreadable answer.'
});
const RETRYABLE = new Set(['AUDIO_STT_RATE_LIMITED', 'AUDIO_STT_PROVIDER_ERROR', 'AUDIO_STT_NETWORK', 'AUDIO_STT_TIMEOUT', 'AUDIO_STT_BAD_RESPONSE']);

class SttError extends Error {
  constructor(code, { provider = null, httpStatus = null, detail = null, retryAfterMs = null } = {}) {
    super(detail ? `${MESSAGES[code] || MESSAGES.AUDIO_STT_PROVIDER_ERROR} (${detail})` : (MESSAGES[code] || MESSAGES.AUDIO_STT_PROVIDER_ERROR));
    this.name = 'SttError';
    this.code = MESSAGES[code] ? code : 'AUDIO_STT_PROVIDER_ERROR';
    this.retryable = RETRYABLE.has(this.code);
    this.provider = provider;
    this.httpStatus = httpStatus;
    this.retryAfterMs = this.retryable && Number.isFinite(retryAfterMs) ? retryAfterMs : null;
  }
}

/**
 * Retry-After as milliseconds from `nowMs`: whole seconds ("120") or an HTTP date. Never below 0, never above the backoff ceiling.
 * Anything else (missing, negative, fractional, unparseable) is null: the worker then uses its own schedule.
 */
function retryAfterHintMs(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let ms;
  if (/^\d+$/u.test(text)) ms = Number(text) * 1000;
  else if (/[a-z]/iu.test(text) && /\d{4}/u.test(text)) {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    ms = Math.max(0, at - nowMs);
  } else return null;
  return Number.isFinite(ms) ? Math.min(ms, MAX_STT_BACKOFF_MS) : null;
}

/** 408 timeout and 429 rate limit: retryable. Every other 4xx: final. 5xx (and any other non-2xx): retryable. */
function fromHttpStatus(status, provider, { retryAfter = null, nowMs = Date.now() } = {}) {
  const code = status === 408 ? 'AUDIO_STT_TIMEOUT' : status === 429 ? 'AUDIO_STT_RATE_LIMITED'
    : status >= 400 && status < 500 ? 'AUDIO_STT_REJECTED' : 'AUDIO_STT_PROVIDER_ERROR';
  return new SttError(code, { provider, httpStatus: status, retryAfterMs: retryAfterHintMs(retryAfter, nowMs) });
}

module.exports = { SttError, fromHttpStatus, retryAfterHintMs, MESSAGES };
