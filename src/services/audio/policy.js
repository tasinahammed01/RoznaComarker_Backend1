'use strict';
// Audio upload and speech-to-text: the feature switch and the limits. Everything is read from the environment at call time (no restart is needed
// for a test or a config change to apply), every value has a safe default, and a value that is not a whole number or is outside its range is
// ignored. Ignored values are reported by variable NAME only, never by value (a misplaced key must never reach a log).

/** AUDIO_STT_ENABLED=true turns the feature on. Anything else, or unset, leaves it off. */
const audioSttEnabled = (env = process.env) => String(env.AUDIO_STT_ENABLED || '').trim().toLowerCase() === 'true';

// openrouter-scribe: ElevenLabs Scribe v2 through OpenRouter (services/audio/stt/openrouterScribe.js). Chosen only by setting it here.
const PROVIDERS = Object.freeze(['deepgram', 'openai', 'openrouter-scribe']);
// Fixed rules (not configurable): a recording must be at least 5 s long, and the measured duration may exceed the maximum by 1 s (encoders
// pad the last frame, so a 7:00 recording can measure 7:00.4).
const MIN_DURATION_SECONDS = 5;
const DURATION_TOLERANCE_SECONDS = 1;

// [variable, key, default, minimum, maximum]. The file ceiling stays under the proxy's 52 MB request limit (deploy/nginx); the timeout floor
// keeps a provider call meaningful and the ceiling stays well under the worker lease.
const INTEGER_SETTINGS = Object.freeze([
  ['AUDIO_MAX_FILE_BYTES', 'maxFileBytes', 41943040, 1024 * 1024, 50 * 1024 * 1024],
  ['AUDIO_MAX_DURATION_SECONDS', 'maxDurationSeconds', 420, MIN_DURATION_SECONDS + 1, 1800],
  ['AUDIO_DAILY_MINUTES_PER_TEACHER', 'dailyMinutesPerTeacher', 120, 1, 100000],
  ['AUDIO_MONTHLY_MINUTES_PER_TEACHER', 'monthlyMinutesPerTeacher', 1500, 1, 1000000],
  ['AUDIO_STT_TIMEOUT_MS', 'sttTimeoutMs', 300000, 10000, 600000],
  ['AUDIO_STT_MAX_ATTEMPTS', 'sttMaxAttempts', 3, 1, 3],
  // OpenRouter Scribe only: its multipart upload limit is 25 MB (a larger file gets a 400) and there is no base64 route for Scribe, so the
  // upload limit with this provider is min(AUDIO_MAX_FILE_BYTES, this). Default 20 MiB keeps a margin; the ceiling stays under 25 MB.
  ['AUDIO_STT_OPENROUTER_MAX_FILE_BYTES', 'openrouterMaxFileBytes', 20 * 1024 * 1024, 1024 * 1024, 25000000]
]);
const OPENROUTER_CAP_SETTING = INTEGER_SETTINGS.find(([name]) => name === 'AUDIO_STT_OPENROUTER_MAX_FILE_BYTES');

/** The OpenRouter Scribe upload cap in bytes (AUDIO_STT_OPENROUTER_MAX_FILE_BYTES, default 20 MiB; an invalid value gives the default). */
function openrouterMaxFileBytes(env = process.env) {
  const [name, , fallback, minimum, maximum] = OPENROUTER_CAP_SETTING;
  return readInteger(env, name, fallback, minimum, maximum, []);
}

function readInteger(env, name, fallback, minimum, maximum, issues) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = /^\d+$/u.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) { issues.push(name); return fallback; }
  return value;
}

function readProvider(env, name, fallback, issues) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!PROVIDERS.includes(value)) { issues.push(name); return fallback; }
  return value;
}

// Transcription retry schedule (job worker): the wait after attempt 1, 2 and 3. The last value is also the ceiling for a provider's
// Retry-After hint.
const STT_BACKOFF_MS = Object.freeze([15000, 60000, 300000]);
const MAX_STT_BACKOFF_MS = STT_BACKOFF_MS[STT_BACKOFF_MS.length - 1];

