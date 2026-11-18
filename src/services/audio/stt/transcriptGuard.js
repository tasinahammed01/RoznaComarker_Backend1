'use strict';
// Suspicious-response check for OpenRouter Scribe answers (stage 12). Pure: provider words + durations in, { ok, reasons, metrics } out; no text
// is kept or logged (metrics are numbers, reasons are codes). Scribe was measured to sometimes squash text into zero-length words, append
// duplicated text, or silently lose a stretch while later timestamps still run to the end of the file. Thresholds were calibrated on real
// responses (tests/fixtures/audio/openrouter-scribe): every real-speech run passes and both looped-speech failures fail (tests/audioSttGuard).
// Limits of a transcript-only check: a student who is silent for 30 s or more in the middle of an answer, or who stops speaking more than 15 s
// before the end, looks the same as a dropout; such a recording fails as unreliable and the student is asked to record again.
const finite = value => typeof value === 'number' && Number.isFinite(value);

const THRESHOLDS = Object.freeze({
  // Zero-length words: none in any real run; the duplicated-text failure had 131 (9.8%), 89 of them in one run. Up to 6 isolated ones were
  // seen in long synthetic files that were otherwise correct, hence a run of 10, or more than 2% with at least 5.
  zeroLengthRunWords: 10, zeroLengthShare: 0.02, zeroLengthMinWords: 5,
  // A word ending after the audio: never seen from Scribe; more than 1 s is impossible for a correct answer.
  beyondDurationSeconds: 1,
  // Overlapping words: none seen from Scribe.
  overlapShare: 0.01, overlapMinPairs: 3,
  // Duplicated text: a block of at least 20 words twice in a row where one copy takes less than half the time of the other (text that could
  // not have been spoken twice). A plain repeat is legitimate: the real A+B+A+B+A calibration file contains a 387-word block spoken twice.
  duplicateBlockWords: 20, duplicateTimeRatio: 0.5,
  // Speech that ends long before the audio does: real runs ended at most 1.33 s before the end; the duplicated-text failure 6.3 s. 15 s
  // tolerates a pause before stopping the recorder; a lost tail of 46 s (the measured loss size) is caught.
  endGapSeconds: 15,
  // The provider heard a different length than our duration scan.
  durationMismatchSeconds: 2, durationMismatchShare: 0.05,
  // Speaking rate per 30 s window between the first and last word, compared with the median window. Real runs: lowest 0.83x, highest 1.52x;
  // the dropout failure fell to 0.06x, the duplicated-text failure rose to 2.5x. Only with at least 60 s of speech.
  windowSeconds: 30, windowRulesMinSpeechSeconds: 60, dropoutRatio: 0.2, burstRatio: 2
});

const token = text => String(text ?? '').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Back-to-back repeats: { longest } = the longest block of words that appears twice in a row (0 when none), and { compressed } = the longest
 * such block of at least `minWords` whose two copies take very different times (shorter / longer below `timeRatio`). O(n^2), n <= ~2000.
 */
function repeatedBlocks(list, tokens, { minWords = 1, timeRatio = 0 } = {}) {
  let longest = 0, compressed = 0;
  for (let length = 1; length * 2 <= tokens.length; length++) {
    let run = 0;
    for (let i = 0; i + length < tokens.length; i++) {
      run = tokens[i] && tokens[i] === tokens[i + length] ? run + 1 : 0;
      if (run < length) continue;
      longest = Math.max(longest, length);
      if (length < minWords || length <= compressed) continue;
      const s = i - length + 1;
      const first = list[s + length - 1].end - list[s].start, second = list[s + 2 * length - 1].end - list[s + length].start;
      const longer = Math.max(first, second), shorter = Math.min(first, second);
      if (longer > 0 && shorter / longer < timeRatio) compressed = length;
    }
  }
  return { longest, compressed };
}

