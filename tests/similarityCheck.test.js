'use strict';
// The similarity check job (services/similarity/check.service.js): who may ask, caps reserved atomically, idempotency, the job states for a
// synchronous provider (Copyscape), an asynchronous one completed by webhooks (Copyleaks, hand-written payloads, not verified live) or by
// polling (the async stub), retries, the sweeper (resend once, then expired), leases, and exclusions kept across a new check.
// Every provider request goes to a fake fetch. Synthetic generated words only.
process.env.JWT_SECRET = 'similarity-check-secret';
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const SimilarityReport = require('../src/models/SimilarityReport');
const SimilarityUsage = require('../src/models/SimilarityUsage');
const SimilarityFingerprint = require('../src/models/SimilarityFingerprint');
const Submission = require('../src/models/Submission');
const check = require('../src/services/similarity/check.service');
const internal = require('../src/services/similarity/internal.service');
const copyleaks = require('../src/services/similarity/providers/copyleaks');
const { NOTICE_VERSION } = require('../src/services/similarity/policy');
const { words, classWithEssay, student, essay } = require('./helpers/similarityFixtures');
const F = require('./helpers/similarityProviderFixtures');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => { await clearDatabase(); copyleaks._resetTokenCache(); });

const BASE_ENV = Object.freeze({ SIMILARITY_ENABLED: 'true' });
const SECRET = 'w'.repeat(40);
const CL_ENV = Object.freeze({ ...BASE_ENV, SIMILARITY_PROVIDER: 'copyleaks', COPYLEAKS_EMAIL: 'api@example.test', COPYLEAKS_API_KEY: 'k-123',
  SIMILARITY_WEBHOOK_BASE_URL: 'https://api.example.test', SIMILARITY_WEBHOOK_SECRET: SECRET, SIMILARITY_COPYLEAKS_USD_PER_CREDIT: '0.05' });
const CS_ENV = Object.freeze({ ...BASE_ENV, SIMILARITY_PROVIDER: 'copyscape', COPYSCAPE_USERNAME: 'u', COPYSCAPE_API_KEY: 'k' });
let clock;
const ctxFor = (env, fetch = F.fakeFetch([])) => ({ env, fetch, now: () => clock });
const SHARED = words('s', 20);

async function scene({ notice = true } = {}) {
  clock = new Date('2026-11-27T10:00:00Z');
  const a = await classWithEssay({ label: 'a' });
  const b = await classWithEssay({ label: 'b' });
  const sa = await student(a.klass, 'sa');
  const sb = await student(b.klass, 'sb');
  const mine = await essay({ ...a, studentUser: sa.user, text: `${words('a', 30)} ${SHARED} ${words('a', 30, 30)}`,
    extra: notice ? { similarityNotice: { version: NOTICE_VERSION, acceptedAt: clock } } : {} });
  const theirs = await essay({ ...b, studentUser: sb.user, text: `${words('b', 10)} ${SHARED}` });
  await internal.indexSubmission(theirs._id);
  return { a, b, mine, theirs, teacherId: a.teacher.user._id };
}
const ask = (s, ctx, over = {}) => check.requestCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: over.requestId || `req-${Math.random()}`, ...over }, ctx);
const full = id => SimilarityReport.findOne({ submissionId: id }).select('+providerAudit +providerPending +job.externalRef +job.attemptKey').lean();

