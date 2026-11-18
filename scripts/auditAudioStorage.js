'use strict';
// READ-ONLY audit of recording storage (audio + speech-to-text). It deletes nothing and changes nothing: it only reads the audio folder and
// the database, and prints a report.
//   orphanFiles   files in <UPLOAD_BASE_PATH>/audio that no recording uses (no File record pointing at them, or a File record no recording uses)
//   missingFiles  recordings whose audio should exist but does not: FILE_RECORD_MISSING (no File record) or FILE_NOT_ON_DISK (the file is gone)
// Recordings whose audio was deleted on purpose (audioDeletedAt) are not reported. Files changed in the last 10 minutes are skipped: an upload
// in progress writes its file before its records exist. Output: counts, ids, codes and the random stored file names only (never an original
// file name, an email, a name or a transcript).
//   npm run audit:audio-storage              (on the server, from the backend folder; uses MONGO_URI and UPLOAD_BASE_PATH from its .env)
//   npm run audit:audio-storage -- --json    (the whole report as JSON)
if (require.main === module) require('dotenv').config({ quiet: true });   // CLI only: requiring this module (tests) never loads .env
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { audioRoot, resolveStoredAudioPath } = require('../src/services/audio/storage');

const RECENT_MS = 10 * 60 * 1000;
const LIST_CAP = 500;

/** Reads the audio folder and the recordings. Returns the report; never writes. */
async function auditAudioStorage({ env = process.env, now = Date.now() } = {}) {
  const AudioRecording = require('../src/models/AudioRecording');
  const File = require('../src/models/File');
  const root = audioRoot(env);
  const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()) : [];
  const recordings = await AudioRecording.find({}).select('_id audioFileId audioDeletedAt status submissionId').lean();
  const fileIds = recordings.map(recording => recording.audioFileId).filter(Boolean);
  const files = fileIds.length ? await File.find({ _id: { $in: fileIds } }).select('_id path').lean() : [];
  const fileById = new Map(files.map(file => [String(file._id), file]));

  const used = new Set();
  const missingFiles = [];
  for (const recording of recordings) {
    const file = recording.audioFileId ? fileById.get(String(recording.audioFileId)) : null;
    const absolute = file ? resolveStoredAudioPath(file.path, env) : null;
    if (absolute) used.add(path.basename(absolute));
    if (recording.audioDeletedAt) continue;
    const reason = !file ? 'FILE_RECORD_MISSING' : !absolute || !fs.existsSync(absolute) ? 'FILE_NOT_ON_DISK' : null;
    if (reason) missingFiles.push({ recordingId: String(recording._id), submissionId: recording.submissionId ? String(recording.submissionId) : null,
      status: recording.status, reason });
  }
  const orphanFiles = [];
  let skippedRecent = 0;
  for (const entry of entries) {
    if (used.has(entry.name)) continue;
    const stat = fs.statSync(path.join(root, entry.name));
    if (now - stat.mtimeMs < RECENT_MS) { skippedRecent += 1; continue; }
    orphanFiles.push({ name: entry.name, sizeBytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
  }
  return { audioFolder: root, filesOnDisk: entries.length, recordings: recordings.length, skippedRecent,
    orphanFiles: orphanFiles.slice(0, LIST_CAP), orphanFileCount: orphanFiles.length, orphanBytes: orphanFiles.reduce((sum, item) => sum + item.sizeBytes, 0),
    missingFiles: missingFiles.slice(0, LIST_CAP), missingFileCount: missingFiles.length };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // Read-only: no index or collection is created by this connection.
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const report = await auditAudioStorage();
    if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`Audio folder: ${report.audioFolder}`);
    console.log(`Files on disk: ${report.filesOnDisk} (skipped, changed in the last 10 minutes: ${report.skippedRecent}); recordings: ${report.recordings}`);
    console.log(`Files no recording uses: ${report.orphanFileCount} (${(report.orphanBytes / (1024 * 1024)).toFixed(1)} MB)`);
    for (const item of report.orphanFiles) console.log(`  orphan  ${item.name}  ${item.sizeBytes} bytes  ${item.modifiedAt}`);
    console.log(`Recordings whose file is missing: ${report.missingFileCount}`);
    for (const item of report.missingFiles) console.log(`  missing recording ${item.recordingId}  submission ${item.submissionId || '-'}  ${item.status}  ${item.reason}`);
    console.log(report.orphanFileCount || report.missingFileCount ? 'Nothing was changed. Review the lists above.' : 'All clear. Nothing was changed.');
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch(error => { console.error(`Audio storage audit failed: ${error.name}`); process.exitCode = 1; });
module.exports = { auditAudioStorage, main, RECENT_MS };
