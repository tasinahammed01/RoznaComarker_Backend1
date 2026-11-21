'use strict';
// Upload validation for one audio recording (field "audio"). A DEDICATED multer disk instance writing to <UPLOAD_BASE_PATH>/audio: the shared
// upload.middleware.js, its image types and its 10 MB limit are untouched. Order, so nothing is spent on a bad file:
//   1. before any byte is written: the MIME type and the extension must both name the same supported format;
//   2. the size limit (AUDIO_MAX_FILE_BYTES, read per request) is enforced while streaming: JSON 413;
//   3. the first bytes must be that format (magic bytes);
//   4. the duration is measured and must be 5 s .. the maximum + 1 s (420 s, or less per request: maxDurationSeconds), with no video track;
//   5. next() with req.audioUpload. The file is deleted when the response finishes unless the next handler calls req.audioUpload.commit().
// Every failure path deletes what was written. Stored names are random UUIDs; the original name is never used on disk, in a response or in a log.
// Used by routes/speaking.routes.js (class students' recordings).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const logger = require('../utils/logger');
const { readLimits } = require('../services/audio/policy');
const { audioRoot, storedPathFor } = require('../services/audio/storage');
const duration = require('../services/audio/duration');

// format -> canonical MIME type, stored extension, the MIME types and extensions a browser or OS may report for it.
// video/* is accepted for the containers only because operating systems often label .webm and .mp4 files that way; step 4 refuses real video.
const FORMATS = Object.freeze({
  mp3: { contentType: 'audio/mpeg', extension: '.mp3', mimes: ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'], extensions: ['.mp3'] },
  mp4: { contentType: 'audio/mp4', extension: '.m4a', mimes: ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'video/mp4'], extensions: ['.m4a', '.mp4'] },
  webm: { contentType: 'audio/webm', extension: '.webm', mimes: ['audio/webm', 'video/webm'], extensions: ['.webm'] },
  ogg: { contentType: 'audio/ogg', extension: '.ogg', mimes: ['audio/ogg', 'audio/opus', 'application/ogg'], extensions: ['.ogg', '.oga', '.opus'] },
  wav: { contentType: 'audio/wav', extension: '.wav', mimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'], extensions: ['.wav'] }
});
const formatOfMime = mime => Object.keys(FORMATS).find(key => FORMATS[key].mimes.includes(mime)) || null;
const formatOfExtension = ext => Object.keys(FORMATS).find(key => FORMATS[key].extensions.includes(ext)) || null;
const bareMime = value => String(value || '').split(';')[0].trim().toLowerCase();

const SNIFF_BYTES = 64;
/** The format the bytes are, or null. MP3: an ID3 tag or an MPEG Layer III frame header (raw AAC is not MP3). */
function detectAudioFormat(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2 && (buf[2] >> 4) !== 0x0f && ((buf[2] >> 2) & 0x03) !== 0x03) return 'mp3';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return buf.subarray(0, SNIFF_BYTES).includes(Buffer.from('webm', 'latin1')) ? 'webm' : null;
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  return null;
}

const amount = value => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));
/** The agreed 413 text, built from the limits (with the defaults: "40 MB max" and "7 minutes"). */
const tooLargeMessage = limits => `This recording is too large (${amount(limits.maxFileBytes / (1024 * 1024))} MB max) or longer than `
  + `${amount(limits.maxDurationSeconds / 60)} minutes. Save it as MP3 or M4A, or record in mono, and upload it again.`;

const REFUSALS = Object.freeze({
  AUDIO_FILE_REQUIRED: [400, () => 'Choose a recording to upload.'],
  AUDIO_FILE_EMPTY: [400, () => 'This file is empty. Please choose the recording again.'],
  AUDIO_ONE_FILE: [400, () => 'Upload one recording at a time.'],
  AUDIO_TYPE_UNSUPPORTED: [400, () => 'Please upload an MP3, M4A, WebM, Ogg or WAV recording.'],
  AUDIO_TYPE_MISMATCH: [400, () => "This file's content does not match its type. Please upload the original recording."],
  AUDIO_HAS_VIDEO: [400, () => 'Please upload an audio recording, not a video.'],
  AUDIO_TOO_LARGE: [413, tooLargeMessage],
  AUDIO_TOO_LONG: [413, tooLargeMessage],
  AUDIO_TOO_SHORT: [422, limits => `This recording is shorter than ${limits.minDurationSeconds} seconds. Please record a longer answer and upload it again.`],
  AUDIO_UNREADABLE: [422, () => "We couldn't read the length of this recording. Save it as MP3 or M4A and upload it again."],
  AUDIO_DURATION_UNAVAILABLE: [503, () => 'Recordings cannot be checked right now. Please try again in a few minutes.'],
  AUDIO_UPLOAD_FAILED: [400, () => 'The upload could not be read. Please try again.']
});
const refusal = code => Object.assign(new Error(code), { audioCode: code });

const removeQuietly = filePath => fs.promises.unlink(filePath).catch(() => {});

