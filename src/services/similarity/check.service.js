'use strict';
// The similarity check job. A teacher asks for a check on their own student's essay; the per-submission and daily caps are reserved
// atomically; the worker runs it: the internal comparison always, the external provider only when the essay may be sent (the student or
// guest saw the notice, or the teacher confirmed permission for an essay they uploaded) and the provider is configured and under the daily
// spend stop. States: queued -> running -> completed | failed, or running -> submitted (an asynchronous provider: webhooks or polling) ->
// completed | expired. The internal result is saved first, so the teacher sees it while an external check waits. A source the teacher
// excluded stays excluded in a new check. Every function takes ctx { env, fetch, now } (tests inject them).
const crypto = require('crypto');
const mongoose = require('mongoose');
const SimilarityReport = require('../../models/SimilarityReport');
const Submission = require('../../models/Submission');
const { similarityEnabled, providerName, readSettings, webhookConfig } = require('./policy');
const { getProvider, providerByName, resolveSources, ProviderError, SOURCE_LABELS } = require('./provider');
const internal = require('./internal.service');
const usage = require('./usage');
const logger = require('../../utils/logger');

const ACTIVE = Object.freeze(['queued', 'running', 'submitted']);
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BATCH = 5;
const SCAN_ID = /^rb[a-f0-9]{24}$/u;
const RESULT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const STATUS_EVENTS = Object.freeze(['completed', 'error', 'creditschecked', 'indexed']);
const EXPORT_KINDS = Object.freeze(['results', 'crawled', 'completed']);

const now = ctx => (ctx.now ? ctx.now() : new Date());
const envOf = ctx => ctx.env || process.env;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const backoffMs = attempts => Math.min(30, 2 ** attempts) * 60 * 1000;
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

async function ownedEssay(userId, submissionId) {
  const essay = await internal.loadEssay(submissionId);
  if (!essay || String(essay.klass.teacher) !== String(userId)) return null;
  return essay;
}

/** May this essay go to an external service? The notice was shown, or the teacher confirms permission for an essay they uploaded. */
async function externalPermitted(submissionId, confirmPermission) {
  const doc = await Submission.findById(submissionId).select('+similarityNotice +teacherUpload').lean();
  if (doc?.similarityNotice?.version) return true;
  return Boolean(doc?.teacherUpload && confirmPermission === true);
}

async function checksLeftToday(teacherId, ctx) {
  const { settings } = readSettings(envOf(ctx));
  return Math.max(0, settings.dailyChecksPerTeacher - await usage.checksUsed(teacherId, now(ctx)));
}

/**
 * The owning teacher asks for a check. { ok: true, report } or { ok: false, code: not_found | not_eligible (reason) | in_progress |
 * submission_cap | daily_cap }. The same requestId again returns the same check.
 */
async function requestCheck({ userId, submissionId, requestId, confirmPermission }, ctx) {
  const env = envOf(ctx);
  if (!similarityEnabled(env)) return fail('not_found');
  const essay = await ownedEssay(userId, submissionId);
  if (!essay) return fail('not_found');
  const { settings } = readSettings(env);
  if (!essay.tokens.length) return fail('not_eligible', { reason: 'no_text' });
  if (!essay.eligible) return fail('not_eligible', { reason: 'transcript_not_confirmed' });
  if (essay.tokens.length > settings.maxWords) return fail('not_eligible', { reason: 'too_long' });
  const existing = await SimilarityReport.findOne({ submissionId: essay.submission._id }).lean();
  if (existing && existing.lastRequestId === requestId) return { ok: true, report: existing };
  if (existing && ACTIVE.includes(existing.status)) return fail('in_progress', { report: existing });
  if ((existing?.checks?.length || 0) >= settings.checksPerSubmission) return fail('submission_cap');
  const at = now(ctx);
  if (!await usage.reserveCheck(userId, settings.dailyChecksPerTeacher, at)) return fail('daily_cap');
  const permitted = await externalPermitted(essay.submission._id, confirmPermission);
  try {
    const report = await SimilarityReport.findOneAndUpdate(
      { submissionId: essay.submission._id, status: { $nin: ACTIVE }, 'checks.requestId': { $ne: requestId } },
      { $set: { assignmentId: essay.submission.assignment, classId: essay.submission.class, teacherId: essay.klass.teacher, status: 'queued',
        inQueue: true, nextAttemptAt: at, lastRequestId: requestId, external: { state: permitted ? 'pending' : 'not_permitted' }, errorCode: null,
        'job.attempts': 0, 'job.charged': false, 'job.spendUsd': 0, 'job.spendDay': null, 'job.submittedAt': null, 'job.deadlineAt': null, 'job.resentAt': null,
        'job.retried': false },
      $unset: { 'job.externalRef': 1, providerPending: 1 }, $inc: { revision: 1 },
      $push: { checks: { at, by: userId, requestId, textSha256: sha256(essay.text), day: usage.dayOf(at), permitted } } },
      { upsert: true, returnDocument: 'after', lean: true });
    return { ok: true, report };
  } catch (error) {
    await usage.releaseCheck(userId, usage.dayOf(at));
    if (error?.code === 11000) {
      const current = await SimilarityReport.findOne({ submissionId: essay.submission._id }).lean();
      if (current?.lastRequestId === requestId) return { ok: true, report: current };
      return fail('in_progress', { report: current });
    }
    throw error;
  }
}

