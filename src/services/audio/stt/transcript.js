'use strict';
// The stored transcript schema and the pure functions built on it. Everything here is derived from the stored word list only: no provider call,
// no AI, no I/O. The raw transcript a provider returned is frozen and never changed; derived texts and metrics are recomputed from it.
const { SttError } = require('./errors');

const TRANSCRIPT_SCHEMA_VERSION = 'audio-transcript-v1';
const DERIVED_TEXT_VERSION = 'audio-derived-text-v1';
const FLUENCY_METRICS_VERSION = 'audio-fluency-v1';
const PAUSE_THRESHOLD_SECONDS = 1;
// Fields that identify the provider and its run. Server and teacher tooling only: never sent to a student or guest (later stages enforce it).
const SERVER_ONLY_FIELDS = Object.freeze(['provider', 'model', 'providerModelVersion', 'providerRequestId']);
// Deepgram's filler words (filler_words=true), always spelled this way whatever their spoken length.
const FILLERS = new Set(['uh', 'um', 'mhmm', 'mm-mm', 'uh-uh', 'uh-huh', 'nuh-uh']);

const round = (value, digits) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bad = detail => new SttError('AUDIO_STT_BAD_RESPONSE', { detail });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** One stored word. Throws AUDIO_STT_BAD_RESPONSE for missing or impossible values (the provider answer is not trusted). */
function word({ index, text, punctuated, start, end, confidence }) {
  const plain = String(text ?? '').trim();
  const shown = String(punctuated ?? plain).trim() || plain;
  if (!plain || !finite(start) || !finite(end) || start < 0 || end < start) throw bad(`word ${index}`);
  if (!finite(confidence) || confidence < 0 || confidence > 1) throw bad(`word ${index} confidence`);
  return { index, text: plain, punctuated: shown, start, end, confidence, isFiller: FILLERS.has(plain.toLowerCase()) };
}

/** The stored, frozen transcript. `words` may be empty (no speech, or a provider without word timings). */
function buildTranscript(fields) {
  return deepFreeze({
    transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    provider: fields.provider, model: fields.model, providerModelVersion: fields.providerModelVersion ?? null,
    providerRequestId: fields.providerRequestId ?? null,
    language: fields.language ?? 'en', languageConfidence: finite(fields.languageConfidence) ? fields.languageConfidence : null,
    durationSeconds: finite(fields.durationSeconds) ? fields.durationSeconds : null,
    wordTimingsAvailable: Boolean(fields.wordTimingsAvailable),
    // Speaking Coach needs word timings; a recording transcribed without them is marked so it is never analysed as if it had them.
    speakingCoachDataAvailable: Boolean(fields.wordTimingsAvailable),
    words: fields.words || [],
    utterances: fields.utterances || [],
    rawText: typeof fields.rawText === 'string' ? fields.rawText : (fields.words || []).map(w => w.punctuated).join(' ')
  });
}

const TERMINAL = /[.!?]+$/u;
const SOFT_END = /[,;:]$/u;
const capitalize = text => text.replace(/^(\P{L}*)(\p{Ll})/u, (_match, lead, letter) => lead + letter.toUpperCase());

/**
 * Display and assessor texts from the word list.
 * - rawText: verbatim, fillers included (what the provider heard, with its punctuation).
 * - displayText: fillers hidden; `fillers` keeps each one's word index and the character offset where it stood, so a toggle can show it again.
 *   A filler that ended a sentence hands its full stop to the word before it, and a filler that began a sentence passes on its capital letter.
 * - assessorText: punctuated, fillers removed, repetitions and self-corrections kept (they are the student's own speech).
 * Punctuation and capitals come from the speech engine, not the student; the assessor is told so (later stage).
 */
