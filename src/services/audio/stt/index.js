'use strict';
// Speech-to-text: one provider-agnostic call. AUDIO_STT_PROVIDER picks the provider (default deepgram). A fallback is used only when
// AUDIO_STT_FALLBACK_PROVIDER is set, only after a RETRYABLE primary failure, and only once: no failover loop. Retries over time belong to the
// job worker, not here. One metric line per provider attempt: provider, outcome, code, status, timing and sizes; never text, names, paths or keys.
const fs = require('fs');
const logger = require('../../../utils/logger');
const { readLimits } = require('../policy');
const { SttError } = require('./errors');

const PROVIDERS = Object.freeze({ deepgram: require('./deepgram'), openai: require('./openai') });

const effectiveTimeoutMs = (env = process.env) => readLimits(env).limits.sttTimeoutMs;

async function attempt(name, { audio, contentType, env, fetchImpl, signal, timeoutMs }) {
  const startedAt = Date.now();
  try {
    const transcript = await PROVIDERS[name].transcribe({ audio, contentType, env, fetchImpl, signal, timeoutMs });
    logger.metric({ event: 'audio_stt_attempt', provider: name, outcome: 'ok', code: null, durationMs: Date.now() - startedAt,
      audioBytes: Number(audio.size) || 0, wordCount: transcript.words.length, wordTimingsAvailable: transcript.wordTimingsAvailable,
      providerRequestId: transcript.providerRequestId });
    return transcript;
  } catch (caught) {
    const error = caught instanceof SttError ? caught : new SttError('AUDIO_STT_PROVIDER_ERROR', { provider: name });
    if (!error.provider) error.provider = name;
    logger.metric({ event: 'audio_stt_attempt', provider: name, outcome: 'failed', code: error.code, retryable: error.retryable,
      httpStatus: error.httpStatus, durationMs: Date.now() - startedAt, audioBytes: Number(audio.size) || 0 });
    throw error;
  }
}

/**
 * Transcribes one stored recording. Returns { transcript (frozen, stored schema), attempts: [{ provider, outcome, code }], fallbackUsed }.
 * Throws SttError: code, retryable, provider, httpStatus and, after a failed fallback, primaryCode.
 * `timeoutMs` overrides AUDIO_STT_TIMEOUT_MS (tests); `fetchImpl` defaults to the global fetch.
 */
async function transcribe({ filePath, contentType, env = process.env, fetchImpl, signal, timeoutMs } = {}) {
  const { limits } = readLimits(env);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : limits.sttTimeoutMs;
  let audio;
  try { audio = await fs.openAsBlob(filePath, { type: contentType }); } catch { throw new SttError('AUDIO_STT_FILE_UNAVAILABLE'); }
  const options = { audio, contentType, env, fetchImpl, signal, timeoutMs: deadline };
  const attempts = [];
  try {
    const transcript = await attempt(limits.sttProvider, options);
    attempts.push({ provider: limits.sttProvider, outcome: 'ok', code: null });
    return { transcript, attempts, fallbackUsed: false };
  } catch (primary) {
    attempts.push({ provider: limits.sttProvider, outcome: 'failed', code: primary.code });
    if (!primary.retryable || !limits.sttFallbackProvider) throw primary;
    try {
      const transcript = await attempt(limits.sttFallbackProvider, options);
      attempts.push({ provider: limits.sttFallbackProvider, outcome: 'ok', code: null });
      return { transcript, attempts, fallbackUsed: true };
    } catch (fallback) {
      fallback.primaryCode = primary.code;
      // The primary failure was retryable, so the work as a whole is worth another try later.
      fallback.retryable = true;
      throw fallback;
    }
  }
}

module.exports = { transcribe, effectiveTimeoutMs, PROVIDERS };