/** The external part failed or expired: queue it again (the internal part is recomputed) without using a check. Once per check. */
async function retryCheck({ userId, submissionId, requestId }, ctx) {
  const env = envOf(ctx);
  if (!similarityEnabled(env)) return fail('not_found');
  const essay = await ownedEssay(userId, submissionId);
  if (!essay) return fail('not_found');
  const at = now(ctx);
  const report = await SimilarityReport.findOneAndUpdate(
    { submissionId: essay.submission._id, $or: [{ status: { $in: ['failed', 'expired'] } }, { status: 'completed', 'external.state': { $in: ['failed', 'expired'] } }],
      'job.retried': { $ne: true } },
    { $set: { status: 'queued', inQueue: true, nextAttemptAt: at, lastRequestId: requestId, errorCode: null, 'job.attempts': 0, 'job.charged': false,
      'job.spendUsd': 0, 'job.spendDay': null, 'job.deadlineAt': null, 'job.resentAt': null, 'job.retried': true },
    $unset: { 'job.externalRef': 1, providerPending: 1 }, $inc: { revision: 1 } },
    { returnDocument: 'after', lean: true });
  if (!report) return fail('not_retryable');
  // the external state goes back to pending only when the essay may be sent (as for the check itself)
  const last = report.checks[report.checks.length - 1];
  await SimilarityReport.updateOne({ _id: report._id }, { $set: { external: { state: last?.permitted === false ? 'not_permitted' : 'pending' } } });
  return { ok: true, report: await SimilarityReport.findById(report._id).lean() };
}

// ---- running a check ----------------------------------------------------------------------------------------------------------------

const identityOf = source => (source.kind === 'internal' ? `internal:${source.refSubmissionId}` : `${source.kind}:${source.url || source.title || ''}`);

/** Merges external and internal sources, numbers them s1..sN, and keeps the previous check's exclusions for the same sources. */
function numberSources(previous, external, internalSources) {
  const excluded = new Map((previous || []).filter(s => s.excluded).map(s => [identityOf(s), s]));
  return [...external, ...internalSources].map((source, i) => {
    const kept = excluded.get(identityOf(source));
    return { ...source, label: source.label || SOURCE_LABELS[source.kind], sourceId: `s${i + 1}`, excluded: Boolean(kept),
      ...(kept ? { excludedAt: kept.excludedAt, excludedBy: kept.excludedBy } : {}) };
  });
}

const internalAsSources = list => list.map(s => ({ ...s, label: SOURCE_LABELS.internal, compared: true }));

