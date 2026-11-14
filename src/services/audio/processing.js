'use strict';
// The transcription job worker: uploaded -> queued -> transcribing -> ready | failed | cancelled. Same lease pattern as the existing
// background extraction worker for teacher uploads of course material:
// - An atomic claim takes a lease (longer than the provider timeout, twice that when the fallback is on) and a new random attempt key.
// - A result is stored only by the attempt that still holds that key while the recording is still transcribing: a cancel, or another worker that
//   took over an expired lease, makes a late result a no-op ("discarded").
// - Retryable failures wait 15 s, 60 s, 5 min (a provider Retry-After is a hint, capped at 5 min); after AUDIO_STT_MAX_ATTEMPTS (3) it fails.
// - After a restart, work left transcribing is picked up again once its lease ends; work that used all its attempts is marked failed.
// - The sweep reads an inclusion projection with a limit and no database sort (it sorts in Node), and logs counts only.
// Logs carry ids, codes and counts: never file names, paths or transcript text.
const crypto = require('crypto');
const fs = require('fs');
const AudioRecording = require('../../models/AudioRecording');
const File = require('../../models/File');
const logger = require('../../utils/logger');
const { audioSttEnabled, readLimits, STT_BACKOFF_MS, MAX_STT_BACKOFF_MS } = require('./policy');
const { resolveStoredAudioPath } = require('./storage');
const { deriveTexts, fluencyMetrics } = require('./stt/transcript');
const { SttError } = require('./stt/errors');

const SWEEP_CAP = 20;
const DEFAULT_INTERVAL_MS = 30000;
const LEASE_MARGIN_MS = 2 * 60 * 1000;   // reading the file and storing the result
const ACTIVE = ['uploaded', 'queued', 'transcribing'];
const PROJECTION = Object.freeze({ _id: 1, nextAttemptAt: 1, createdAt: 1 });

// Attempts running in this process: recording id -> AbortController (so a cancel here aborts the provider call at once).
const running = new Map();

const defaultTranscribe = options => require('./stt').transcribe(options);
const leaseMsFor = limits => limits.sttTimeoutMs * (limits.sttFallbackEnabled ? 2 : 1) + LEASE_MARGIN_MS;
/** The wait after attempt n (1-based): the schedule, or a longer Retry-After hint, never above 5 min. */
const backoffMs = (attempt, retryAfterMs) => Math.min(MAX_STT_BACKOFF_MS,
  Math.max(STT_BACKOFF_MS[Math.min(Math.max(attempt, 1), STT_BACKOFF_MS.length) - 1], Number.isFinite(retryAfterMs) ? retryAfterMs : 0));

