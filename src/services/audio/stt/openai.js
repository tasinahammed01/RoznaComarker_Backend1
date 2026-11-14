'use strict';
// OpenAI transcription: the fallback only. It returns text without word timings, so a recording transcribed here is marked
// speakingCoachDataAvailable=false and gets no fluency metrics. Files over OpenAI's 25 MB limit are refused before sending. The upload never
// carries the original file name. The key is read by variable name only and is never logged.
const { SttError } = require('./errors');
const { requestJson, header } = require('./request');
const { buildTranscript } = require('./transcript');

const PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-transcribe';
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const KEY_VARIABLE = 'OPENAI_API_KEY';
const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' });

const modelFor = env => (/^[a-z0-9][a-z0-9.-]{1,60}$/u.test(String(env.AUDIO_OPENAI_STT_MODEL || '').trim())
  ? String(env.AUDIO_OPENAI_STT_MODEL).trim() : DEFAULT_MODEL);

function normalize(body, { model, headerRequestId = null } = {}) {
  if (typeof body?.text !== 'string') throw new SttError('AUDIO_STT_BAD_RESPONSE', { provider: PROVIDER });
  const seconds = body.usage?.type === 'duration' ? body.usage.seconds : body.duration;
  return buildTranscript({ provider: PROVIDER, model, providerRequestId: headerRequestId, language: 'en', durationSeconds: seconds,
    wordTimingsAvailable: false, words: [], utterances: [], rawText: body.text.trim() });
}

async function transcribe({ audio, contentType, env = process.env, fetchImpl, signal, timeoutMs }) {
  const key = String(env[KEY_VARIABLE] || '').trim();
  if (!key) throw new SttError('AUDIO_STT_NOT_CONFIGURED', { provider: PROVIDER, detail: `${KEY_VARIABLE} is not set` });
  if (Number(audio?.size) > MAX_BYTES) throw new SttError('AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', { provider: PROVIDER });
  const model = modelFor(env);
  const form = new FormData();
  form.append('file', audio, `audio.${EXTENSIONS[contentType] || 'bin'}`);
  form.append('model', model);
  form.append('language', 'en');
  form.append('response_format', 'json');
  const { json, headers } = await requestJson({ provider: PROVIDER, url: ENDPOINT,
    init: { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }, fetchImpl, timeoutMs, signal });
  return normalize(json, { model, headerRequestId: header(headers, 'x-request-id') });
}

module.exports = { PROVIDER, DEFAULT_MODEL, KEY_VARIABLE, MAX_BYTES, normalize, transcribe };
