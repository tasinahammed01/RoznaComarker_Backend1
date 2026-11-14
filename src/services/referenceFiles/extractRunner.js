'use strict';
// Runs text extraction in a worker thread, one file at a time per process, with a hard time limit (20 s) and a memory limit, so a hostile or
// very heavy file can neither block the server nor exhaust its memory. The time limit starts when the worker starts, not while queued.
const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../../utils/logger');
const { LIMITS, ReferenceFileError } = require('./policy');

const WORKER = path.join(__dirname, 'extract.worker.js');
let queue = Promise.resolve();

function runOne(buffer, kind, { timeoutMs, memoryMb, workerPath }) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(workerPath, { workerData: { buffer, kind }, resourceLimits: { maxOldGenerationSizeMb: memoryMb } }); } catch {
      return reject(new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED'));
    }
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new ReferenceFileError('REFERENCE_FILE_TIMEOUT')), timeoutMs);
    worker.once('message', message => {
      if (message?.result) return finish(null, message.result);
      if (message?.error?.name) logger.warn({ message: 'Reference file extraction error', code: 'REFERENCE_FILE_EXTRACTION_ERROR', errorName: message.error.name, kind });
      finish(new ReferenceFileError(message?.error?.code || 'REFERENCE_FILE_CORRUPT'));
    });
    worker.once('error', error => finish(new ReferenceFileError(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'REFERENCE_FILE_TOO_COMPLEX' : 'REFERENCE_FILE_EXTRACTION_FAILED')));
    worker.once('exit', () => finish(new ReferenceFileError('REFERENCE_FILE_EXTRACTION_FAILED')));
  });
}

/** Extracts text in a worker: resolves { text, truncated, chars, units } or rejects with a ReferenceFileError. */
function runExtraction(buffer, kind, options = {}) {
  const settings = { timeoutMs: options.timeoutMs ?? LIMITS.extractionTimeoutMs, memoryMb: options.memoryMb ?? LIMITS.extractionMemoryMb,
    workerPath: options.workerPath || WORKER };
  const queueTimeoutMs = options.queueTimeoutMs ?? LIMITS.extractionQueueTimeoutMs;
  let expired = false, queueTimer;
  const deadline = new Promise((_, reject) => {
    queueTimer = setTimeout(() => { expired = true; reject(new ReferenceFileError('REFERENCE_FILE_BUSY')); }, queueTimeoutMs);
  });
  const turn = queue.then(() => {
    clearTimeout(queueTimer);
    return expired ? null : runOne(buffer, kind, settings);
  });
  queue = turn.catch(() => {});
  return Promise.race([turn, deadline]).finally(() => clearTimeout(queueTimer));
}

module.exports = { runExtraction };
