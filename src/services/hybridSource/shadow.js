'use strict';
const sharp = require('sharp');
const { mode } = require('./contract');
const { read } = require('./reader');
const { evidenceKey, cropBounds, validIdentity } = require('./reconcile');
const { reconcileLocal } = require('./localReconciliation');
const rawEvidence = Symbol('private Google source evidence');
const running = new Map();
const completed = new Set();
const MAX_ACTIVE = 2;
async function claim(identity) {
  const Evidence = require('../../models/HybridOcrEvidence');
  // Unique key makes admission durable across processes and recovery attempts.
  // An interrupted paid attempt is not automatically replayed under the same run.
  const result = await Evidence.updateOne({ _id: evidenceKey(identity) }, { $setOnInsert: {
    evidenceKey: evidenceKey(identity),
    submissionId: identity.submissionId, runId: identity.runId, status: 'running',
    expiresAt: new Date(Date.now() + 30 * 86400000)
  } }, { upsert: true, maxTimeMS: 3000 });
  return result.upsertedCount === 1;
}
async function persist(identity, payload) {
  // A completed old run may retain evidence for investigation, but can never write
  // to the Submission. Re-check run ownership before inserting diagnostic evidence.
  const Submission = require('../../models/Submission');
  if (!(await Submission.exists({ _id: identity.submissionId, ocrJobId: identity.runId }))) return;
  if (Buffer.byteLength(JSON.stringify(payload)) > 512000) payload = {
    status: 'OCR_SOURCE_EVIDENCE_LIMIT', identity, durationMs: payload.durationMs };
  const Evidence = require('../../models/HybridOcrEvidence');
  await Evidence.updateOne({ _id: evidenceKey(identity), status: 'running' }, { $set: {
    submissionId: identity.submissionId, runId: identity.runId, status: payload.status,
    payload, expiresAt: new Date(Date.now() + 30 * 86400000)
  } }, { maxTimeMS: 3000 });
}
// No queue retains image buffers during classroom bursts. Two admitted pages run
// concurrently; excess pages are skipped. Shadow work never delays legacy output.
function observe({ bytes, mimeType, identity, google, env = process.env,
  reader = read, save = persist, admit = claim, isCurrentJob = async () => true }) {
  const selected = mode(env);
  if (selected === 'legacy' || !validIdentity(identity)) return null;
  const key = evidenceKey(identity);
  if (running.has(key)) return running.get(key);
  if (completed.has(key) || running.size >= MAX_ACTIVE) return null;
  const started = Date.now();
  const controller = new AbortController();
  const deadlineAt = started + 45000;
  const timer = setTimeout(() => controller.abort(), 45000);
  timer.unref?.();
  const task = (async () => {
    let payload;
    let admitted = false;
    try {
      if (!(await isCurrentJob())) return;
      admitted = await admit(identity);
      if (!admitted) return;
      const [result, detected] = await Promise.all([
        reader({ bytes, mimeType, deadlineAt, signal: controller.signal }), google
      ]);
      if (controller.signal.aborted || !(await isCurrentJob())) return;
      const native = detected[rawEvidence];
      if (!native || native.length !== 1 || native[0].dimensionsMatch === false) throw new Error('missing evidence');
      const words = native[0].words.map((w, index) => ({ ...w,
        id: `word_${identity.fileId}_${identity.pageNumber}_${index + 1}` }));
      const comparison = reconcileLocal(result.reader, words, identity, { googleIdentity: identity, coordinateSpace: 'display-image' });
      const crops = [];
      {
        for (const binding of comparison.bindings.filter(b => b.kind === 'substitution' && b.geometryUnique).slice(0, 2)) {
          if (Date.now() + 5000 >= deadlineAt || !(await isCurrentJob())) break;
          const bounds = cropBounds(binding, words, identity);
          if (!bounds) continue;
          try {
            const crop = await sharp(bytes).extract(bounds).png().toBuffer();
            const reread = await reader({ bytes: crop, mimeType: 'image/png', deadlineAt,
              signal: controller.signal });
            // Contradictory first-pass evidence remains uncertain even after a crop.
            crops.push({ bounds, reader: reread.reader, attempts: reread.attempts });
          } catch { crops.push({ bounds, status: 'SOURCE_UNREADABLE' }); }
        }
      }
      payload = { status: 'compared', identity, reader: result.reader,
        google: native[0], comparison, crops, attempts: result.attempts, durationMs: Date.now() - started };
    } catch (error) {
      // A losing/failed admission must never overwrite another worker's evidence.
      if (!admitted) return;
      // Never persist provider messages, request bodies, URLs or image buffers.
      const safeCodes = ['OCR_SOURCE_CAPABILITY_UNAVAILABLE', 'OCR_SOURCE_CAPABILITY_UNVERIFIED',
        'OCR_SOURCE_CANCELLED', 'OCR_SOURCE_SCHEMA', 'OCR_SOURCE_TRANSCRIPT_MISMATCH',
        'OCR_SOURCE_ALIGNMENT_LIMIT', 'OCR_SOURCE_IMAGE_LIMIT', 'AI_CHAIN_EXHAUSTED', 'AI_TOTAL_BUDGET_EXHAUSTED'];
      payload = { status: 'SOURCE_UNREADABLE', identity, durationMs: Date.now() - started,
        errorCode: safeCodes.includes(error?.code) ? error.code : 'OCR_SOURCE_UNAVAILABLE',
        attemptCount: Array.isArray(error?.attempts) ? Math.min(error.attempts.length, 2) : 0 };
    }
    if (mode(env) === 'hybrid_shadow' && await isCurrentJob()) await save(identity, payload);
  })().catch(() => undefined).finally(() => {
    clearTimeout(timer); controller.abort(); running.delete(key);
    completed.add(key);
    if (completed.size > 128) completed.delete(completed.values().next().value);
  });
  running.set(key, task);
  return task;
}
module.exports = { observe, persist, rawEvidence };
