'use strict';
// OpenRouter: ElevenLabs Scribe v2 (AUDIO_STT_PROVIDER=openrouter-scribe; never the default). One multipart request to the fixed OpenRouter
// endpoint: verbose_json with word and segment timings, English, zero data retention (provider.zdr) and no routing fallbacks. The key is
// OPENROUTER_API_KEY (the backend's existing OpenRouter key), read by variable name only and never logged. A Deepgram key is not needed.
// Scribe returns punctuated tokens ("Um,"), a confidence for every word and one segment for the whole file: tokens are split into plain text
// and the punctuated form, times are clamped to [0, duration], and utterances are derived (sentence ends and gaps of 1 s or more).
// Files over the provider cap (AUDIO_STT_OPENROUTER_MAX_FILE_BYTES, default 20 MiB; OpenRouter refuses multipart uploads over 25 MB) are refused
// before sending; nothing is re-encoded. The upload never carries the original file name.
const logger = require('../../../utils/logger');
const { openrouterMaxFileBytes } = require('../policy');
const { SttError, retryAfterHintMs } = require('./errors');
const { requestJson, header } = require('./request');
const { word, buildTranscript } = require('./transcript');
const { inspectWords } = require('./transcriptGuard');

const PROVIDER = 'openrouter-scribe';
const DEFAULT_MODEL = 'elevenlabs/scribe-v2';
const ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const KEY_VARIABLE = 'OPENROUTER_API_KEY';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
// Retention off: only zero-data-retention endpoints, and no silent re-routing to another provider.
const PROVIDER_PREFERENCES = Object.freeze({ zdr: true, allow_fallbacks: false });
const UTTERANCE_GAP_SECONDS = 1;
const EXTENSIONS = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' });
const LANGUAGES = Object.freeze({ eng: 'en' });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };

/** AUDIO_STT_OPENROUTER_MODEL ("author/model", lower case) or elevenlabs/scribe-v2. Anything else (a URL, spaces, no author) is ignored. */
function modelFor(env = process.env) {
  const value = String(env.AUDIO_STT_OPENROUTER_MODEL || '').trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,63}$/u.test(value) ? value : DEFAULT_MODEL;
}

/** "Um," -> { plain: 'um', punctuated: 'Um,' }: surrounding punctuation removed and lower case for matching; the original kept for display. */
function splitToken(token) {
  const punctuated = String(token ?? '').trim();
  const plain = punctuated.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
  return { plain, punctuated };
}

const SENTENCE_END = /[.!?]["'’”)\]]*$/u;
/** Utterances from the word list: a new one after a sentence end or before a gap of 1 s or more. Same shape as Deepgram's (with word ranges). */
function deriveUtterances(words) {
  const out = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const gap = next ? round(next.start - words[i].end, 3) : 0;
    if (!next || SENTENCE_END.test(words[i].punctuated) || gap >= UTTERANCE_GAP_SECONDS) {
      const span = words.slice(first, i + 1);
      out.push({ index: out.length, start: span[0].start, end: words[i].end, confidence: round(span.reduce((sum, w) => sum + w.confidence, 0) / span.length, 4),
        wordStartIndex: first, wordEndIndex: i, text: span.map(w => w.punctuated).join(' ') });
      first = i + 1;
    }
  }
  return out;
}

/** A Scribe verbose_json answer as the stored, frozen transcript. Throws AUDIO_STT_BAD_RESPONSE when the shape is not what was asked for. */
function normalize(body, { model = DEFAULT_MODEL, headerRequestId = null } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.words)) throw new SttError('AUDIO_STT_BAD_RESPONSE', { provider: PROVIDER });
  const duration = finite(body.duration) && body.duration > 0 ? body.duration : null;
  const clamp = value => (finite(value) ? Math.min(Math.max(value, 0), duration ?? Infinity) : value);
  const words = [];
  for (const item of body.words) {
    if (item && item.type && item.type !== 'word') continue;                 // audio events ("(laughs)") are not speech
    const { plain, punctuated } = splitToken(item?.word);
    if (!plain) continue;                                                     // a token that is only punctuation
    const start = clamp(item.start);
    const end = finite(item.end) && finite(start) ? Math.max(clamp(item.end), start) : item.end;
    words.push(word({ index: words.length, text: plain, punctuated, start, end, confidence: item.confidence }));
  }
  const language = typeof body.language === 'string' && body.language.trim() ? (LANGUAGES[body.language.trim().toLowerCase()] || body.language.trim().toLowerCase()) : 'en';
  return buildTranscript({ provider: PROVIDER, model, providerModelVersion: null, providerRequestId: headerRequestId, language,
    languageConfidence: body.language_confidence, durationSeconds: duration, wordTimingsAvailable: true, words, utterances: deriveUtterances(words) });
}