async function claimNext(ctx) {
  const at = now(ctx);
  return SimilarityReport.findOneAndUpdate(
    { inQueue: true, $or: [{ status: 'queued', nextAttemptAt: { $lte: at } }, { status: 'running', 'job.leaseUntil': { $lt: at } }] },
    { $set: { status: 'running', 'job.leaseUntil': new Date(at.getTime() + LEASE_MS), 'job.attemptKey': crypto.randomUUID() }, $inc: { 'job.attempts': 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after', lean: true }).select('+job.attemptKey');
}

const textOf = essay => ({ sha256: sha256(essay.text), chars: essay.text.length, words: essay.tokens.length, origin: essay.origin });

async function finish(filter, { sources, external, essay, settings, audit }, ctx) {
  const set = { status: 'completed', external, completedAt: now(ctx), sources, errorCode: null };
  if (essay) set.text = textOf(essay);
  if (settings) set.settings = { excludeQuotes: settings.excludeQuotes, minMatchWords: settings.minMatchWords, internalScope: settings.internalScope };
  if (audit) set.providerAudit = audit;
  return SimilarityReport.updateOne(filter, { $set: set, $unset: { inQueue: 1, nextAttemptAt: 1, providerPending: 1, 'job.leaseUntil': 1 }, $inc: { revision: 1 } });
}

const auditOf = (provider, result, ref, ctx) => ({ provider: provider.name, externalRef: ref || undefined, units: result?.units, costUsd: result?.costUsd,
  resultCount: result?.resultCount, queryWords: result?.queryWords, at: now(ctx) });

async function releaseSpendOf(report) {
  if (report.job?.spendUsd > 0 && report.job?.spendDay) await usage.adjustSpend(-report.job.spendUsd, report.job.spendDay);
}

/** Runs one claimed report. */
async function runClaimed(report, ctx) {
  const env = envOf(ctx);
  const mine = { _id: report._id, status: 'running', 'job.attemptKey': report.job.attemptKey };
  const essay = report.job.attempts > MAX_ATTEMPTS + 2 ? null : await internal.loadEssay(report.submissionId);
  if (!essay || !essay.eligible) {
    const last = report.checks[report.checks.length - 1];
    await SimilarityReport.updateOne(mine, { $set: { status: 'failed', errorCode: 'submission_unavailable', completedAt: now(ctx), 'checks.$[last].refunded': true },
      $unset: { inQueue: 1, nextAttemptAt: 1, 'job.leaseUntil': 1 }, $inc: { revision: 1 } }, { arrayFilters: [{ 'last.requestId': last?.requestId }] });
    if (last?.day && !report.job.charged) await usage.releaseCheck(last.by, last.day);
    await releaseSpendOf(report);
    return;
  }
  const { settings } = readSettings(env);
  await internal.indexSubmission(essay.submission._id);
  const blocked = await internal.blockedMask(essay, settings);
  const internalSources = internalAsSources(await internal.compareInternal(essay, blocked, settings));
  const done = (externalSources, external, audit) => finish(mine, { sources: numberSources(report.sources, externalSources, internalSources), external, essay,
    settings, audit }, ctx);
  if (report.external?.state !== 'pending') return done([], report.external || { state: 'skipped' });
  const provider = getProvider(env);
  if (!provider || !provider.isConfigured(env, settings)) return done([], { state: 'not_configured' });
  const at = now(ctx);
  let spendUsd = report.job.spendUsd || 0;
  let spendDay = report.job.spendDay;
  if (!spendDay) {
    const estimate = provider.estimate(essay.tokens.length, settings).usd;
    if (!await usage.reserveSpend(estimate, settings.dailySpendUsd, at)) return done([], { state: 'skipped', reason: 'daily_spend_reached' });
    spendUsd = estimate; spendDay = usage.dayOf(at);
    await SimilarityReport.updateOne(mine, { $set: { 'job.spendUsd': spendUsd, 'job.spendDay': spendDay } });
  }
  const scanId = `rb${crypto.randomBytes(12).toString('hex')}`;
  let out;
  try {
    out = await provider.submit({ text: essay.text, words: essay.tokens.length, scanId }, { env, settings, fetch: ctx.fetch });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError('provider_error', { retryable: true, charged: true });
    if (providerError.retryable && report.job.attempts < MAX_ATTEMPTS) {
      await SimilarityReport.updateOne(mine, { $set: { status: 'queued', nextAttemptAt: new Date(at.getTime() + backoffMs(report.job.attempts)),
        ...(providerError.charged ? { 'job.charged': true } : {}) }, $unset: { 'job.leaseUntil': 1 } });
      return;
    }
    if (!providerError.charged && !report.job.charged) await usage.adjustSpend(-spendUsd, spendDay);
    logger.warn?.({ event: 'similarity.provider.failed', provider: provider.name, code: providerError.code });
    return done([], { state: 'failed', reason: providerError.code }, { provider: provider.name, errorId: providerError.code, at });
  }
  if (out.state === 'submitted') {
    const deadline = readSettings(env).settings.providerDeadlineMinutes * 60 * 1000;
    await SimilarityReport.updateOne(mine, { $set: { status: 'submitted', external: { state: 'submitted' }, 'job.externalRef': out.externalRef,
      'job.submittedAt': at, 'job.deadlineAt': new Date(at.getTime() + deadline), 'job.charged': true, providerPending: out.pending || {},
      providerAudit: { provider: provider.name, externalRef: out.externalRef, at }, sources: numberSources(report.sources, [], internalSources),
      text: textOf(essay), settings: { excludeQuotes: settings.excludeQuotes, minMatchWords: settings.minMatchWords, internalScope: settings.internalScope } },
      $unset: { 'job.leaseUntil': 1 }, $inc: { revision: 1 } });
    return;
  }
  const result = out.result;
  if (Number.isFinite(result.costUsd) && result.costUsd !== spendUsd) await usage.adjustSpend(result.costUsd - spendUsd, spendDay);
  const externalSources = resolveSources(result, { text: essay.text, tokens: essay.tokens, blocked, settings });
  return done(externalSources, { state: 'completed' }, auditOf(provider, result, null, ctx));
}

/** Claims and runs up to BATCH queued (or abandoned) checks. Returns how many ran. */
async function runQueued(ctx = {}) {
  if (!similarityEnabled(envOf(ctx))) return 0;
  let count = 0;
  for (let i = 0; i < BATCH; i++) {
    const report = await claimNext(ctx);
    if (!report) break;
    count++;
    try { await runClaimed(report, ctx); } catch (error) {
      logger.error?.({ event: 'similarity.check.crashed', reason: error?.name || 'Error' });
      await SimilarityReport.updateOne({ _id: report._id, status: 'running' }, { $set: { status: 'queued',
        nextAttemptAt: new Date(now(ctx).getTime() + backoffMs(report.job.attempts)) }, $unset: { 'job.leaseUntil': 1 } });
    }
  }
  return count;
}

// ---- asynchronous completion (webhooks or polling) ------------------------------------------------------------------------------------

const submittedFilter = ref => ({ 'job.externalRef': ref, status: 'submitted' });
const loadSubmitted = ref => SimilarityReport.findOne(submittedFilter(ref)).select('+providerPending +providerAudit +job.externalRef').lean();

/** Applies a provider outcome to a submitted report: waiting (save pending), completed, failed, or ignored. */
async function applyOutcome(report, outcome, ctx) {
  const env = envOf(ctx);
  const filter = submittedFilter(report.job.externalRef);
  const internalSources = (report.sources || []).filter(s => s.kind === 'internal');
  const audit = report.providerAudit || {};
  if (outcome.state === 'waiting') { await SimilarityReport.updateOne(filter, { $set: { providerPending: outcome.pending } }); return; }
  if (outcome.state === 'failed') {
    if (outcome.charged === false) await releaseSpendOf(report);
    await finish(filter, { sources: internalSources, external: { state: 'failed', reason: String(outcome.errorId || 'provider_error').slice(0, 64) },
      audit: { ...audit, errorId: outcome.errorId, at: now(ctx) } }, ctx);
    return;
  }
  if (outcome.state !== 'completed') return;
  const essay = await internal.loadEssay(report.submissionId);
  if (!essay) { await finish(filter, { sources: internalSources, external: { state: 'failed', reason: 'submission_unavailable' } }, ctx); return; }
  const { settings } = readSettings(env);
  const blocked = await internal.blockedMask(essay, settings);
  const result = outcome.result;
  if (Number.isFinite(result.costUsd) && report.job.spendDay && result.costUsd !== report.job.spendUsd) {
    await usage.adjustSpend(result.costUsd - (report.job.spendUsd || 0), report.job.spendDay);
  }
  const externalSources = resolveSources(result, { text: essay.text, tokens: essay.tokens, blocked, settings });
  const provider = providerByName(audit.provider) || { name: audit.provider };
  await finish(filter, { sources: numberSources(report.sources, externalSources, internalSources), external: { state: 'completed' },
    audit: auditOf(provider, result, report.job.externalRef, ctx) }, ctx);
}

const copyleaksReady = env => similarityEnabled(env) && providerName(env) === 'copyleaks' && Boolean(webhookConfig(env));
const lowerHeaders = headers => Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), Array.isArray(v) ? v[0] : v]));

