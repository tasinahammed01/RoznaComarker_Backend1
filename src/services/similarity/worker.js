'use strict';
// The similarity worker: on each tick it runs queued checks and sweeps submitted ones (poll, resend, expire). Starts only while
// SIMILARITY_ENABLED is on; its timer never keeps the process alive. A new check wakes it at once (kick) instead of waiting for the tick.
const { similarityEnabled } = require('./policy');
const check = require('./check.service');
const logger = require('../../utils/logger');

const DEFAULT_INTERVAL_MS = 15000;
let activeWorker = null;

function startSimilarityWorker({ intervalMs = DEFAULT_INTERVAL_MS, ctx = {} } = {}) {
  let stopped = false;
  let current = null;
  const tick = async () => { await check.runQueued(ctx); await check.sweep(ctx); };
  const run = () => {
    if (stopped || current) return current;
    current = tick().catch(error => logger.error?.({ event: 'similarity.worker.failed', reason: error?.name || 'Error' })).finally(() => { current = null; });
    return current;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  logger.info?.({ event: 'similarity_worker_started', intervalMs });
  const worker = { intervalMs, timer, run, stop() { stopped = true; clearInterval(timer); if (activeWorker === worker) activeWorker = null; },
    idle: () => current || Promise.resolve() };
  activeWorker = worker;
  return worker;
}

/** A check was queued: run now. Does nothing unless this process runs the worker (never in tests unless started). */
function kickSimilarityWorker() {
  const worker = activeWorker;
  if (worker) setImmediate(() => { void worker.run(); });
}

/** null while SIMILARITY_ENABLED is off: the worker never starts. */
function startSimilarityWorkerIfEnabled(env = process.env, options = {}) {
  return similarityEnabled(env) ? startSimilarityWorker({ ...options, ctx: { ...(options.ctx || {}), env } }) : null;
}

module.exports = { startSimilarityWorker, startSimilarityWorkerIfEnabled, kickSimilarityWorker, DEFAULT_INTERVAL_MS };
