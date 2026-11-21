'use strict';
// Speech-to-text: one provider-agnostic call. AUDIO_STT_PROVIDER picks the provider (default deepgram). The OpenAI fallback is an explicit
// opt-in: it runs only when AUDIO_STT_FALLBACK_ENABLED=true AND OPENAI_API_KEY is set AND the primary failed with a retryable error, and then
// only once (no failover loop). Otherwise it is never called and never receives audio. Retries over time belong to the job worker, not here.
// One metric line per provider attempt: provider, outcome, code, status, timing and sizes; never text, names, paths or keys.
// AUDIO_STT_UNRELIABLE_RESULT (OpenRouter Scribe's suspicious-response check) is retried ONCE here, inside the same job attempt (so the
// minutes reserved for that attempt are counted once). A clean second answer is used. When both answers are suspicious: a HARD flag in either
// fails; two SOFT-only answers (end gap, speaking-rate window: what silence looks like) that agree (transcriptGuard.compareRuns) are accepted,
// otherwise it fails with RUNS_DISAGREE. Only reason codes and numbers are logged.
const fs = require('fs');
const logger = require('../../../utils/logger');
const { readLimits } = require('../policy');
const { SttError } = require('./errors');
const { compareRuns } = require('./transcriptGuard');

const PROVIDERS = Object.freeze({ deepgram: require('./deepgram'), openai: require('./openai'), 'openrouter-scribe': require('./openrouterScribe') });

const effectiveTimeoutMs = (env = process.env) => readLimits(env).limits.sttTimeoutMs;

/** Whether the fallback may run for this failure. The key is checked for presence only, never read into any output. */
function fallbackAllowed(limits, env, primaryError) {
  if (!limits.sttFallbackEnabled || !limits.sttFallbackProvider || !primaryError?.retryable) return false;
  return Boolean(String(env[PROVIDERS[limits.sttFallbackProvider].KEY_VARIABLE] || '').trim());
}

async function attempt(name, { audio, contentType, env, fetchImpl, signal, timeoutMs, now, expectedDurationSeconds }) {
  const startedAt = Date.now();
  try {
    const transcript = await PROVIDERS[name].transcribe({ audio, contentType, env, fetchImpl, signal, timeoutMs, now, expectedDurationSeconds });
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
const UNRELIABLE = 'AUDIO_STT_UNRELIABLE_RESULT';
const logUnreliable = (provider, error, retry) => logger.metric({ event: 'audio_stt_unreliable_result', provider, retry,
  reasons: Array.isArray(error.reasons) ? error.reasons : [], metrics: error.metrics || {}, ...(error.comparison ? { comparison: error.comparison } : {}) });
// Hard flags of a suspicious answer; anything unclassified counts as hard (safe side).
const hardOf = error => (Array.isArray(error?.hard) ? error.hard : Array.isArray(error?.reasons) ? error.reasons : ['UNCLASSIFIED']);

async function transcribe({ filePath, contentType, env = process.env, fetchImpl, signal, timeoutMs, now, expectedDurationSeconds = null } = {}) {
  const { limits } = readLimits(env);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : limits.sttTimeoutMs;
  let audio;
  try { audio = await fs.openAsBlob(filePath, { type: contentType }); } catch { throw new SttError('AUDIO_STT_FILE_UNAVAILABLE'); }
  const options = { audio, contentType, env, fetchImpl, signal, timeoutMs: deadline, now, expectedDurationSeconds };
  const attempts = [];
  try {
    const transcript = await attempt(limits.sttProvider, options);
    attempts.push({ provider: limits.sttProvider, outcome: 'ok', code: null });
    return { transcript, attempts, fallbackUsed: false };
  } catch (primary) {
    if (primary.code === UNRELIABLE) {
      attempts.push({ provider: limits.sttProvider, outcome: 'suspicious', code: UNRELIABLE });
      logUnreliable(limits.sttProvider, primary, 'first');
      // Once more; a provider error on this second call is what the job worker sees.
      let second;
      try {
        const transcript = await attempt(limits.sttProvider, options);
        attempts.push({ provider: limits.sttProvider, outcome: 'ok', code: null });
        return { transcript, attempts, fallbackUsed: false };
      } catch (caught) {
        if (caught.code !== UNRELIABLE) throw caught;
        second = caught;
      }
      if (!hardOf(primary).length && !hardOf(second).length && primary.transcript && second.transcript) {
        const comparison = compareRuns(primary.transcript, second.transcript, { durationSeconds: expectedDurationSeconds });
        if (comparison.agree) {
          attempts.push({ provider: limits.sttProvider, outcome: 'accepted_soft', code: null });
          logger.metric({ event: 'audio_stt_soft_flag_accepted', provider: limits.sttProvider,
            reasons: [...new Set([...(primary.reasons || []), ...(second.reasons || [])])], comparison });
          return { transcript: second.transcript, attempts, fallbackUsed: false };
        }
        second.reasons = [...(second.reasons || []), 'RUNS_DISAGREE'];
        second.comparison = comparison;
      }
      logUnreliable(limits.sttProvider, second, 'second');
      throw second;
    }
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
