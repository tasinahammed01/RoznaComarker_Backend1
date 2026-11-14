'use strict';
// Extraction worker: one file per worker, killed by extractRunner.js on timeout. Posts back the text or a stable error code (never a message or
// stack, which could carry file contents).
const { parentPort, workerData } = require('worker_threads');
const { ReferenceFileError } = require('./policy');
const { extractText } = require('./textExtract');

extractText(Buffer.from(workerData.buffer), workerData.kind)
  .then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: { code: error instanceof ReferenceFileError ? error.code : 'REFERENCE_FILE_CORRUPT',
    name: error instanceof ReferenceFileError ? null : String(error?.name || 'Error').slice(0, 60) } }));
