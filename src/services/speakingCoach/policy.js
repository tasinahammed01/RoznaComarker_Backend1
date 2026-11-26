'use strict';
// Speaking Coach: the feature switch, the settings and the pass rule. Read from the environment at call time (no restart for a test), every
// value has a safe default, and a value that is not a whole number or is out of range is ignored and reported by variable NAME only.
// Practice never changes the assignment grade or the stored result; these settings only drive practice.
const { audioSttEnabled } = require('../audio/policy');

/** SPEAKING_COACH_ENABLED=true AND AUDIO_STT_ENABLED=true. Anything else: off (every coach route answers 404). */
const speakingCoachEnabled = (env = process.env) => audioSttEnabled(env) && String(env.SPEAKING_COACH_ENABLED || '').trim().toLowerCase() === 'true';

const MAX_OUTPUT_TOKENS = 8000;
/** The one retry after a reply cut off by its output limit (AI_RESPONSE_TRUNCATED): twice the limit, never above 8000. */
const truncationRetryLimit = limit => Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Number(limit) || 0) * 2);
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
/** SPEAKING_COACH_REASONING_EFFORT: the model's thinking for the coach's calls, low (default), medium or high; anything else is low. */
function reasoningEffort(env = process.env) {
  const value = String(env.SPEAKING_COACH_REASONING_EFFORT || '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(value) ? value : 'low';
}

// [variable, key, default, minimum, maximum]
const SETTINGS = Object.freeze([
  ['SPEAKING_COACH_PASS_PERCENT', 'passPercent', 70, 50, 100],
  ['SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION', 'maxAttemptsPerSubmission', 20, 1, 50],
  ['SPEAKING_COACH_MAX_RECORDING_SECONDS', 'maxRecordingSeconds', 90, 15, 180],
  ['SPEAKING_COACH_MIN_WORDS', 'minWords', 15, 5, 100],
  ['SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER', 'dailyMinutesPerTeacher', 30, 1, 100000],
  ['SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER', 'monthlyMinutesPerTeacher', 300, 1, 1000000],
  // Output limits per call, with room for the model's thinking (a real trial at 1200 was cut off: 581 of 719 and 932 of 1027 output tokens
  // were thinking). They replace the single SPEAKING_COACH_AI_MAX_OUTPUT_TOKENS (1200), which no longer has any effect.
  ['SPEAKING_COACH_CHECK_MAX_OUTPUT_TOKENS', 'checkMaxOutputTokens', 3000, 256, MAX_OUTPUT_TOKENS],
  ['SPEAKING_COACH_TASKS_MAX_OUTPUT_TOKENS', 'tasksMaxOutputTokens', 2500, 256, MAX_OUTPUT_TOKENS]
]);
const DEFAULTS = Object.freeze(Object.fromEntries(SETTINGS.map(([, key, fallback]) => [key, fallback])));

function readInteger(env, name, fallback, minimum, maximum, issues) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = /^\d+$/u.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) { issues.push(name); return fallback; }
  return value;
}

/** { settings (frozen), issues: [variable names that were ignored] }. */
function readSettings(env = process.env) {
  const issues = [];
  const settings = {};
  for (const [name, key, fallback, minimum, maximum] of SETTINGS) settings[key] = readInteger(env, name, fallback, minimum, maximum, issues);
  if (settings.monthlyMinutesPerTeacher < settings.dailyMinutesPerTeacher) {
    issues.push('SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER');
    settings.dailyMinutesPerTeacher = DEFAULTS.dailyMinutesPerTeacher;
    settings.monthlyMinutesPerTeacher = DEFAULTS.monthlyMinutesPerTeacher;
  }
  return { settings: Object.freeze(settings), issues };
}

const percentsOf = levels => [...new Set((Array.isArray(levels) ? levels : []).map(level => Number(level?.percent ?? level?.percentage))
  .filter(Number.isFinite))].sort((a, b) => b - a);

/**
 * The pass rule for one criterion (D3). 'threshold': a level at passPercent or above passes. 'second_highest': no level falls in
 * [passPercent, 100), so the second-highest level (and the top one) pass. 'top_only': a criterion with two levels, where the second-highest
 * level is the lowest one (it would pass every attempt), so only the top level passes. Returns { rule, minimumPercent }.
 */
function passRule(levels, passPercent) {
  const percents = percentsOf(levels);
  if (percents.some(percent => percent >= passPercent && percent < 100)) return { rule: 'threshold', minimumPercent: passPercent };
  if (percents.length >= 3) return { rule: 'second_highest', minimumPercent: percents[1] };
  return { rule: 'top_only', minimumPercent: percents[0] ?? 100 };
}

/** Whether a level percent passes for this criterion's levels. A value that is not a number never passes. */
function isPassingLevel(percent, levels, passPercent) {
  const value = Number(percent);
  if (percent === null || percent === undefined || !Number.isFinite(value)) return false;
  return value >= passRule(levels, passPercent).minimumPercent;
}

module.exports = { speakingCoachEnabled, readSettings, passRule, isPassingLevel, truncationRetryLimit, reasoningEffort, SETTINGS, DEFAULTS,
  MAX_OUTPUT_TOKENS, REASONING_EFFORTS };