describe('requestCheck', () => {
  test('owner only (404 for another teacher, an unknown id, a speaking submission, or while the feature is off)', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    expect(await check.requestCheck({ userId: s.b.teacher.user._id, submissionId: s.mine._id, requestId: 'r1' }, ctx)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await check.requestCheck({ userId: s.teacherId, submissionId: new mongoose.Types.ObjectId(), requestId: 'r1' }, ctx)).toMatchObject({ code: 'not_found' });
    expect(await check.requestCheck({ userId: s.teacherId, submissionId: 'nope', requestId: 'r1' }, ctx)).toMatchObject({ code: 'not_found' });
    await Submission.updateOne({ _id: s.mine._id }, { $set: { sourceKind: 'audio' } });
    expect(await ask(s, ctx)).toMatchObject({ code: 'not_found' });
    await Submission.updateOne({ _id: s.mine._id }, { $unset: { sourceKind: 1 } });
    expect(await ask(s, ctxFor({}))).toMatchObject({ code: 'not_found' });
    expect(await SimilarityReport.countDocuments()).toBe(0);
    expect(await SimilarityUsage.countDocuments()).toBe(0);
  });
  test('an essay over the word limit or without text is refused with a reason, and uses no check', async () => {
    const s = await scene();
    expect(await ask(s, ctxFor({ ...BASE_ENV, SIMILARITY_MAX_WORDS: '50' }))).toMatchObject({ ok: false, code: 'not_eligible', reason: 'too_long' });
    await Submission.updateOne({ _id: s.mine._id }, { $set: { 'ocrPages.0.text': '', 'ocrPages.0.words': [] } });
    expect(await ask(s, ctxFor(BASE_ENV))).toMatchObject({ ok: false, code: 'not_eligible', reason: 'no_text' });
    expect(await SimilarityUsage.countDocuments()).toBe(0);
  });
  test('queues one check; the same request id again returns the same check without using another', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    const first = await ask(s, ctx, { requestId: 'same' });
    expect(first).toMatchObject({ ok: true });
    expect(first.report).toMatchObject({ status: 'queued', inQueue: true });
    expect(await ask(s, ctx, { requestId: 'same' })).toMatchObject({ ok: true });
    const doc = await full(s.mine._id);
    expect(doc.checks).toHaveLength(1);
    expect((await SimilarityUsage.findOne({ scope: `teacher:${s.teacherId}` }).lean()).checks).toBe(1);
  });
  test('a second request while one runs is refused (in progress) and uses nothing', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx);
    expect(await ask(s, ctx)).toMatchObject({ ok: false, code: 'in_progress' });
    expect((await SimilarityUsage.findOne({ scope: `teacher:${s.teacherId}` }).lean()).checks).toBe(1);
  });
  test('the per-submission cap', async () => {
    const s = await scene();
    const ctx = ctxFor({ ...BASE_ENV, SIMILARITY_CHECKS_PER_SUBMISSION: '2' });
    for (let i = 0; i < 2; i++) { expect((await ask(s, ctx)).ok).toBe(true); await check.runQueued(ctx); }
    expect(await ask(s, ctx)).toMatchObject({ ok: false, code: 'submission_cap' });
  });
  test('the daily cap per teacher holds under concurrent requests, and resets the next UTC day', async () => {
    const s = await scene();
    const subs = [];
    for (let i = 0; i < 5; i++) {
      const st = await student(s.a.klass, `c${i}`);
      subs.push(await essay({ ...s.a, studentUser: st.user, text: words(`c${i}`, 30) }));
    }
    const ctx = ctxFor({ ...BASE_ENV, SIMILARITY_DAILY_CHECKS_PER_TEACHER: '2' });
    const out = await Promise.all(subs.map(sub => check.requestCheck({ userId: s.teacherId, submissionId: sub._id, requestId: `r-${sub._id}` }, ctx)));
    expect(out.filter(o => o.ok)).toHaveLength(2);
    expect(out.filter(o => o.code === 'daily_cap')).toHaveLength(3);
    expect(await SimilarityReport.countDocuments()).toBe(2);
    clock = new Date('2026-11-28T00:00:01Z');
    expect((await check.requestCheck({ userId: s.teacherId, submissionId: subs.find((_, i) => !out[i].ok)._id, requestId: 'next-day' }, ctx)).ok).toBe(true);
  });
  test('checksLeft for the panel', async () => {
    const s = await scene();
    const ctx = ctxFor({ ...BASE_ENV, SIMILARITY_DAILY_CHECKS_PER_TEACHER: '4' });
    expect(await check.checksLeftToday(s.teacherId, ctx)).toBe(4);
    await ask(s, ctx);
    expect(await check.checksLeftToday(s.teacherId, ctx)).toBe(3);
  });
});

