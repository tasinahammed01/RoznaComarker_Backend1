'use strict';
// One error type for every speech-to-text failure. Messages are fixed, safe texts: never the provider's reply, a key, a path, a file name or
// any transcript text. `retryable` drives the job worker: 4xx and bad input are final, 5xx, network failures and timeouts are worth another try.
const MESSAGES = Object.freeze({
  AUDIO_STT_NOT_CONFIGURED: 'Speech-to-text is not configured.',
  AUDIO_STT_FILE_UNAVAILABLE: 'The recording could not be read.',
  AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER: 'The recording is too large for the speech-to-text provider.',
  AUDIO_STT_REJECTED: 'The speech-to-text provider refused the recording.',
  AUDIO_STT_PROVIDER_ERROR: 'The speech-to-text provider is unavailable.',
  AUDIO_STT_NETWORK: 'The speech-to-text provider could not be reached.',
  AUDIO_STT_TIMEOUT: 'The speech-to-text provider took too long to answer.',
  AUDIO_STT_CANCELLED: 'Transcription was cancelled.',
  AUDIO_STT_BAD_RESPONSE: 'The speech-to-text provider sent an unreadable answer.'
});
const RETRYABLE = new Set(['AUDIO_STT_PROVIDER_ERROR', 'AUDIO_STT_NETWORK', 'AUDIO_STT_TIMEOUT', 'AUDIO_STT_BAD_RESPONSE']);

class SttError extends Error {
  constructor(code, { provider = null, httpStatus = null, detail = null } = {}) {
    super(detail ? `${MESSAGES[code] || MESSAGES.AUDIO_STT_PROVIDER_ERROR} (${detail})` : (MESSAGES[code] || MESSAGES.AUDIO_STT_PROVIDER_ERROR));
    this.name = 'SttError';
    this.code = MESSAGES[code] ? code : 'AUDIO_STT_PROVIDER_ERROR';
    this.retryable = RETRYABLE.has(this.code);
    this.provider = provider;
    this.httpStatus = httpStatus;
  }
}

/** 4xx: final. 5xx (and anything else that is not 2xx): worth another try. */
const fromHttpStatus = (status, provider) => new SttError(status >= 400 && status < 500 ? 'AUDIO_STT_REJECTED' : 'AUDIO_STT_PROVIDER_ERROR',
  { provider, httpStatus: status });

module.exports = { SttError, fromHttpStatus, MESSAGES };