/** The Copyleaks status webhook. Returns the HTTP status: 404 when off, malformed or not authentic; 200 otherwise (also when unknown). */
async function onCopyleaksStatus(status, scanId, headers, body, ctx) {
  const env = envOf(ctx);
  if (!copyleaksReady(env) || !STATUS_EVENTS.includes(status) || !SCAN_ID.test(String(scanId))) return 404;
  const copyleaks = providerByName('copyleaks');
  if (!copyleaks.verifyWebhook(lowerHeaders(headers), body, scanId, env, { status: true })) return 404;
  const report = await loadSubmitted(scanId);
  if (!report) return 200;
  const { settings } = readSettings(env);
  await applyOutcome(report, await copyleaks.onStatus(status, body, report.providerPending, scanId, { env, settings, fetch: ctx.fetch }), ctx);
  return 200;
}

/** The Copyleaks export uploads (results/:resultId, crawled) and the export-completed webhook. Same answers as onCopyleaksStatus. */
async function onCopyleaksExport(kind, scanId, resultId, headers, body, ctx) {
  const env = envOf(ctx);
  if (!copyleaksReady(env) || !EXPORT_KINDS.includes(kind) || !SCAN_ID.test(String(scanId))) return 404;
  if (kind === 'results' && !RESULT_ID.test(String(resultId))) return 404;
  const copyleaks = providerByName('copyleaks');
  if (!copyleaks.verifyWebhook(lowerHeaders(headers), body, scanId, env, { status: false })) return 404;
  const report = await loadSubmitted(scanId);
  if (!report) return 200;
  const { settings } = readSettings(env);
  if (kind === 'completed') {
    await applyOutcome(report, await copyleaks.onExportCompleted(body, report.providerPending, scanId, { env, settings, fetch: ctx.fetch }), ctx);
    return 200;
  }
  const next = copyleaks.onExportUpload(kind, resultId, body, report.providerPending);
  const filter = { ...submittedFilter(scanId), 'providerPending.stage': 'exporting' };
  // one path per upload ($set of that key only): uploads arrive concurrently
  if (kind === 'crawled' && typeof next?.crawledText === 'string') await SimilarityReport.updateOne(filter, { $set: { 'providerPending.crawledText': next.crawledText } });
  if (kind === 'results' && next?.results?.[resultId]) await SimilarityReport.updateOne(filter, { $set: { [`providerPending.results.${resultId}`]: next.results[resultId] } });
  return 200;
}