describe('the job: internal only, and a synchronous provider', () => {
  test('provider none: completes with the internal source, marks the external check not configured, indexes this essay', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx);
    expect(await check.runQueued(ctx)).toBe(1);
    const doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'completed', external: { state: 'not_configured' }, settings: { excludeQuotes: true, minMatchWords: 8, internalScope: 'all' } });
    expect(doc.inQueue).toBeUndefined();
    expect(doc.text).toMatchObject({ words: 80, origin: 'ocr' });
    expect(doc.text.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0]).toMatchObject({ sourceId: 's1', kind: 'internal', label: 'Another submission in Rubrilo', refSubmissionId: s.theirs._id, excluded: false });
    expect(doc.sources[0].spans.map(x => [x.wordStart, x.wordEnd])).toEqual([[30, 50]]);
    expect(await SimilarityFingerprint.countDocuments({ submissionId: s.mine._id })).toBe(1);
    expect(doc.revision).toBeGreaterThan(0);
  });
  test('Copyscape: one request, the located web source plus the internal one; audit kept apart; actual cost booked', async () => {
    const s = await scene();
    const fetch = F.fakeFetch([{ match: url => url === 'https://www.copyscape.com/api/', reply: { body: F.copyscapeSearch(words('a', 12)) } }]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    const doc = await full(s.mine._id);
    expect(fetch.calls).toHaveLength(1);
    expect(doc.status).toBe('completed');
    expect(doc.external).toMatchObject({ state: 'completed' });
    expect(doc.sources.map(x => [x.sourceId, x.kind, x.compared])).toEqual([['s1', 'web', true], ['s2', 'web', false], ['s3', 'internal', true]]);
    expect(doc.sources[0].spans.map(x => [x.wordStart, x.wordEnd])).toEqual([[0, 12]]);
    expect(doc.providerAudit).toMatchObject({ provider: 'copyscape', costUsd: 0.04, resultCount: 2, queryWords: 240 });
    expect((await SimilarityUsage.findOne({ scope: 'global' }).lean()).spendUsd).toBeCloseTo(0.04);
    const plain = await SimilarityReport.findOne({ submissionId: s.mine._id }).lean();
    expect(plain.providerAudit).toBeUndefined();
  });
  test('no notice on the essay: the external provider is never called (internal only)', async () => {
    const s = await scene({ notice: false });
    const fetch = F.fakeFetch([]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect(fetch.calls).toEqual([]);
    expect((await full(s.mine._id)).external).toMatchObject({ state: 'not_permitted' });
  });
  test('a teacher upload without the notice: external only when the teacher confirms permission', async () => {
    const s = await scene({ notice: false });
    await Submission.collection.updateOne({ _id: s.mine._id }, { $set: { teacherUpload: { uploadedBy: s.teacherId, batchId: 'b', uploadedAt: clock } } });
    const fetch = F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch(words('a', 12)) } }]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect((await full(s.mine._id)).external.state).toBe('not_permitted');
    await ask(s, ctx, { confirmPermission: true });
    await check.runQueued(ctx);
    expect((await full(s.mine._id)).external.state).toBe('completed');
    expect(fetch.calls).toHaveLength(1);
  });
  test('an essay submitted before the notice: external only after the teacher confirms; the check records who confirmed and when', async () => {
    const s = await scene({ notice: false });
    const fetch = F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch(words('a', 12)) } }]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    let doc = await full(s.mine._id);
    expect(doc.external.state).toBe('not_permitted');
    expect(doc.checks[0]).toMatchObject({ permitted: false, permission: 'none' });
    expect(doc.checks[0].permissionConfirmedBy).toBeUndefined();
    clock = new Date('2026-11-27T11:30:00Z');
    await ask(s, ctx, { confirmPermission: true });
    await check.runQueued(ctx);
    doc = await full(s.mine._id);
    expect(doc.external.state).toBe('completed');
    expect(fetch.calls).toHaveLength(1);
    expect(doc.checks[1]).toMatchObject({ permitted: true, permission: 'teacher_confirmed' });
    expect(String(doc.checks[1].permissionConfirmedBy)).toBe(String(s.teacherId));
    expect(doc.checks[1].permissionConfirmedAt).toEqual(clock);
  });
  test('an essay with the notice records the notice as the permission, never a teacher confirmation', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx, { confirmPermission: true });
    const doc = await full(s.mine._id);
    expect(doc.checks[0]).toMatchObject({ permitted: true, permission: 'notice' });
    expect(doc.checks[0].permissionConfirmedBy).toBeUndefined();
    expect(doc.checks[0].permissionConfirmedAt).toBeUndefined();
  });
  test('the daily spend stop: the external check is skipped, nothing is sent', async () => {
    const s = await scene();
    const fetch = F.fakeFetch([]);
    const ctx = ctxFor({ ...CS_ENV, SIMILARITY_DAILY_SPEND_USD: '0.01' }, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect(fetch.calls).toEqual([]);
    expect((await full(s.mine._id)).external).toMatchObject({ state: 'skipped', reason: 'daily_spend_reached' });
  });
  test('provider set but not configured: internal result, external not configured, nothing sent', async () => {
    const s = await scene();
    const fetch = F.fakeFetch([]);
    const ctx = ctxFor({ ...BASE_ENV, SIMILARITY_PROVIDER: 'copyscape' }, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect(fetch.calls).toEqual([]);
    expect((await full(s.mine._id)).external.state).toBe('not_configured');
  });
  test('a provider error that will not succeed on retry: completed with the internal result, external failed, the spend given back', async () => {
    const s = await scene();
    const ctx = ctxFor(CS_ENV, F.fakeFetch([{ match: () => true, reply: { body: { error: 'Username or API key not valid' } } }]));
    await ask(s, ctx);
    await check.runQueued(ctx);
    const doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'completed', external: { state: 'failed', reason: 'auth' } });
    expect(doc.sources.map(x => x.kind)).toEqual(['internal']);
    expect((await SimilarityUsage.findOne({ scope: 'global' }).lean())?.spendUsd || 0).toBe(0);
  });
  test('a retryable error: queued again with a backoff, up to 3 attempts, then external failed', async () => {
    const s = await scene();
    const fetch = F.fakeFetch([{ match: () => true, reply: { status: 503, body: {} } }]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    let doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'queued', inQueue: true, job: { attempts: 1 } });
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThan(clock.getTime());
    expect(await check.runQueued(ctx)).toBe(0);                 // not before its time
    for (let i = 0; i < 2; i++) { clock = new Date(clock.getTime() + 60 * 60e3); await check.runQueued(ctx); }
    doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'completed', external: { state: 'failed', reason: 'http_503' } });
    expect(fetch.calls).toHaveLength(3);
  });
  test('the essay was deleted before the job ran: failed, and the daily check is given back', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx);
    await Submission.deleteOne({ _id: s.mine._id });
    await check.runQueued(ctx);
    expect(await full(s.mine._id)).toMatchObject({ status: 'failed', errorCode: 'submission_unavailable' });
    expect((await SimilarityUsage.findOne({ scope: `teacher:${s.teacherId}` }).lean()).checks).toBe(0);
  });
  test('a crashed run (lease expired) is taken over; a live lease is not', async () => {
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx);
    await SimilarityReport.updateOne({ submissionId: s.mine._id }, { $set: { status: 'running', 'job.leaseUntil': new Date(clock.getTime() + 60e3) } });
    expect(await check.runQueued(ctx)).toBe(0);
    clock = new Date(clock.getTime() + 10 * 60e3);
    expect(await check.runQueued(ctx)).toBe(1);
    expect((await full(s.mine._id)).status).toBe('completed');
  });
  test('a new check keeps the teacher\'s exclusions for the same sources', async () => {
    const s = await scene();
    const fetch = F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch(words('a', 12)) } }]);
    const ctx = ctxFor(CS_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    await SimilarityReport.updateOne({ submissionId: s.mine._id }, { $set: { 'sources.0.excluded': true, 'sources.2.excluded': true } });
    await ask(s, ctx);
    await check.runQueued(ctx);
    const doc = await full(s.mine._id);
    expect(doc.sources.map(x => [x.kind, x.compared, x.excluded])).toEqual([['web', true, true], ['web', false, false], ['internal', true, true]]);
  });
});