/** { limits (frozen), issues: [variable names that were ignored] }. */
function readLimits(env = process.env) {
  const issues = [];
  const limits = {};
  for (const [name, key, fallback, minimum, maximum] of INTEGER_SETTINGS) limits[key] = readInteger(env, name, fallback, minimum, maximum, issues);
  if (limits.monthlyMinutesPerTeacher < limits.dailyMinutesPerTeacher) {
    issues.push('AUDIO_MONTHLY_MINUTES_PER_TEACHER');
    limits.dailyMinutesPerTeacher = INTEGER_SETTINGS[2][2];
    limits.monthlyMinutesPerTeacher = INTEGER_SETTINGS[3][2];
  }
  limits.sttProvider = readProvider(env, 'AUDIO_STT_PROVIDER', 'deepgram', issues);
  // The OpenAI fallback is an explicit opt-in (AUDIO_STT_FALLBACK_ENABLED=true): recordings may be the voices of students under 18, so they never
  // reach a second vendor by default. It exists only behind Deepgram; with OpenAI as the primary there is nothing to fall back to.
  limits.sttFallbackEnabled = String(env.AUDIO_STT_FALLBACK_ENABLED || '').trim().toLowerCase() === 'true';
  if (limits.sttFallbackEnabled && limits.sttProvider !== 'deepgram') { issues.push('AUDIO_STT_FALLBACK_ENABLED'); limits.sttFallbackEnabled = false; }
  limits.sttFallbackProvider = limits.sttFallbackEnabled ? 'openai' : null;
  // With OpenRouter Scribe the upload itself is refused above the provider cap (the same AUDIO_TOO_LARGE answer, with the capped size).
  const maxFileBytes = limits.sttProvider === 'openrouter-scribe' ? Math.min(limits.maxFileBytes, limits.openrouterMaxFileBytes) : limits.maxFileBytes;
  return {
    limits: Object.freeze({
      maxFileBytes,
      maxDurationSeconds: limits.maxDurationSeconds,
      durationToleranceSeconds: DURATION_TOLERANCE_SECONDS,
      minDurationSeconds: MIN_DURATION_SECONDS,
      dailyMinutesPerTeacher: limits.dailyMinutesPerTeacher,
      monthlyMinutesPerTeacher: limits.monthlyMinutesPerTeacher,
      sttTimeoutMs: limits.sttTimeoutMs,
      sttMaxAttempts: limits.sttMaxAttempts,
      sttProvider: limits.sttProvider,
      sttFallbackEnabled: limits.sttFallbackEnabled,
      sttFallbackProvider: limits.sttFallbackProvider
    }),
    issues
  };
}

const maxAcceptedDurationSeconds = limits => limits.maxDurationSeconds + limits.durationToleranceSeconds;

/**
 * What the signed-in client may see: whether the feature is on and the limits a person needs to pick a file. Never provider names, timeouts,
 * attempts or keys. The teacher minute caps are shown to teachers only.
 */
function publicConfig(env = process.env, { role } = {}) {
  if (!audioSttEnabled(env)) return { enabled: false };
  const { limits } = readLimits(env);
  return {
    enabled: true, maxFileBytes: limits.maxFileBytes, maxDurationSeconds: limits.maxDurationSeconds, minDurationSeconds: limits.minDurationSeconds,
    ...(role === 'teacher' ? { dailyMinutesPerTeacher: limits.dailyMinutesPerTeacher, monthlyMinutesPerTeacher: limits.monthlyMinutesPerTeacher } : {})
  };
}

module.exports = { audioSttEnabled, readLimits, maxAcceptedDurationSeconds, publicConfig, openrouterMaxFileBytes, PROVIDERS, MIN_DURATION_SECONDS,
  DURATION_TOLERANCE_SECONDS, STT_BACKOFF_MS, MAX_STT_BACKOFF_MS };
