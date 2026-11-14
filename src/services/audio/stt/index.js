'use strict';
// Speech-to-text: one provider-agnostic call. AUDIO_STT_PROVIDER picks the provider (default deepgram). The OpenAI fallback is an explicit
// opt-in: it runs only when AUDIO_STT_FALLBACK_ENABLED=true AND OPENAI_API_KEY is set AND the primary failed with a retryable error, and then
// only once (no failover loop). Otherwise it is never called and never receives audio. Retries over time belong to the job worker, not here.
// One metric line per provider attempt: provider, outcome, code, status, timing and sizes; never text, names, paths or keys.
const fs = require('fs');
const logger = require('../../../utils/logger');
const { readLimits } = require('../policy');
const { SttError } = require('./errors');

const PROVIDERS = Object.freeze({ deepgram: require('./deepgram'), openai: require('./openai') });

const effectiveTimeoutMs = (env = process.env) => readLimits(env).limits.sttTimeoutMs;

/** Whether the fallback may run for this failure. The key is checked for presence only, never read into any output. */
function fallbackAllowed(limits, env, primaryError) {
  if (!limits.sttFallbackEnabled || !limits.sttFallbackProvider || !primaryError?.retryable) return false;
  return Boolean(String(env[PROVIDERS[limits.sttFallbackProvider].KEY_VARIABLE] || '').trim());
}

async function attempt(name, { audio, contentType, env, fetchImpl, signal, timeoutMs, now }) {
  const startedAt = Date.now();
  try {
    const transcript = await PROVIDERS[name].transcribe({ audio, contentType, env, fetchImpl, signal, timeoutMs, now });
    logger.metric({ event: 'audio_stt_attempt', provider: name, outcome: 'ok', code: null, durationMs: Date.now() - startedAt,
      audioBytes: Number(audio.size) || 0, wordCount: transcript.words.length, wordTimingsAvailable: transcript.wordTimingsAvailable,
      providerRequestId: transcript.providerRequestId });
    return transcript;
  } catch (caught) {
    const error = caught instanceof SttError ? caught : new SttError('AUDIO_STT_PROVIDER_ERROR', { provider: name });
    if (!error.provider) error.provider = name;
    logger.metric({ event: 'audio_stt_attempt', provider: name, outcome: 'failed', code: error.code, retryable: error.retryable,
      httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs, durationMs: Date.now() - startedAt, audioBytes: Number(audio.size) || 0 });
    throw error;
  }
}

/**
 * Transcribes one stored recording. Returns { transcript (frozen, stored schema), attempts: [{ provider, outcome, code }], fallbackUsed }.
 * Throws SttError: code, retryable, provider, httpStatus and, after a failed fallback, primaryCode.
 * `timeoutMs` overrides AUDIO_STT_TIMEOUT_MS (tests); `fetchImpl` defaults to the global fetch.
 */
async function transcribe({ filePath, contentType, env = process.env, fetchImpl, signal, timeoutMs, now } = {}) {
  const { limits } = readLimits(env);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : limits.sttTimeoutMs;
  let audio;
  try { audio = await fs.openAsBlob(filePath, { type: contentType }); } catch { throw new SttError('AUDIO_STT_FILE_UNAVAILABLE'); }
  const options = { audio, contentType, env, fetchImpl, signal, timeoutMs: deadline, now };
  const attempts = [];
  try {
    const transcript = await attempt(limits.sttProvider, options);
    attempts.push({ provider: limits.sttProvider, outcome: 'ok', code: null });
    return { transcript, attempts, fallbackUsed: false };
  } catch (primary) {
    attempts.push({ provider: limits.sttProvider, outcome: 'failed', code: primary.code });
    if (!fallbackAllowed(limits, env, primary)) throw primary;
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