const errorMessage = body => String(body?.error?.message || '');
/** OpenRouter answers whose body says more than the status. Everything else: the shared status mapping (408/429/5xx retryable). */
function classifyError({ status, headers, body, nowMs }) {
  if (status === 400 && /exceeds the 25 MB/iu.test(errorMessage(body))) return new SttError('AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', { provider: PROVIDER, httpStatus: status });
  if (status === 401 || status === 403) return new SttError('AUDIO_STT_NOT_CONFIGURED', { provider: PROVIDER, httpStatus: status, detail: 'OpenRouter refused the key' });
  if (status === 402) {
    const retryAfterMs = retryAfterHintMs(header(headers, 'retry-after') || body?.error?.metadata?.headers?.['Retry-After'], nowMs);
    // Operations, not the student: the OpenRouter account is out of credit or over its in-flight budget.
    logger.warn({ event: 'audio_stt_provider_credits', provider: PROVIDER, httpStatus: status, retryAfterMs });
    return new SttError('AUDIO_STT_PROVIDER_CREDITS', { provider: PROVIDER, httpStatus: status, retryAfterMs });
  }
  if (status === 404 && (/data policy/iu.test(errorMessage(body)) || /data policy/iu.test(String(body?.error?.metadata?.failed_routing_step || '')))) {
    return new SttError('AUDIO_STT_NOT_CONFIGURED', { provider: PROVIDER, httpStatus: status, detail: 'no zero-data-retention endpoint for this model' });
  }
  return null;
}

function logUsage(body, model) {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return;
  logger.metric({ event: 'audio_stt_provider_usage', provider: PROVIDER, model, seconds: finite(usage.seconds) ? usage.seconds : null,
    costUsd: finite(usage.cost) ? usage.cost : null });
}

/**
 * AUDIO_STT_GUARD_FORCE_SUSPICIOUS=true makes every answer fail the check, for a manual test of the unreliable path. Honoured only when
 * NODE_ENV is development or test; refused (ignored) in production, staging or when NODE_ENV is unset.
 */
const forcedSuspicious = env => String(env.AUDIO_STT_GUARD_FORCE_SUSPICIOUS || '').trim().toLowerCase() === 'true'
  && ['development', 'test'].includes(String(env.NODE_ENV || '').trim().toLowerCase());

/** The suspicious-response check on the raw answer (before clamping), against our own duration scan when known. */
function inspect(body, { expectedDurationSeconds = null, env = process.env } = {}) {
  if (forcedSuspicious(env)) return { ok: false, reasons: ['FORCED_FOR_TESTING'], metrics: {} };
  return inspectWords(body.words, { providerDurationSeconds: body.duration, expectedDurationSeconds });
}

/**
 * One request; returns the stored transcript. Throws SttError (see classifyError and services/audio/stt/request.js), and
 * AUDIO_STT_UNRELIABLE_RESULT (with `reasons` and numeric `metrics`) when the answer fails the check; services/audio/stt/index.js retries once.
 */
async function transcribe({ audio, contentType, env = process.env, fetchImpl, signal, timeoutMs, now, expectedDurationSeconds = null }) {
  const key = String(env[KEY_VARIABLE] || '').trim();
  if (!key) throw new SttError('AUDIO_STT_NOT_CONFIGURED', { provider: PROVIDER, detail: `${KEY_VARIABLE} is not set` });
  if (Number(audio?.size) > openrouterMaxFileBytes(env)) throw new SttError('AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', { provider: PROVIDER });
  const model = modelFor(env);
  const form = new FormData();
  form.append('model', model);
  form.append('file', audio, `audio.${EXTENSIONS[contentType] || 'bin'}`);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('language', 'en');
  form.append('provider', JSON.stringify(PROVIDER_PREFERENCES));
  const { json, headers } = await requestJson({ provider: PROVIDER, url: ENDPOINT,
    init: { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }, fetchImpl, timeoutMs, signal, now, classifyError });
  const transcript = normalize(json, { model, headerRequestId: header(headers, 'x-generation-id') });
  logUsage(json, model);
  const report = inspect(json, { expectedDurationSeconds, env });
  if (!report.ok) {
    const error = new SttError('AUDIO_STT_UNRELIABLE_RESULT', { provider: PROVIDER });
    error.reasons = report.reasons;
    error.metrics = report.metrics;
    throw error;
  }
  return transcript;
}

module.exports = { PROVIDER, DEFAULT_MODEL, ENDPOINT, KEY_VARIABLE, DEFAULT_MAX_BYTES, PROVIDER_PREFERENCES, modelFor, splitToken, deriveUtterances, normalize,
  classifyError, inspect, transcribe };
