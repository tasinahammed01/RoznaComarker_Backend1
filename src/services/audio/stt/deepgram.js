'use strict';
// Deepgram pre-recorded transcription (Nova-3, English). The request parameters are fixed here and cannot be changed from the environment:
// mip_opt_out keeps the audio out of Deepgram's model-improvement programme; filler_words keeps "uh"/"um" (Speaking Coach needs them; when off,
// Deepgram silently drops them); speaker labels stay off. The key is read by variable name only and is never logged.
const { SttError } = require('./errors');
const { requestJson, header } = require('./request');
const { word, buildTranscript } = require('./transcript');

const PROVIDER = 'deepgram';
const MODEL = 'nova-3';
const ENDPOINT = 'https://api.deepgram.com/v1/listen';
const KEY_VARIABLE = 'DEEPGRAM_API_KEY';
const PARAMS = Object.freeze({ model: MODEL, language: 'en', punctuate: 'true', smart_format: 'true', filler_words: 'true', utterances: 'true',
  mip_opt_out: 'true', diarize: 'false' });

function buildRequest({ env = process.env, contentType }) {
  const key = String(env[KEY_VARIABLE] || '').trim();
  if (!key) throw new SttError('AUDIO_STT_NOT_CONFIGURED', { provider: PROVIDER, detail: `${KEY_VARIABLE} is not set` });
  return { url: `${ENDPOINT}?${new URLSearchParams(PARAMS)}`, headers: { Authorization: `Token ${key}`, 'Content-Type': contentType } };
}

const EPSILON = 0.005;
function utteranceRange(words, utterance) {
  let first = -1, last = -1;
  for (const item of words) {
    if (item.start >= utterance.start - EPSILON && item.end <= utterance.end + EPSILON) { if (first < 0) first = item.index; last = item.index; }
  }
  return first < 0 ? null : { wordStartIndex: first, wordEndIndex: last };
}

/** A Deepgram response as the stored, frozen transcript. Throws AUDIO_STT_BAD_RESPONSE when the shape is not what was asked for. */
function normalize(body, { headerRequestId = null } = {}) {
  const channel = body?.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  if (!alternative || !Array.isArray(alternative.words)) throw new SttError('AUDIO_STT_BAD_RESPONSE', { provider: PROVIDER });
  const words = alternative.words.map((item, index) => word({ index, text: item?.word, punctuated: item?.punctuated_word, start: item?.start,
    end: item?.end, confidence: item?.confidence }));
  const utterances = (Array.isArray(body.results.utterances) ? body.results.utterances : []).flatMap((item, index) => {
    const range = Number.isFinite(item?.start) && Number.isFinite(item?.end) ? utteranceRange(words, item) : null;
    if (!range) return [];
    return [{ index, start: item.start, end: item.end, confidence: Number.isFinite(item.confidence) ? item.confidence : null, ...range,
      text: String(item.transcript || '') }];
  }).map((item, index) => ({ ...item, index }));
  const modelInfo = Object.values(body.metadata?.model_info || {})[0] || {};
  return buildTranscript({
    provider: PROVIDER, model: MODEL, providerModelVersion: typeof modelInfo.version === 'string' ? modelInfo.version : null,
    providerRequestId: typeof body.metadata?.request_id === 'string' ? body.metadata.request_id : headerRequestId,
    language: typeof channel.detected_language === 'string' ? channel.detected_language : 'en', languageConfidence: channel.language_confidence,
    durationSeconds: body.metadata?.duration, wordTimingsAvailable: true, words, utterances
  });
}

async function transcribe({ audio, contentType, env = process.env, fetchImpl, signal, timeoutMs, now }) {
  const { url, headers } = buildRequest({ env, contentType });
  const { json, headers: responseHeaders } = await requestJson({ provider: PROVIDER, url, init: { method: 'POST', headers, body: audio },
    fetchImpl, timeoutMs, signal, now });
  return normalize(json, { headerRequestId: header(responseHeaders, 'dg-request-id') });
}

module.exports = { PROVIDER, MODEL, PARAMS, KEY_VARIABLE, buildRequest, normalize, transcribe };
