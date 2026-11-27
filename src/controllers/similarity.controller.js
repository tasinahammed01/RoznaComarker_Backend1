'use strict';
// /api/similarity: the owning teacher's similarity panel. Anyone else (another teacher, a student, a guest) gets 404. Mutations carry a
// request id (Idempotency-Key header for checks, requestId for exclusions) and exclusions a revision (409 with the current report on a
// conflict). /api/similarity/webhooks: the asynchronous provider's callbacks (Copyleaks), authenticated by the shared secret.
const SimilarityReport = require('../models/SimilarityReport');
const Submission = require('../models/Submission');
const { similarityEnabled } = require('../services/similarity/policy');
const internal = require('../services/similarity/internal.service');
const check = require('../services/similarity/check.service');
const { teacherView } = require('../services/similarity/views');
const { kickSimilarityWorker } = require('../services/similarity/worker');

const NOT_FOUND = Object.freeze({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
const ERRORS = Object.freeze({
  not_eligible: [409, 'SIMILARITY_NOT_ELIGIBLE', 'This essay cannot be checked yet.'],
  in_progress: [409, 'SIMILARITY_IN_PROGRESS', 'A similarity check is already running for this essay.'],
  not_retryable: [409, 'SIMILARITY_NOT_RETRYABLE', 'There is nothing to try again for this check.'],
  submission_cap: [429, 'SIMILARITY_SUBMISSION_CAP', 'This essay has been checked the maximum number of times.'],
  daily_cap: [429, 'SIMILARITY_DAILY_CAP', 'You have used all of today\'s similarity checks. Try again tomorrow.']
});
const KEY = /^[A-Za-z0-9._:-]{1,64}$/u;
const SOURCE_ID = /^s\d{1,3}$/u;
const VIEWABLE = Object.freeze(['completed', 'expired']);

function requireEnabled(_req, res, next) { return similarityEnabled() ? next() : res.status(404).json(NOT_FOUND); }
/** A student, guest or admin gets the same 404 as a teacher who does not own the essay (never a 403 that says the route exists). */
function hideFromNonTeachers(req, res, next) { return req.user?.role === 'teacher' ? next() : res.status(404).json(NOT_FOUND); }
const ctx = () => ({ env: process.env });
const notFound = res => res.status(404).json(NOT_FOUND);
const invalid = (res, message) => res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message });

async function ownedEssay(req) {
  const essay = await internal.loadEssay(req.params.submissionId);
  return essay && String(essay.klass.teacher) === String(req.user?._id) ? essay : null;
}

async function viewFor(req, essay) {
  const [report, notice, checksLeftToday] = await Promise.all([
    SimilarityReport.findOne({ submissionId: essay.submission._id }).select('+providerAudit').lean(),
    Submission.findById(essay.submission._id).select('+similarityNotice').lean(),
    check.checksLeftToday(req.user._id, ctx())]);
  return teacherView({ report, essay, viewerId: req.user._id, checksLeftToday, noticeShown: Boolean(notice?.similarityNotice?.version) });
}

const sendError = (res, out) => {
  if (out.code === 'not_found') return notFound(res);
  const [status, code, message] = ERRORS[out.code] || [500, 'SIMILARITY_FAILED', 'The similarity check could not be started.'];
  return res.status(status).json({ success: false, code, message, ...(out.reason ? { reason: out.reason } : {}) });
};

async function getReport(req, res, next) {
  try {
    const essay = await ownedEssay(req);
    if (!essay) return notFound(res);
    return res.json({ success: true, data: await viewFor(req, essay) });
  } catch (error) { return next(error); }
}

async function startCheck(req, res, next) {
  try {
    const key = req.get('Idempotency-Key');
    if (!KEY.test(String(key || ''))) return invalid(res, 'An Idempotency-Key header is required.');
    if (req.body?.confirmPermission !== undefined && typeof req.body.confirmPermission !== 'boolean') return invalid(res, 'confirmPermission must be true or false.');
    const essay = await ownedEssay(req);
    if (!essay) return notFound(res);
    const out = await check.requestCheck({ userId: req.user._id, submissionId: essay.submission._id, requestId: key,
      confirmPermission: req.body?.confirmPermission === true }, ctx());
    if (!out.ok) return sendError(res, out);
    kickSimilarityWorker();
    return res.status(202).json({ success: true, data: await viewFor(req, essay) });
  } catch (error) { return next(error); }
}