describe('the job: an asynchronous provider', () => {
  const SCAN_RE = /^rb[a-f0-9]{24}$/;
  const clFetch = () => F.fakeFetch([
    { match: url => url.endsWith('/v3/account/login/api'), reply: { body: { access_token: 't', '.expires': new Date(Date.now() + 48 * 3600e3).toISOString() } } },
    { match: url => url.includes('/scans/submit/file/'), reply: { status: 201, body: '' } },
    { match: url => url.includes('/v3/downloads/'), reply: { status: 202, body: {} } },
    { match: url => url.endsWith('/webhooks/resend'), reply: { status: 202, body: {} } },
    { match: url => url.endsWith('/v3.1/scans/delete'), reply: { status: 202, body: {} } }]);
  const headers = { 'x-similarity-webhook-secret': SECRET };

  test('Copyleaks: submitted with the internal result first, then completed by webhooks; duplicates and forgeries change nothing', async () => {
    const s = await scene();
    const fetch = clFetch();
    const ctx = ctxFor(CL_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    let doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'submitted', inQueue: true, external: { state: 'submitted' } });
    expect(doc.job.externalRef).toMatch(SCAN_RE);
    expect(doc.job.deadlineAt.getTime()).toBe(clock.getTime() + 60 * 60e3);
    expect(doc.sources.map(x => x.kind)).toEqual(['internal']);
    const scan = doc.job.externalRef;
    const text = (await internal.loadEssay(s.mine._id)).text;
    const completed = { ...F.copyleaksCompleted(scan), developerPayload: copyleaks.payloadFor(scan, CL_ENV) };
    expect(await check.onCopyleaksStatus('completed', scan, { 'x-similarity-webhook-secret': 'x'.repeat(40) }, completed, ctx)).toBe(404);
    expect(await check.onCopyleaksStatus('completed', scan, headers, { ...completed, developerPayload: 'forged' }, ctx)).toBe(404);
    expect(await check.onCopyleaksStatus('completed', scan, headers, completed, ctx)).toBe(200);
    expect(await check.onCopyleaksStatus('completed', scan, headers, completed, ctx)).toBe(200);   // duplicate: ignored
    expect(fetch.calls.filter(c => c.url.includes('/v3/downloads/'))).toHaveLength(1);
    const start = text.indexOf('qa0');
    expect(await check.onCopyleaksExport('results', scan, 'r-web-1', headers, F.copyleaksResult({ starts: [start], lengths: [text.indexOf('qa11') + 4 - start] }), ctx)).toBe(200);
    expect(await check.onCopyleaksExport('crawled', scan, null, headers, F.copyleaksCrawled(text), ctx)).toBe(200);
    expect(await check.onCopyleaksExport('completed', scan, null, {}, F.copyleaksExportCompleted(true), ctx)).toBe(404);
    expect(await check.onCopyleaksExport('completed', scan, null, headers, F.copyleaksExportCompleted(true), ctx)).toBe(200);
    doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'completed', external: { state: 'completed' } });
    expect(doc.inQueue).toBeUndefined();
    expect(doc.providerPending).toBeUndefined();
    expect(doc.sources.map(x => [x.kind, x.compared])).toEqual([['web', true], ['repository', false], ['repository', false], ['internal', true]]);
    expect(doc.sources[0].spans.map(x => [x.wordStart, x.wordEnd])).toEqual([[0, 12]]);
    expect(doc.providerAudit).toMatchObject({ provider: 'copyleaks', externalRef: scan, units: 1, costUsd: 0.05 });
    // late events after completion are acknowledged and ignored
    expect(await check.onCopyleaksExport('crawled', scan, null, headers, F.copyleaksCrawled('x'), ctx)).toBe(200);
    expect((await full(s.mine._id)).status).toBe('completed');
  });
  const WELL = 'rb0123456789abcdef01234567';
  const signed = { developerPayload: copyleaks.payloadFor(WELL, CL_ENV) };
  test('webhooks are 404 while the feature is off, the provider is another, the webhook is not configured, or the event/scan/result is malformed', async () => {
    const ctx = env => ctxFor(env);
    expect(await check.onCopyleaksStatus('completed', WELL, headers, signed, ctx(CL_ENV))).toBe(200);   // the control: everything right
    expect(await check.onCopyleaksStatus('completed', WELL, headers, signed, ctx({ ...CL_ENV, SIMILARITY_ENABLED: 'false' }))).toBe(404);
    expect(await check.onCopyleaksStatus('completed', WELL, headers, signed, ctx({ ...CL_ENV, SIMILARITY_PROVIDER: 'copyscape' }))).toBe(404);
    expect(await check.onCopyleaksStatus('completed', WELL, headers, signed, ctx({ ...CL_ENV, SIMILARITY_WEBHOOK_SECRET: '' }))).toBe(404);
    expect(await check.onCopyleaksStatus('completed', '../x', headers, signed, ctx(CL_ENV))).toBe(404);
    expect(await check.onCopyleaksStatus('bogus', WELL, headers, signed, ctx(CL_ENV))).toBe(404);
    expect(await check.onCopyleaksExport('crawled', WELL, null, headers, {}, ctx(CL_ENV))).toBe(200);    // the control
    expect(await check.onCopyleaksExport('crawled', WELL, null, headers, {}, ctx({ ...CL_ENV, SIMILARITY_ENABLED: 'false' }))).toBe(404);
    expect(await check.onCopyleaksExport('other', WELL, null, headers, {}, ctx(CL_ENV))).toBe(404);
    expect(await check.onCopyleaksExport('results', WELL, '../../x', headers, {}, ctx(CL_ENV))).toBe(404);
    expect(await check.onCopyleaksExport('crawled', WELL, null, {}, {}, ctx(CL_ENV))).toBe(404);
  });
  test('an unknown but well-formed, signed scan is acknowledged (200) so the provider stops retrying, and nothing changes', async () => {
    expect(await check.onCopyleaksStatus('completed', WELL, headers, signed, ctxFor(CL_ENV))).toBe(200);
    expect(await SimilarityReport.countDocuments()).toBe(0);
  });
  test('an error event: completed with the internal result, external failed, the spend given back', async () => {
    const s = await scene();
    const ctx = ctxFor(CL_ENV, clFetch());
    await ask(s, ctx);
    await check.runQueued(ctx);
    const scan = (await full(s.mine._id)).job.externalRef;
    expect((await SimilarityUsage.findOne({ scope: 'global' }).lean()).spendUsd).toBeCloseTo(0.05);
    expect(await check.onCopyleaksStatus('error', scan, headers, { ...F.copyleaksError(), developerPayload: copyleaks.payloadFor(scan, CL_ENV) }, ctx)).toBe(200);
    const doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'completed', external: { state: 'failed', reason: 'insufficient_credits' } });
    expect((await SimilarityUsage.findOne({ scope: 'global' }).lean()).spendUsd).toBe(0);
  });
  test('the sweeper: past the deadline it asks for the webhook again once, then marks the check expired (internal result kept)', async () => {
    const s = await scene();
    const fetch = clFetch();
    const ctx = ctxFor(CL_ENV, fetch);
    await ask(s, ctx);
    await check.runQueued(ctx);
    await check.sweep(ctx);
    expect(fetch.calls.filter(c => c.url.endsWith('/webhooks/resend'))).toHaveLength(0);
    clock = new Date(clock.getTime() + 61 * 60e3);
    await check.sweep(ctx);
    expect(fetch.calls.filter(c => c.url.endsWith('/webhooks/resend'))).toHaveLength(1);
    expect((await full(s.mine._id)).status).toBe('submitted');
    clock = new Date(clock.getTime() + 61 * 60e3);
    await check.sweep(ctx);
    const doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'expired', external: { state: 'expired' } });
    expect(doc.inQueue).toBeUndefined();
    expect(doc.sources.map(x => x.kind)).toEqual(['internal']);
  });
  test('an asynchronous provider without webhooks is completed by polling (the async stub)', async () => {
    const s = await scene();
    const ctx = ctxFor({ ...BASE_ENV, SIMILARITY_PROVIDER: 'stub', SIMILARITY_STUB_MODE: 'async' });
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect((await full(s.mine._id)).status).toBe('submitted');
    await check.sweep(ctx);
    const doc = await full(s.mine._id);
    expect(doc.status).toBe('completed');
    expect(doc.sources.map(x => x.kind)).toEqual(['web', 'internal']);
  });
});