function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function readHead(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/**
 * The middleware chain. `measureDuration(filePath)` is injectable (tests); it defaults to the music-metadata scan. `maxDurationSeconds(req)`
 * (optional) lowers the maximum for one request (a speaking assignment's own limit); it never raises it above the policy.
 * On success: req.audioUpload = { path, filename, storedPath, format, contentType, extension, sizeBytes, durationSeconds, hasVideo, sha256, commit() }.
 */
// maxFields: text fields allowed before the file (default 5; the teacher upload sends 6: name, email, requestKey, batchId, mode, send).
function audioUpload({ measureDuration = duration.measureAudioDuration, env = process.env, maxDurationSeconds, maxFields = 5 } = {}) {
  function receive(req, res, next) {
    const policyLimits = readLimits(env).limits;
    const own = typeof maxDurationSeconds === 'function' ? Number(maxDurationSeconds(req)) : NaN;
    const limits = Number.isFinite(own) && own > 0 && own < policyLimits.maxDurationSeconds
      ? Object.freeze({ ...policyLimits, maxDurationSeconds: own }) : policyLimits;
    req.audioUploadLimits = limits;
    const written = [];
    req.audioUploadWritten = written;
    // Whatever happens next, a file that was not committed is removed when the request ends (also when the client goes away).
    const sweep = () => { for (const filePath of written) if (!req.audioUpload?.committed) void removeQuietly(filePath); };
    res.once('finish', sweep);
    res.once('close', sweep);
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => { try { fs.mkdirSync(audioRoot(env), { recursive: true }); cb(null, audioRoot(env)); } catch (error) { cb(error); } },
      filename: (_req, file, cb) => {
        const name = `${crypto.randomUUID()}${FORMATS[file.claimedFormat].extension}`;
        written.push(path.join(audioRoot(env), name));
        cb(null, name);
      }
    });
    const parse = multer({
      storage,
      // busboy stops a file as soon as it REACHES fileSize, so "+ 1" makes AUDIO_MAX_FILE_BYTES itself allowed and one byte more refused.
      limits: { fileSize: limits.maxFileBytes + 1, files: 1, fields: maxFields, fieldSize: 1024, parts: maxFields + 2 },
      fileFilter: (_req, file, cb) => {
        const byMime = formatOfMime(bareMime(file.mimetype));
        const byExtension = formatOfExtension(path.extname(String(file.originalname || '')).toLowerCase());
        if (!byMime || !byExtension) return cb(refusal('AUDIO_TYPE_UNSUPPORTED'));
        if (byMime !== byExtension) return cb(refusal('AUDIO_TYPE_MISMATCH'));
        file.claimedFormat = byMime;
        return cb(null, true);
      }
    }).single('audio');
    parse(req, res, error => {
      if (!error) return next();
      if (error.audioCode) return next(error);
      const code = error.code === 'LIMIT_FILE_SIZE' ? 'AUDIO_TOO_LARGE'
        : ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT', 'LIMIT_FIELD_VALUE'].includes(error.code) ? 'AUDIO_ONE_FILE'
          : 'AUDIO_UPLOAD_FAILED';
      return next(refusal(code));
    });
  }

  async function validate(req, _res, next) {
    const limits = req.audioUploadLimits;
    const file = req.file;
    try {
      if (!file) throw refusal('AUDIO_FILE_REQUIRED');
      if (!file.size) throw refusal('AUDIO_FILE_EMPTY');
      if (file.size > limits.maxFileBytes) throw refusal('AUDIO_TOO_LARGE');
      if (detectAudioFormat(await readHead(file.path)) !== file.claimedFormat) throw refusal('AUDIO_TYPE_MISMATCH');
      let measured;
      try { measured = await measureDuration(file.path); }
      catch (error) { throw refusal(error?.code === 'AUDIO_DURATION_UNAVAILABLE' ? 'AUDIO_DURATION_UNAVAILABLE' : 'AUDIO_UNREADABLE'); }
      if (measured.hasVideo) throw refusal('AUDIO_HAS_VIDEO');
      const check = duration.checkDuration(measured.durationSeconds, limits);
      if (!check.ok) throw refusal(check.code);
      const format = FORMATS[file.claimedFormat];
      req.audioUpload = { path: file.path, filename: file.filename, storedPath: storedPathFor(file.filename, env), format: file.claimedFormat,
        contentType: format.contentType, extension: format.extension, sizeBytes: file.size, durationSeconds: measured.durationSeconds,
        hasVideo: false, sha256: await sha256Of(file.path), committed: false };
      req.audioUpload.commit = () => { req.audioUpload.committed = true; };
      return next();
    } catch (error) {
      return next(error.audioCode ? error : refusal('AUDIO_UNREADABLE'));
    }
  }

  // Answers every refusal as JSON and deletes what was written. Other errors go on to the app's error handler (the file is still swept).
  function respond(error, req, res, next) {
    if (!error?.audioCode) return next(error);
    for (const filePath of req.audioUploadWritten || []) void removeQuietly(filePath);
    const [status, message] = REFUSALS[error.audioCode] || REFUSALS.AUDIO_UPLOAD_FAILED;
    logger.warn({ event: 'audio_upload_rejected', code: error.audioCode, status, sizeBytes: Number(req.file?.size) || null });
    if (res.headersSent) return undefined;
    return res.status(status).json({ success: false, code: error.audioCode, message: message(req.audioUploadLimits || readLimits(env).limits) });
  }

  return [receive, validate, respond];
}

module.exports = { audioUpload, detectAudioFormat, tooLargeMessage, FORMATS };
