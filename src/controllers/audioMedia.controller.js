'use strict';
// Private audio for one speaking submission (routes/audio.routes.js). Never a static mount and not secureFile.controller.js:
//   media     the student who owns it and the owning teacher: inline, with single byte-range requests (seeking in a player)
//   download  the owning teacher only: an attachment
// Anyone else gets 404, the same as an id that does not exist. The Content-Type is the format sniffed at upload (stored on the recording),
// never the client's claim; the file name sent is neutral (never the stored or the original name). Cache-Control (private, no-store) is set
// by the router; X-Content-Type-Options: nosniff here.
const fs = require('fs');
const File = require('../models/File');
const { FORMATS } = require('../middlewares/audioUpload.middleware');
const { resolveStoredAudioPath } = require('../services/audio/storage');
const { accessFor } = require('../services/audio/speakingSubmission.service');
const logger = require('../utils/logger');

const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const EXTENSION = Object.fromEntries(Object.values(FORMATS).map(format => [format.contentType, format.extension]));

/** null: the whole file; 'unsatisfiable'; or { start, end } (inclusive). Only one "bytes=" range; anything else is ignored (whole file). */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

async function locate(req, { teacherOnly }) {
  const context = await accessFor(req.params.submissionId, req.user);
  if (!context || (teacherOnly && context.role !== 'teacher')) return null;
  const { recording } = context;
  if (!recording || recording.audioDeletedAt || !EXTENSION[recording.contentType]) return null;
  const file = await File.findById(recording.audioFileId).select('path').lean();
  const absolute = file ? resolveStoredAudioPath(file.path) : null;
  if (!absolute) return null;
  try {
    const stat = await fs.promises.stat(absolute);
    return stat.isFile() ? { context, absolute, size: stat.size, contentType: recording.contentType, extension: EXTENSION[recording.contentType] } : null;
  } catch { return null; }
}

function send(req, res, found, disposition) {
  res.set({ 'Content-Type': found.contentType, 'Content-Disposition': disposition, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
  const range = parseRange(req.get('Range'), found.size);
  if (range === 'unsatisfiable') { res.set('Content-Range', `bytes */${found.size}`); return res.status(416).end(); }
  const { start, end } = range || { start: 0, end: found.size - 1 };
  if (range) res.status(206).set('Content-Range', `bytes ${start}-${end}/${found.size}`);
  res.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD' || found.size === 0) return res.end();
  const stream = fs.createReadStream(found.absolute, { start, end });
  stream.on('error', () => { logger.warn({ event: 'audio_media_stream_failed', submissionId: String(req.params.submissionId) }); res.destroy(); });
  return stream.pipe(res);
}

const handler = ({ teacherOnly, disposition }) => async (req, res) => {
  try {
    const found = await locate(req, { teacherOnly });
    if (!found) return res.status(404).json(NOT_FOUND);
    return send(req, res, found, disposition(found, req));
  } catch (error) {
    logger.warn({ event: 'audio_media_failed', errorName: String(error?.name || 'Error').slice(0, 60) });
    return res.status(404).json(NOT_FOUND);
  }
};

const media = handler({ teacherOnly: false, disposition: found => `inline; filename="recording${found.extension}"` });
const download = handler({ teacherOnly: true, disposition: (found, req) => `attachment; filename="speaking-${req.params.submissionId}${found.extension}"` });

module.exports = { media, download, parseRange };