function deriveTexts(transcript) {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  if (!transcript?.wordTimingsAvailable && !words.length) {
    const text = String(transcript?.rawText || '').trim();
    return { derivedTextVersion: DERIVED_TEXT_VERSION, rawText: text, displayText: { text, fillers: [] }, assessorText: text };
  }
  const kept = [];
  const pending = [];
  let capitalizeNext = false;
  for (const item of words) {
    if (item.isFiller) {
      const sentenceStart = !kept.length || TERMINAL.test(kept[kept.length - 1]);
      if (sentenceStart && /^\p{Lu}/u.test(item.punctuated)) capitalizeNext = true;
      const terminal = item.punctuated.match(TERMINAL)?.[0];
      if (terminal && kept.length && !TERMINAL.test(kept[kept.length - 1])) {
        const last = kept[kept.length - 1];
        kept[kept.length - 1] = SOFT_END.test(last) ? last.slice(0, -1) + terminal : last + terminal;
      }
      pending.push({ wordIndex: item.index, keptIndex: kept.length, text: item.punctuated });
      continue;
    }
    kept.push(capitalizeNext ? capitalize(item.punctuated) : item.punctuated);
    capitalizeNext = false;
  }
  const offsets = [];
  let cursor = 0;
  for (const text of kept) { offsets.push(cursor); cursor += text.length + 1; }
  const text = kept.join(' ');
  const fillers = pending.map(({ wordIndex, keptIndex, text: fillerText }) => ({ wordIndex, offset: keptIndex < offsets.length ? offsets[keptIndex] : text.length,
    text: fillerText }));
  return { derivedTextVersion: DERIVED_TEXT_VERSION, rawText: words.map(w => w.punctuated).join(' '), displayText: { text, fillers }, assessorText: text };
}

const normalizedToken = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, '');

/** Immediate repeats of one word ("I I") or of a two-word phrase ("I went I went"), fillers in between ignored. */
function repetitionCount(tokens) {
  let count = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] && tokens[i] === tokens[i - 1]) { count++; continue; }
    if (i >= 3 && tokens[i] === tokens[i - 2] && tokens[i - 1] === tokens[i - 3] && tokens[i] !== tokens[i - 1]) count++;
  }
  return count;
}

/** Fluency figures computed without AI from the raw word timings. Unavailable when the provider gave no word timings. */
function fluencyMetrics(transcript) {
  if (!transcript?.wordTimingsAvailable) return { metricsVersion: FLUENCY_METRICS_VERSION, available: false, reason: 'WORD_TIMINGS_UNAVAILABLE' };
  const words = Array.isArray(transcript.words) ? transcript.words : [];
  const fillerCount = words.filter(w => w.isFiller).length;
  const spokenWords = words.length - fillerCount;
  const speakingSeconds = words.length ? Math.max(0, round(words[words.length - 1].end - words[0].start, 2)) : 0;
  let pauses = 0, longest = 0, total = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = round(words[i].start - words[i - 1].end, 2);
    if (gap > longest) longest = gap;
    if (gap > PAUSE_THRESHOLD_SECONDS) { pauses++; total += gap; }
  }
  return {
    metricsVersion: FLUENCY_METRICS_VERSION, available: true,
    totalWords: words.length, spokenWords, fillerCount, speakingSeconds,
    wordsPerMinute: speakingSeconds > 0 ? round(spokenWords / (speakingSeconds / 60), 1) : 0,
    fillersPer100Words: words.length ? round(fillerCount * 100 / words.length, 1) : 0,
    pauseThresholdSeconds: PAUSE_THRESHOLD_SECONDS, pausesOverThreshold: pauses,
    longestPauseSeconds: round(longest, 2), totalPauseSecondsOverThreshold: round(total, 2),
    repetitionCount: repetitionCount(words.filter(w => !w.isFiller).map(w => normalizedToken(w.text)))
  };
}

module.exports = { TRANSCRIPT_SCHEMA_VERSION, DERIVED_TEXT_VERSION, FLUENCY_METRICS_VERSION, SERVER_ONLY_FIELDS, FILLERS,
  word, buildTranscript, deriveTexts, fluencyMetrics, deepFreeze };
