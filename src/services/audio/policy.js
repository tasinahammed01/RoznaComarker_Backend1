'use strict';
// Audio upload and speech-to-text: the feature switch and the limits. Everything is read from the environment at call time (no restart is needed
// for a test or a config change to apply), every value has a safe default, and a value that is not a whole number or is outside its range is
// ignored. Ignored values are reported by variable NAME only, never by value (a misplaced key must never reach a log).

/** AUDIO_STT_ENABLED=true turns the feature on. Anything else, or unset, leaves it off. */
const audioSttEnabled = (env = process.env) => String(env.AUDIO_STT_ENABLED || '').trim().toLowerCase() === 'true';

const PROVIDERS = Object.freeze(['deepgram', 'openai']);
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
  ['AUDIO_STT_MAX_ATTEMPTS', 'sttMaxAttempts', 3, 1, 3]
]);

function readInteger(env, name, fallback, minimum, maximum, issues) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = /^\d+$/u.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) { issues.push(name); return fallback; }
  return value;
}

function readProvider(env, name, fallback, issues, { allowNone }) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (allowNone && value === 'none') return null;
  if (!PROVIDERS.includes(value)) { issues.push(name); return fallback; }
  return value;
}

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
  limits.sttProvider = readProvider(env, 'AUDIO_STT_PROVIDER', 'deepgram', issues, { allowNone: false });
  limits.sttFallbackProvider = readProvider(env, 'AUDIO_STT_FALLBACK_PROVIDER', null, issues, { allowNone: true });
  if (limits.sttFallbackProvider && limits.sttFallbackProvider === limits.sttProvider) {
    issues.push('AUDIO_STT_FALLBACK_PROVIDER');
    limits.sttFallbackProvider = null;
  }
  return {
    limits: Object.freeze({
      maxFileBytes: limits.maxFileBytes,
      maxDurationSeconds: limits.maxDurationSeconds,
      durationToleranceSeconds: DURATION_TOLERANCE_SECONDS,
      minDurationSeconds: MIN_DURATION_SECONDS,
      dailyMinutesPerTeacher: limits.dailyMinutesPerTeacher,
      monthlyMinutesPerTeacher: limits.monthlyMinutesPerTeacher,
      sttTimeoutMs: limits.sttTimeoutMs,
      sttMaxAttempts: limits.sttMaxAttempts,
      sttProvider: limits.sttProvider,
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

module.exports = { audioSttEnabled, readLimits, maxAcceptedDurationSeconds, publicConfig, PROVIDERS, MIN_DURATION_SECONDS, DURATION_TOLERANCE_SECONDS };
