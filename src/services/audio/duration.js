'use strict';
// Measures a stored recording's duration BEFORE any provider call, so nothing is spent on a recording that is too short or too long.
// music-metadata is ESM-only and this repo is CommonJS: it is loaded with a dynamic import() (works on every Node 22; require() of ESM only
// from 22.12). duration: true asks for a full scan where the format needs one (MP3 without a Xing header). Known gap: for WebM the library
// reads only the header Duration, so a WebM without it (Chrome's MediaRecorder output) is refused as unreadable (tests/audioDuration.test.js).
// Errors carry fixed codes only: never the library's message (it can contain the path).
const { maxAcceptedDurationSeconds } = require('./policy');

let libraryPromise = null;
const loadMusicMetadata = () => {
  if (!libraryPromise) libraryPromise = import('music-metadata').catch(error => { libraryPromise = null; throw error; });
  return libraryPromise;
};

const fail = code => Object.assign(new Error(code === 'AUDIO_DURATION_UNAVAILABLE' ? 'Duration could not be measured.' : 'The recording could not be read.'), { code });

/** { durationSeconds, hasVideo }. Throws AUDIO_UNREADABLE (the file) or AUDIO_DURATION_UNAVAILABLE (the library could not be loaded). */
async function measureAudioDuration(filePath, { load = loadMusicMetadata } = {}) {
  let library;
  try { library = await load(); } catch { throw fail('AUDIO_DURATION_UNAVAILABLE'); }
  let metadata;
  try { metadata = await library.parseFile(filePath, { duration: true, skipCovers: true }); } catch { throw fail('AUDIO_UNREADABLE'); }
  const format = metadata?.format || {};
  const seconds = format.duration;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || format.hasAudio === false) throw fail('AUDIO_UNREADABLE');
  const hasVideo = format.hasVideo === true || (Array.isArray(format.trackInfo) && format.trackInfo.some(track => track?.type === 'video'));
  return { durationSeconds: seconds, hasVideo };
}

/** { ok: true } or { ok: false, code: 'AUDIO_TOO_SHORT' | 'AUDIO_TOO_LONG' }. Inclusive at both ends (5 s and 420 s + 1 s are accepted). */
function checkDuration(seconds, limits) {
  if (seconds < limits.minDurationSeconds) return { ok: false, code: 'AUDIO_TOO_SHORT' };
  if (seconds > maxAcceptedDurationSeconds(limits)) return { ok: false, code: 'AUDIO_TOO_LONG' };
  return { ok: true };
}

module.exports = { measureAudioDuration, checkDuration, loadMusicMetadata };