async function retry(req, res, next) {
  try {
    const key = req.get('Idempotency-Key');
    if (!KEY.test(String(key || ''))) return invalid(res, 'An Idempotency-Key header is required.');
    const essay = await ownedEssay(req);
    if (!essay) return notFound(res);
    const out = await check.retryCheck({ userId: req.user._id, submissionId: essay.submission._id, requestId: key }, ctx());
    if (!out.ok) return sendError(res, out);
    kickSimilarityWorker();
    return res.status(202).json({ success: true, data: await viewFor(req, essay) });
  } catch (error) { return next(error); }
}

function mutationInput(req, res, { needsExcluded }) {
  const { excluded, revision, requestId } = req.body || {};
  if (needsExcluded && typeof excluded !== 'boolean') { invalid(res, 'excluded must be true or false.'); return null; }
  if (!Number.isSafeInteger(revision) || revision < 0) { invalid(res, 'revision is required.'); return null; }
  if (!KEY.test(String(requestId || ''))) { invalid(res, 'requestId is required.'); return null; }
  return { excluded, revision, requestId };
}

/** After a refused update: 404 (no such source), 409 in progress, or 409 revision conflict with the current report. */
async function refused(req, res, essay, sourceId) {
  const report = await SimilarityReport.findOne({ submissionId: essay.submission._id }).lean();
  if (!report || (sourceId && !report.sources.some(s => s.sourceId === sourceId))) return notFound(res);
  if (!VIEWABLE.includes(report.status)) return sendError(res, { code: 'in_progress' });
  return res.status(409).json({ success: false, code: 'SIMILARITY_REVISION_CONFLICT', message: 'This report changed. It has been reloaded.',
    data: await viewFor(req, essay) });
}

async function setExcluded(req, res, next) {
  try {
    if (!SOURCE_ID.test(String(req.params.sourceId))) return notFound(res);
    const input = mutationInput(req, res, { needsExcluded: true });
    if (!input) return undefined;
    const essay = await ownedEssay(req);
    if (!essay) return notFound(res);
    const replay = await SimilarityReport.findOne({ submissionId: essay.submission._id, lastMutationId: input.requestId }).select('_id').lean();
    if (replay) return res.json({ success: true, data: await viewFor(req, essay) });
    const at = new Date();
    const updated = await SimilarityReport.findOneAndUpdate(
      { submissionId: essay.submission._id, revision: input.revision, status: { $in: VIEWABLE }, 'sources.sourceId': req.params.sourceId },
      { $set: { 'sources.$.excluded': input.excluded, 'sources.$.excludedAt': input.excluded ? at : null,
        'sources.$.excludedBy': input.excluded ? req.user._id : null, lastMutationId: input.requestId }, $inc: { revision: 1 } },
      { returnDocument: 'after' });
    if (!updated) return refused(req, res, essay, req.params.sourceId);
    return res.json({ success: true, data: await viewFor(req, essay) });
  } catch (error) { return next(error); }
}

async function restoreAll(req, res, next) {
  try {
    const input = mutationInput(req, res, { needsExcluded: false });
    if (!input) return undefined;
    const essay = await ownedEssay(req);
    if (!essay) return notFound(res);
    const replay = await SimilarityReport.findOne({ submissionId: essay.submission._id, lastMutationId: input.requestId }).select('_id').lean();
    if (replay) return res.json({ success: true, data: await viewFor(req, essay) });
    const updated = await SimilarityReport.findOneAndUpdate(
      { submissionId: essay.submission._id, revision: input.revision, status: { $in: VIEWABLE } },
      { $set: { 'sources.$[].excluded': false, 'sources.$[].excludedAt': null, 'sources.$[].excludedBy': null, lastMutationId: input.requestId },
        $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!updated) return refused(req, res, essay, null);
    return res.json({ success: true, data: await viewFor(req, essay) });
  } catch (error) { return next(error); }
}

// ---- provider webhooks: always a JSON body and the status the service decides (404 hides everything when off or not authentic) ----
const webhookReply = (res, status) => res.status(status).json(status === 404 ? NOT_FOUND : { success: true });
async function copyleaksStatus(req, res, next) {
  try { return webhookReply(res, await check.onCopyleaksStatus(req.params.status, req.params.scanId, req.headers, req.body, ctx())); } catch (error) { return next(error); }
}
const copyleaksExport = kind => async (req, res, next) => {
  try {
    return webhookReply(res, await check.onCopyleaksExport(kind, req.params.scanId, req.params.resultId ?? null, req.headers, req.body, ctx()));
  } catch (error) { return next(error); }
};

module.exports = { NOT_FOUND, requireEnabled, hideFromNonTeachers, getReport, startCheck, retry, setExcluded, restoreAll, copyleaksStatus, copyleaksExport };