const due = (now, maxAttempts) => ({ processingQueue: true, attempts: { $lt: maxAttempts }, $or: [
  { status: 'queued', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
  { status: 'transcribing', leaseUntil: { $lte: now } }
] });
const terminal = fields => ({ $set: { leaseUntil: null, nextAttemptAt: null, ...fields }, $unset: { processingQueue: 1 } });

/** uploaded -> queued. Returns { queued }. */
async function enqueue(id, { now = () => new Date() } = {}) {
  const at = now();
  const result = await AudioRecording.updateOne({ _id: id, status: 'uploaded' },
    { $set: { status: 'queued', queuedAt: at, nextAttemptAt: at, processingQueue: true } });
  return { queued: result.modifiedCount === 1 };
}

/** Takes the lease if the recording is due. Returns the claimed document (with lease and attempt key) or null. */
async function claim(id, { now = () => new Date(), env = process.env } = {}) {
  const { limits } = readLimits(env);
  const at = now();
  return AudioRecording.findOneAndUpdate({ _id: id, ...due(at, limits.sttMaxAttempts) },
    { $set: { status: 'transcribing', leaseUntil: new Date(at.getTime() + leaseMsFor(limits)), attemptKey: crypto.randomUUID() }, $inc: { attempts: 1 } },
    { returnDocument: 'after' }).select('+leaseUntil +attemptKey').lean();
}

const log = (event, fields) => logger.metric({ event, ...fields });

async function storedAudioPath(audioFileId) {
  const file = audioFileId ? await File.findById(audioFileId).select('path').lean() : null;
  const absolute = file ? resolveStoredAudioPath(file.path) : null;
  if (!absolute) return null;
  try { await fs.promises.access(absolute, fs.constants.R_OK); return absolute; } catch { return null; }
}

/**
 * One attempt for one recording, if it is due and no other attempt holds it. Returns { status } where status is ready, queued (a retry is
 * scheduled), failed, discarded (cancelled or taken over meanwhile) or skipped (nothing to do here). Never throws for provider failures.
 */
async function processAudioRecording(id, { transcribe = defaultTranscribe, now = () => new Date(), env = process.env } = {}) {
  const key = String(id);
  if (running.has(key)) return { status: 'skipped' };
  const controller = new AbortController();
  running.set(key, controller);
  try {
    const claimed = await claim(id, { now, env });
    if (!claimed) return { status: 'skipped' };
    const { limits } = readLimits(env);
    const context = { recordingId: key, attempt: claimed.attempts };
    const mine = { _id: claimed._id, status: 'transcribing', attemptKey: claimed.attemptKey };
    log('audio_transcription_claimed', context);

    const fail = async (code, retryable, retryAfterMs = null) => {
      const retry = retryable && claimed.attempts < limits.sttMaxAttempts;
      const at = now();
      const update = retry
        ? { $set: { status: 'queued', leaseUntil: null, lastErrorCode: code, nextAttemptAt: new Date(at.getTime() + backoffMs(claimed.attempts, retryAfterMs)) } }
        : terminal({ status: 'failed', failedAt: at, lastErrorCode: code });
      const stored = await AudioRecording.updateOne(mine, update);
      if (!stored.modifiedCount) { log('audio_transcription_discarded', { ...context, reason: 'not_current', code }); return { status: 'discarded' }; }
      log(retry ? 'audio_transcription_retry_scheduled' : 'audio_transcription_failed', { ...context, code, ...(retry ? { delayMs: update.$set.nextAttemptAt - at } : {}) });
      return { status: retry ? 'queued' : 'failed', code };
    };

    const filePath = await storedAudioPath(claimed.audioFileId);
    if (!filePath) return fail('AUDIO_FILE_UNAVAILABLE', false);

    let result;
    const startedAt = Date.now();
    try {
      result = await transcribe({ filePath, contentType: claimed.contentType, env, signal: controller.signal });
    } catch (caught) {
      if (controller.signal.aborted) { log('audio_transcription_discarded', { ...context, reason: 'cancelled' }); return { status: 'discarded' }; }
      const error = caught instanceof SttError ? caught : null;
      return fail(error ? error.code : 'AUDIO_TRANSCRIPTION_FAILED', error ? error.retryable : true, error?.retryAfterMs ?? null);
    }
    const transcript = result.transcript;
    const texts = deriveTexts(transcript);
    const derived = { derivedTextVersion: texts.derivedTextVersion, displayText: texts.displayText, assessorText: texts.assessorText,
      fluency: fluencyMetrics(transcript) };
    const stored = await AudioRecording.updateOne({ ...mine, transcript: null }, terminal({ status: 'ready', readyAt: now(), lastErrorCode: null,
      transcriptSchemaVersion: transcript.transcriptSchemaVersion, wordTimingsAvailable: transcript.wordTimingsAvailable,
      speakingCoachDataAvailable: transcript.speakingCoachDataAvailable, transcript, derived }), { writeTranscriptOnce: true });
    if (!stored.modifiedCount) { log('audio_transcription_discarded', { ...context, reason: 'not_current' }); return { status: 'discarded' }; }
    log('audio_transcription_ready', { ...context, durationMs: Date.now() - startedAt, wordCount: transcript.words.length,
      wordTimingsAvailable: transcript.wordTimingsAvailable, fallbackUsed: Boolean(result.fallbackUsed) });
    return { status: 'ready' };
  } finally {
    running.delete(key);
  }
}

/** Cancels a recording that is not finished. An attempt running in this process is aborted; one elsewhere is discarded when it returns. */
async function cancelAudioRecording(id, { now = () => new Date() } = {}) {
  const result = await AudioRecording.updateOne({ _id: id, status: { $in: ACTIVE } }, terminal({ status: 'cancelled', cancelledAt: now() }));
  if (!result.modifiedCount) return { cancelled: false };
  running.get(String(id))?.abort();
  log('audio_transcription_cancelled', { recordingId: String(id) });
  return { cancelled: true };
}

/** The sweep's query: work that is due, as an inclusion projection with a limit (one more than the cap, to tell when it was capped). No sort. */
function sweepQuery(now, limits) {
  return { filter: due(now, limits.sttMaxAttempts), projection: { ...PROJECTION }, limit: SWEEP_CAP + 1 };
}

let sweeping = null;
/**
 * Picks up work still waiting: queued and due, or left transcribing by a stopped process whose lease ended. Work that used all its attempts
 * is marked failed first so it never stays "transcribing" for ever. One sweep at a time per process; recordings are handled one by one.
 */
function resumeAudioRecordings(options = {}) {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    const { now = () => new Date(), env = process.env } = options;
    const { limits } = readLimits(env);
    const at = now();
    const exhausted = await AudioRecording.updateMany({ processingQueue: true, status: { $in: ['queued', 'transcribing'] }, attempts: { $gte: limits.sttMaxAttempts },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: at } }] }, terminal({ status: 'failed', failedAt: at, lastErrorCode: 'AUDIO_STT_ATTEMPTS_EXHAUSTED' }));
    const { filter, projection, limit } = sweepQuery(at, limits);
    const found = await AudioRecording.find(filter).select(projection).limit(limit).lean();
    const capped = found.length > SWEEP_CAP;
    const order = doc => (doc.nextAttemptAt || doc.createdAt || at).getTime();
    const batch = found.sort((a, b) => order(a) - order(b) || String(a._id).localeCompare(String(b._id))).slice(0, SWEEP_CAP);
    log('audio_transcription_sweep', { found: batch.length, capped, exhausted: exhausted.modifiedCount || 0 });
    let processed = 0;
    for (const doc of batch) {
      const outcome = await processAudioRecording(doc._id, options);
      if (outcome.status !== 'skipped') processed++;
    }
    return { found: batch.length, capped, processed, exhausted: exhausted.modifiedCount || 0 };
  })().catch(error => {
    logger.warn({ event: 'audio_transcription_sweep_failed', errorName: String(error?.name || 'Error').slice(0, 60) });
    return { found: 0, capped: false, processed: 0, exhausted: 0, failed: true };
  }).finally(() => { sweeping = null; });
  return sweeping;
}

/** Starts the timer (it never keeps the process alive) and one sweep now. Returns { intervalMs, timer, stop(), idle() }. */
function startAudioWorker({ intervalMs = DEFAULT_INTERVAL_MS, ...options } = {}) {
  let stopped = false;
  let current = null;
  const run = () => { if (stopped || current) return current; current = resumeAudioRecordings(options).finally(() => { current = null; }); return current; };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  log('audio_transcription_worker_started', { intervalMs });
  return { intervalMs, timer, stop() { stopped = true; clearInterval(timer); }, idle: () => current || Promise.resolve() };
}

/** null while AUDIO_STT_ENABLED is off: the worker never starts. */
function startAudioWorkerIfEnabled(env = process.env, options = {}) {
  return audioSttEnabled(env) ? startAudioWorker({ ...options, env }) : null;
}

module.exports = { SWEEP_CAP, leaseMsFor, backoffMs, enqueue, claim, processAudioRecording, cancelAudioRecording, sweepQuery, resumeAudioRecordings,
  startAudioWorker, startAudioWorkerIfEnabled };
