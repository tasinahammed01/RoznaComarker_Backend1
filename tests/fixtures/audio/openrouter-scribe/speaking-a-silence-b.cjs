'use strict';
// Real speech with a real silence (stage 12f): speaking-A's Scribe answer, then `silenceSeconds` of silence, then speaking-B's answer shifted by
// A's duration plus the silence. Timings, words and confidences are the real ones; only the offset is added. Built from the two fixtures beside
// this file, so no new recording data. Options model what a second Scribe run of the same file looks like:
// - fillerVariation: as measured between real runs, some fillers change spelling ("um" -> "mm") and one filler is dropped; other words identical.
// - dropWords: removes that many consecutive non-filler words from the middle of B (a run that lost text: the two runs disagree).
const A = require('./speaking-a-real-45s.cjs');
const B = require('./speaking-b-real-142s.cjs');

const isFiller = word => /^(um+|uh+|mm+|hmm+|er+|erm+|mhm)$/i.test(String(word).replace(/[^\p{L}]/gu, ''));

function build({ silenceSeconds = 30, fillerVariation = false, dropWords = 0 } = {}) {
  const offset = A.duration + silenceSeconds;
  let words = [...A.words.map(w => ({ ...w })), ...B.words.map(w => ({ ...w, start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3) }))];
  if (fillerVariation) {
    let changed = 0, dropped = false;
    words = words.flatMap(w => {
      if (!isFiller(w.word)) return [w];
      if (!dropped && changed === 3) { dropped = true; return []; }
      changed++;
      return [changed % 2 ? { ...w, word: w.word.replace(/um|uh/i, 'mm') } : w];
    });
  }
  if (dropWords > 0) {
    const middle = A.words.length + Math.floor(B.words.length / 4);           // well inside the middle third of the combined file
    let removed = 0;
    words = words.filter((w, i) => { if (i >= middle && removed < dropWords && !isFiller(w.word)) { removed++; return false; } return true; });
  }
  const duration = +(offset + B.duration).toFixed(6);
  return { text: words.map(w => w.word).join(' '), language: 'eng', language_confidence: B.language_confidence, duration,
    segments: [{ id: 0, start: 0, end: duration, text: '' }], words, usage: { seconds: duration, cost: +(duration * 0.0000611111).toFixed(10) } };
}

module.exports = { build, A_DURATION: A.duration, B_DURATION: B.duration };
