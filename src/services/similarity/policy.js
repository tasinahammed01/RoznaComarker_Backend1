'use strict';
// Similarity Reporting: the feature switch, the provider choice and the settings. Read from the environment at call time, every value has a
// safe default, and a value that is not valid is ignored and reported by variable NAME only (never its value). Teacher-only feature: students
// and guests never see a report, a source or a provider name. A similarity result never changes a score.

/** SIMILARITY_ENABLED=true. Anything else: off (every similarity route answers 404, the worker does nothing). */
const similarityEnabled = (env = process.env) => String(env.SIMILARITY_ENABLED || '').trim().toLowerCase() === 'true';

const PROVIDERS = Object.freeze(['copyscape', 'copyleaks', 'stub', 'none']);
/** SIMILARITY_PROVIDER: the external service (copyscape | copyleaks | stub), or none (internal comparison only, the default). */
function providerName(env = process.env) {
  const value = String(env.SIMILARITY_PROVIDER || '').trim().toLowerCase();
  return PROVIDERS.includes(value) ? value : 'none';
}

/** The version of the essay similarity notice shown to students and guests (stored on each submission that showed it). */
const NOTICE_VERSION = 'essay-similarity-2026-11';

// [variable, key, default, minimum, maximum]
const INTEGERS = Object.freeze([
  ['SIMILARITY_DAILY_CHECKS_PER_TEACHER', 'dailyChecksPerTeacher', 20, 1, 1000],
  ['SIMILARITY_CHECKS_PER_SUBMISSION', 'checksPerSubmission', 3, 1, 20],
  ['SIMILARITY_MAX_WORDS', 'maxWords', 2500, 50, 20000],
  ['SIMILARITY_MIN_MATCH_WORDS', 'minMatchWords', 8, 3, 50],
  // Copyscape only: how many results get a full comparison (the matched text). 0-10, as the API allows.
  ['SIMILARITY_FULL_COMPARISONS', 'fullComparisons', 10, 0, 10],
  ['SIMILARITY_PROVIDER_TIMEOUT_MS', 'providerTimeoutMs', 30000, 1000, 120000],
  // An asynchronous provider (Copyleaks): how long a submitted scan may wait for its result before one resend, then "expired".
  ['SIMILARITY_PROVIDER_DEADLINE_MINUTES', 'providerDeadlineMinutes', 60, 5, 1440],
  // Copyleaks keeps a scan this many hours after it completes (the API allows 1-2880); we also delete it once its export arrives.
  ['SIMILARITY_COPYLEAKS_RETENTION_HOURS', 'copyleaksRetentionHours', 24, 1, 2880],
  // Common phrasing for one task: a 5-word sequence found in this share of the assignment's essays (with at least this many essays) is ignored.
  ['SIMILARITY_COMMON_SHARE_PERCENT', 'commonSharePercent', 30, 5, 100],
  ['SIMILARITY_COMMON_MIN_ESSAYS', 'commonMinEssays', 5, 2, 1000]
]);
// [variable, key, default (null: none), minimum, maximum]
const DECIMALS = Object.freeze([
  // A global safety stop on the estimated provider spend per UTC day, all teachers together.
  ['SIMILARITY_DAILY_SPEND_USD', 'dailySpendUsd', 5, 0.01, 1000],
  // Copyleaks bills credits (1 credit = 250 words); its docs give no dollar price, so the account's price is configured. Unset: Copyleaks does not run.
  ['SIMILARITY_COPYLEAKS_USD_PER_CREDIT', 'copyleaksUsdPerCredit', null, 0.0001, 100]
]);
const SCOPES = Object.freeze(['all', 'institution', 'own']);

function readNumber(env, name, fallback, minimum, maximum, issues, pattern) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = pattern.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(value) || value < minimum || value > maximum) { issues.push(name); return fallback; }
  return value;
}

function readChoice(env, name, choices, fallback, issues) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!choices.includes(value)) { issues.push(name); return fallback; }
  return value;
}

/** { settings (frozen), issues: [variable names that were ignored] }. */
function readSettings(env = process.env) {
  const issues = [];
  const settings = {};
  for (const [name, key, fallback, minimum, maximum] of INTEGERS) settings[key] = readNumber(env, name, fallback, minimum, maximum, issues, /^\d+$/u);
  for (const [name, key, fallback, minimum, maximum] of DECIMALS) settings[key] = readNumber(env, name, fallback, minimum, maximum, issues, /^\d+(\.\d+)?$/u);
  settings.internalScope = readChoice(env, 'SIMILARITY_INTERNAL_SCOPE', SCOPES, 'all', issues);
  settings.excludeQuotes = readChoice(env, 'SIMILARITY_EXCLUDE_QUOTES', ['true', 'false'], 'true', issues) === 'true';
  return { settings: Object.freeze(settings), issues };
}

/**
 * The public callback address and shared secret an asynchronous provider (Copyleaks) needs: SIMILARITY_WEBHOOK_BASE_URL (https only, no
 * trailing slash kept) and SIMILARITY_WEBHOOK_SECRET (32 characters or more). Either missing or invalid: null (webhooks stay off: 404).
 */
function webhookConfig(env = process.env) {
  const secret = String(env.SIMILARITY_WEBHOOK_SECRET || '');
  if (secret.length < 32) return null;
  let url;
  try { url = new URL(String(env.SIMILARITY_WEBHOOK_BASE_URL || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.search || url.hash) return null;
  return { baseUrl: url.toString().replace(/\/+$/u, ''), secret };
}

module.exports = { similarityEnabled, providerName, readSettings, webhookConfig, NOTICE_VERSION, PROVIDERS, SCOPES, INTEGERS, DECIMALS };