/** Submitted checks: poll a provider that polls; past the deadline ask for the webhook once, then mark the check expired. */
async function sweep(ctx = {}) {
  const env = envOf(ctx);
  if (!similarityEnabled(env)) return 0;
  const at = now(ctx);
  const { settings } = readSettings(env);
  const reports = await SimilarityReport.find({ inQueue: true, status: 'submitted' }).select('+providerPending +providerAudit +job.externalRef').limit(20).lean();
  for (const report of reports) {
    const provider = providerByName(report.providerAudit?.provider);
    const pctx = { env, settings, fetch: ctx.fetch };
    try {
      if (provider?.poll) {
        const outcome = await provider.poll(report.job.externalRef, report.providerPending, pctx);
        if (outcome.state !== 'waiting') { await applyOutcome(report, outcome, ctx); continue; }
      }
      if (!report.job.deadlineAt || report.job.deadlineAt > at) continue;
      if (provider?.resend && !report.job.resentAt) {
        await provider.resend(report.job.externalRef, pctx);
        await SimilarityReport.updateOne(submittedFilter(report.job.externalRef), { $set: { 'job.resentAt': at,
          'job.deadlineAt': new Date(at.getTime() + settings.providerDeadlineMinutes * 60 * 1000) } });
        continue;
      }
      await SimilarityReport.updateOne(submittedFilter(report.job.externalRef), { $set: { status: 'expired', external: { state: 'expired' }, completedAt: at },
        $unset: { inQueue: 1, nextAttemptAt: 1, providerPending: 1 }, $inc: { revision: 1 } });
    } catch (error) {
      logger.warn?.({ event: 'similarity.sweep.failed', reason: error instanceof ProviderError ? error.code : error?.name || 'Error' });
    }
  }
  return reports.length;
}

module.exports = { requestCheck, retryCheck, checksLeftToday, runQueued, sweep, onCopyleaksStatus, onCopyleaksExport, ACTIVE, MAX_ATTEMPTS,
  _private: { numberSources, identityOf, claimNext } };
