'use strict';
// Where recordings live on disk: <backend>/<UPLOAD_BASE_PATH>/audio. This folder is NOT under any static mount in app.js (only avatars,
// class-banners, flashcards and templates are), and no file route serves the 'audio' type. Playback arrives later through an authorised route.
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const AUDIO_FOLDER = 'audio';
const basePath = (env = process.env) => (String(env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads');

/** Absolute path of the audio folder. */
const audioRoot = (env = process.env) => path.resolve(BACKEND_ROOT, basePath(env), AUDIO_FOLDER);

/** The relative path stored on the File record (same convention as the other upload types). */
const storedPathFor = (filename, env = process.env) => path.posix.join(basePath(env), AUDIO_FOLDER, filename);

/** The absolute path for a stored path, or null when it does not resolve to a file directly inside the audio folder. */
function resolveStoredAudioPath(storedPath, env = process.env) {
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const root = audioRoot(env);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(BACKEND_ROOT, raw);
  return path.dirname(candidate) === root ? candidate : null;
}

module.exports = { AUDIO_FOLDER, audioRoot, storedPathFor, resolveStoredAudioPath };
