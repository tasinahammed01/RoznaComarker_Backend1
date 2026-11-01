#!/usr/bin/env node
'use strict';
/**
 * READ-ONLY: saves one page image of a submission to a file, so scripts/geometry-reason.js can be run on it.
 *
 *   node scripts/export-submission-image.js <submissionId> [outputPath] [--index N]
 *
 * Default output: D:\ocr-eval\real.jpg (the bytes are copied unchanged, whatever the real format is). --index N picks the N-th
 * file of the submission (1 = first, in upload order).
 * It reads the submission's `files` list and each File record (database, read only: two find queries, no write), then takes the
 * bytes from the uploads folder on this machine (UPLOAD_BASE_PATH or "uploads", sub-folder from the record) or, if that file
 * is not here, from the record's public URL. Prints only: how many files, the stored file name (a random id, not the student's
 * file name), its size and where the bytes came from. No student text, names, e-mails or connection string are printed.
 * The connection string is read from MONGO_URI (environment, or backend/.env on your machine) and is never printed.
 */
const fs = require('fs');
const path = require('path');

const ID = /^[a-f0-9]{24}$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

async function connect() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });   // does not override variables already set
  const uri = process.env.MONGO_URI;
  if (!uri) throw Object.assign(new Error('MONGO_URI is not set'), { name: 'ConfigurationError' });
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  return { db: mongoose.connection.db, close: () => mongoose.disconnect() };
}

async function main(argv) {
  const args = argv.filter((a, i) => a !== '--index' && argv[i - 1] !== '--index');
  const at = argv.indexOf('--index'), index = at >= 0 ? Number(argv[at + 1]) : 1;
  const [id, out = 'D:\\ocr-eval\\real.jpg'] = args;
  if (!ID.test(id || '') || !Number.isInteger(index) || index < 1) {
    console.error('Usage: node scripts/export-submission-image.js <submissionId> [outputPath] [--index N]');
    return 2;
  }
  let connection;
  try {
    connection = await connect();
    const { ObjectId } = require('mongoose').Types, { db } = connection;
    const submission = await db.collection('submissions').findOne({ _id: new ObjectId(id) }, { projection: { files: 1 } });
    if (!submission) { console.log('submission not found'); return 1; }
    const ids = (submission.files || []).map(String);
    const records = await db.collection('files').find({ _id: { $in: (submission.files || []) } },
      { projection: { filename: 1, path: 1, url: 1, type: 1, uploadOrder: 1, sizeBytes: 1 } }).toArray();
    records.sort((a, b) => (a.uploadOrder ?? ids.indexOf(String(a._id))) - (b.uploadOrder ?? ids.indexOf(String(b._id))));
    console.log(`files on the submission: ${ids.length}, found in the database: ${records.length}`);
    const file = records[index - 1];
    if (!file) { console.log('no file at that index'); return 1; }
    const name = SAFE_NAME.test(file.filename || '') ? file.filename : null;
    if (!name) { console.log('the stored file name is not a plain name; stopping'); return 1; }
    console.log(`file ${index}: ${name}, type ${file.type || 'unknown'}, size in record ${file.sizeBytes ?? 'unknown'}`);
    const base = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
    const candidates = [path.join(__dirname, '..', base, file.type || 'submissions', name), path.join(__dirname, '..', String(file.path || '').replace(/^[\\/]+/, ''))];
    let bytes = null, from = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { bytes = fs.readFileSync(candidate); from = 'this computer (uploads folder)'; break; }
    }
    if (!bytes && /^https?:\/\//i.test(file.url || '')) {
      try {
        const response = await fetch(file.url);
        if (response.ok) { bytes = Buffer.from(await response.arrayBuffer()); from = 'the public URL of the record'; }
        else console.log(`the public URL answered HTTP ${response.status}`);
      } catch { console.log('the public URL could not be reached'); }
    }
    if (!bytes) {
      console.log(`the image is not on this computer. On the server it is at: ${base}/${file.type || 'submissions'}/${name} (relative to the backend folder)`);
      return 1;
    }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, bytes);
    console.log(`saved ${bytes.length} bytes from ${from} to ${path.resolve(out)}`);
    return 0;
  } catch (error) {
    console.error(`failed: ${error?.name || 'Error'}`);   // the name only: a message could contain the connection string
    return 1;
  } finally { if (connection) await connection.close().catch(() => {}); }
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code));
module.exports = { main };