function windowRatios(words, first, last, t) {
  const rates = [];
  for (let start = first; start < last; start += t.windowSeconds) {
    const end = Math.min(last, start + t.windowSeconds);
    if (end - start < t.windowSeconds / 2) continue;                       // a short last window says little
    const count = words.filter(w => w.start >= start && (w.start < end || (end === last && w.start <= end))).length;
    rates.push(count / (end - start) * 60);
  }
  if (rates.length < 2) return null;
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > 0 ? { count: rates.length, median, lowest: sorted[0] / median, highest: sorted[sorted.length - 1] / median } : null;
}

/**
 * words: [{ word, start, end }] as the provider returned them (before clamping). expectedDurationSeconds: our own duration scan of the file
 * (used when known); providerDurationSeconds: what the provider heard.
 */
function inspectWords(words, { providerDurationSeconds = null, expectedDurationSeconds = null } = {}) {
  const t = THRESHOLDS;
  const list = (Array.isArray(words) ? words : []).filter(w => w && (!w.type || w.type === 'word') && finite(w.start) && finite(w.end));
  const expected = finite(expectedDurationSeconds) && expectedDurationSeconds > 0 ? expectedDurationSeconds : null;
  const provider = finite(providerDurationSeconds) && providerDurationSeconds > 0 ? providerDurationSeconds : null;
  const duration = expected ?? provider;
  if (!list.length) return { ok: true, reasons: [], metrics: { words: 0, durationSeconds: duration } };   // no speech: "not enough speech" later
  const reasons = [];

  let zero = 0, run = 0, longestZero = 0, overlaps = 0;
  list.forEach((w, i) => {
    if (w.end - w.start <= 0.0001) { zero++; run++; longestZero = Math.max(longestZero, run); } else run = 0;
    if (i > 0 && w.start < list[i - 1].end - 0.02) overlaps++;
  });
  if (longestZero >= t.zeroLengthRunWords) reasons.push('ZERO_LENGTH_RUN');
  if (zero >= t.zeroLengthMinWords && zero / list.length > t.zeroLengthShare) reasons.push('ZERO_LENGTH_SHARE');
  const beyond = duration ? list.filter(w => w.end > duration + t.beyondDurationSeconds).length : 0;
  if (beyond) reasons.push('WORDS_BEYOND_DURATION');
  if (overlaps >= t.overlapMinPairs && overlaps / list.length > t.overlapShare) reasons.push('OVERLAPPING_WORDS');
  const repeated = repeatedBlocks(list, list.map(w => token(w.word)), { minWords: t.duplicateBlockWords, timeRatio: t.duplicateTimeRatio });
  if (repeated.compressed >= t.duplicateBlockWords) reasons.push('DUPLICATED_BLOCK');
  const first = Math.min(...list.map(w => w.start)), last = Math.max(...list.map(w => w.end));
  const endGap = duration ? duration - last : null;
  if (endGap !== null && endGap > t.endGapSeconds) reasons.push('END_GAP');
  if (expected && provider && Math.abs(provider - expected) > Math.max(t.durationMismatchSeconds, expected * t.durationMismatchShare)) reasons.push('DURATION_MISMATCH');
  const windows = last - first >= t.windowRulesMinSpeechSeconds ? windowRatios(list, first, last, t) : null;
  if (windows && windows.lowest < t.dropoutRatio) reasons.push('RATE_DROPOUT');
  if (windows && windows.highest > t.burstRatio) reasons.push('RATE_BURST');

  const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
  return {
    ok: reasons.length === 0,
    reasons,
    metrics: { words: list.length, durationSeconds: duration, providerDurationSeconds: provider, zeroLengthWords: zero, longestZeroLengthRun: longestZero,
      wordsBeyondDuration: beyond, overlappingPairs: overlaps, longestRepeatedBlock: repeated.longest, longestCompressedRepeat: repeated.compressed,
      endGapSeconds: round(endGap),
      windowCount: windows ? windows.count : 0, medianWordsPerMinute: windows ? round(windows.median, 1) : null,
      lowestWindowRatio: windows ? round(windows.lowest) : null, highestWindowRatio: windows ? round(windows.highest) : null }
  };
}

module.exports = { THRESHOLDS, inspectWords, repeatedBlocks };