describe('retryCheck', () => {
  test('after the external check failed or expired: queued again without using a check; refused otherwise', async () => {
    const s = await scene();
    const ctx = ctxFor(CS_ENV, F.fakeFetch([{ match: () => true, reply: { body: { error: 'Username or API key not valid' } } }]));
    expect(await check.retryCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: 'x' }, ctx)).toMatchObject({ code: 'not_retryable' });
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect(await check.retryCheck({ userId: s.b.teacher.user._id, submissionId: s.mine._id, requestId: 'x' }, ctx)).toMatchObject({ code: 'not_found' });
    const out = await check.retryCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: 'retry-1' }, ctx);
    expect(out.ok).toBe(true);
    const doc = await full(s.mine._id);
    expect(doc).toMatchObject({ status: 'queued', external: { state: 'pending' } });
    expect(doc.checks).toHaveLength(1);
    expect((await SimilarityUsage.findOne({ scope: `teacher:${s.teacherId}` }).lean()).checks).toBe(1);
    expect(await check.retryCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: 'retry-2' }, ctx)).toMatchObject({ code: 'not_retryable' });
    await check.runQueued(ctx);                                  // the retry fails again: no second retry for this check
    expect((await full(s.mine._id)).external.state).toBe('failed');
    expect(await check.retryCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: 'retry-3' }, ctx)).toMatchObject({ code: 'not_retryable' });
  });
  test('nothing to retry when the external check completed', async () => {
    const s = await scene();
    const ctx = ctxFor(CS_ENV, F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch(words('a', 12)) } }]));
    await ask(s, ctx);
    await check.runQueued(ctx);
    expect(await check.retryCheck({ userId: s.teacherId, submissionId: s.mine._id, requestId: 'r' }, ctx)).toMatchObject({ code: 'not_retryable' });
  });
});

describe('the worker', () => {
  const worker = require('../src/services/similarity/worker');
  test('does not start while the feature is off; when on, its first tick runs the queued check', async () => {
    expect(worker.startSimilarityWorkerIfEnabled({})).toBeNull();
    const s = await scene();
    const ctx = ctxFor(BASE_ENV);
    await ask(s, ctx);
    const w = worker.startSimilarityWorkerIfEnabled(BASE_ENV, { intervalMs: 60000, ctx: { now: () => clock } });
    try {
      await w.idle();
      expect((await full(s.mine._id)).status).toBe('completed');
    } finally { w.stop(); }
  });
  test('server.js starts it and stops it with the other background workers', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/server.js'), 'utf8');
    expect(source).toMatch(/similarityWorker = require\('\.\/services\/similarity\/worker'\)\.startSimilarityWorkerIfEnabled\(\)/);
    expect(source).toMatch(/similarityWorker\?\.stop\(\)/);
  });
});
