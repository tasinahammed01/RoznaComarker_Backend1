'use strict';
// Handwriting spacing and capitals check, stage service. Offline: synthetic images and text, injected file loader, mocked provider
// replies (or the real gateway with a mocked fetch). No network, no database, no .env.
const crypto = require('crypto');
const sharp = require('sharp');
const stage = require('../src/services/handwritingMechanics/stage.service');
const engine = require('../src/services/handwritingMechanics/engine');
const profile = require('../src/services/handwritingMechanics/profile');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ON = { NODE_ENV: 'test', HANDWRITING_MECHANICS_CHECK_ENABLED: 'true', OPENROUTER_API_KEY: 'mock-only' };
const exactDoc = extra => ({ _id: 'sub-1', sourceFidelityMode: 'gpt_vision_exact', ...extra });
const LINES = ['Kids these days , they win.', 'We have .We know it.'];
const W = 1000, H = 400;
let IMAGE;
beforeAll(async () => { IMAGE = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).jpeg().toBuffer(); });

/** Stored words (split on whitespace, like alignGeometry) with percent boxes: one row per line. */
function words(text) {
  const out = []; let line = 0, col = 0, lineStart = 0;
  for (const m of text.matchAll(/\S+/gu)) {
    const breaks = (text.slice(lineStart, m.index).match(/\n/gu) || []).length;
    if (breaks) { line += breaks; col = 0; lineStart = text.lastIndexOf('\n', m.index) + 1; }
    out.push({ text: m[0], sourceStart: m.index, sourceEnd: m.index + m[0].length, bbox: { x: 5 + 12 * col, y: 10 + 30 * line, w: 10, h: 10 } });
    col += 1;
  }
  return out;
}
function essay({ pages = [LINES.join('\n')], storedPage = {}, fileDocs } = {}) {
  let start = 0; const canonicalPages = [], ocrPages = [];
  pages.forEach((text, i) => {
    if (i) start += '\n\n\f\n\n'.length;
    canonicalPages.push({ fileId: `file-${i + 1}`, pageNumber: 1, text, startChar: start });
    ocrPages.push({ fileId: `file-${i + 1}`, pageNumber: 1, pageIndex: 0, fileOrder: i, width: W, height: H, coordinateSpace: 'display-image',
      ocrInputSha256: sha(IMAGE), words: words(text), ...storedPage });
    start += text.length;
  });
  const transcript = pages.join('\n\n\f\n\n');
  const files = fileDocs || Object.fromEntries(pages.map((_, i) => [`file-${i + 1}`, { _id: `file-${i + 1}`, path: `uploads/submissions/file-${i + 1}.jpg` }]));
  return { doc: exactDoc({ ocrPages }), transcript, pages: canonicalPages, transcriptComplete: true,
    deps: { loadFile: jest.fn(async id => files[id] || null), readFile: jest.fn(async () => IMAGE) } };
}
/** Mock provider: reads the numbered words/marks from the user message and answers "normal", unless told otherwise per word. */
function provider({ spaceBefore = [], tightAfter = [], capital = [], delayMs = 0, fail = null, cost = 0.001, onCall } = {}) {
  return jest.fn(async options => {
    onCall?.(options);
    const text = options.messages[1].content[0].text;
    const list = label => { const line = text.split('\n').find(l => l.startsWith(label)); return !line || line.endsWith('(none)') ? [] : line.slice(label.length).split(' | '); };
    const wordsSeen = list('Words: ').map(w => w.replace(/^\d+\. /u, '').replace(/ \(line \d+\)$/u, ''));
    const marksSeen = list('Punctuation marks: ').map(m => m.match(/after "(.*)"/u)[1]);
    if (delayMs) await new Promise((resolve, reject) => { const t = setTimeout(resolve, delayMs);
      options.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { code: 'AI_ATTEMPT_TIMEOUT' })); }, { once: true }); });
    if (fail) throw fail;
    const reply = { marks: marksSeen.map(before => ({ space_before: spaceBefore.includes(before), space_after: !tightAfter.includes(before), confidence: 0.95 })),
      cases: wordsSeen.map(w => ({ case_as_written: /^\p{Lu}/u.test(w) || capital.includes(w) ? 'capital' : 'small', is_proper_noun: 'false', confidence: 0.95 })) };
    return { content: JSON.stringify(reply), returnedModel: profile.MODEL, usage: { prompt_tokens: 1000, completion_tokens: 50, cost } };
  });
}
const run = async (e, providerAttempt, env = ON, settle = { correctionSucceeded: true, waitMs: 5000 }) => {
  const logs = [];
  const handle = stage.start({ doc: e.doc, transcript: e.transcript, pages: e.pages, transcriptComplete: e.transcriptComplete, env,
    deps: { ...e.deps, providerAttempt, logger: { info: x => logs.push(x), warn: x => logs.push(x) } } });
  const result = await handle.settle(settle);
  return { result, logs };
};

describe('settings, gate and hash identity', () => {
  test('defaults: off, 1 line per crop, floor 0.80, concurrency 8, wait 12 s; invalid values fall back and are reported', () => {
    expect(stage.settings({})).toMatchObject({ enabled: false, concurrency: 8, callTimeoutMs: 20000, stageBudgetMs: 30000,
      waitAfterCorrectionMs: 12000, maxLines: 150, linesPerCrop: 1, minConfidence: 0.8, invalid: [] });
    expect(stage.settings({ HANDWRITING_MECHANICS_CHECK_ENABLED: 'yes' }).enabled).toBe(false);
    const bad = stage.settings({ ...ON, HANDWRITING_MECHANICS_CONCURRENCY: 'many', HANDWRITING_MECHANICS_MIN_CONFIDENCE: '1.5', HANDWRITING_MECHANICS_LINES_PER_CROP: '0' });
    expect(bad).toMatchObject({ enabled: true, concurrency: 8, minConfidence: 0.8, linesPerCrop: 1 });
    expect(stage.settings({ HANDWRITING_MECHANICS_CONCURRENCY: '4', HANDWRITING_MECHANICS_WAIT_AFTER_CORRECTION_MS: '8000' }))
      .toMatchObject({ concurrency: 4, waitAfterCorrectionMs: 8000 });
    expect(bad.invalid.sort()).toEqual(['HANDWRITING_MECHANICS_CONCURRENCY', 'HANDWRITING_MECHANICS_LINES_PER_CROP', 'HANDWRITING_MECHANICS_MIN_CONFIDENCE']);
    expect(stage.settings({ ...ON, HANDWRITING_MECHANICS_LINES_PER_CROP: '3', HANDWRITING_MECHANICS_MIN_CONFIDENCE: '0.85' })).toMatchObject({ linesPerCrop: 3, minConfidence: 0.85 });
  });
  test('applies only when the flag is on and the essay is exact-source', () => {
    expect(stage.applies(exactDoc(), {})).toBe(false);
    expect(stage.applies({ _id: 't' }, ON)).toBe(false);
    expect(stage.applies(exactDoc(), ON)).toBe(true);
  });
  test('hash identity: null when off or typed; the result-changing settings when on and exact-source', () => {
    expect(stage.hashIdentity(exactDoc(), {})).toBeNull();
    expect(stage.hashIdentity({ _id: 't' }, ON)).toBeNull();
    expect(stage.hashIdentity(exactDoc(), ON)).toEqual({ version: engine.VERSION, prompt: engine.PROMPT_VERSION, schema: engine.SCHEMA_VERSION,
      model: profile.MODEL, minConfidence: 0.8, linesPerCrop: 1 });
    expect(stage.hashIdentity(exactDoc(), { ...ON, HANDWRITING_MECHANICS_CONCURRENCY: '9' })).toEqual(stage.hashIdentity(exactDoc(), ON));
  });
});

describe('running the check', () => {
  test('flag off: no file read, no call, no log, status disabled', async () => {
    const e = essay(), call = provider();
    const { result, logs } = await run(e, call, { NODE_ENV: 'test' });
    expect(result).toEqual({ status: 'disabled', findings: [], summary: null });
    expect(call).not.toHaveBeenCalled(); expect(e.deps.readFile).not.toHaveBeenCalled(); expect(logs).toEqual([]);
  });

  test('flag on but a typed (not exact-source) essay: no file read, no call, status disabled', async () => {
    const e = essay(), call = provider();
    e.doc = { ...e.doc, sourceFidelityMode: undefined };
    const { result, logs } = await run(e, call);
    expect(result).toEqual({ status: 'disabled', findings: [], summary: null });
    expect(call).not.toHaveBeenCalled(); expect(e.deps.readFile).not.toHaveBeenCalled(); expect(logs).toEqual([]);
  });

  test('one line per crop: real pixel crops, grounded findings, cost and counts, and a log event without any text', async () => {
    const e = essay(), crops = [];
    const call = provider({ spaceBefore: ['days', 'have'], tightAfter: ['have'], onCall: o => crops.push(o) });
    const { result, logs } = await run(e, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(crops[0]).toMatchObject({ requestProfile: profile.REQUEST_PROFILE, entry: { provider: 'openrouter', model: profile.MODEL }, temperature: 0,
      responseFormat: 'json', attemptTimeoutMs: 20000, maxOutputTokens: profile.MAX_OUTPUT_TOKENS, feature: 'handwriting_mechanics_check' });
    expect(crops[0].messages[0]).toEqual({ role: 'system', content: engine.PROMPT });
    const meta = await sharp(Buffer.from(crops[0].messages[1].content[1].image_url.url.split(',')[1], 'base64')).metadata();
    const lines = engine.pageLines({ text: LINES.join('\n'), startChar: 0, words: words(LINES.join('\n')), width: W, height: H });
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: 'jpeg', ...(({ width, height }) => ({ width, height }))(engine.cropBox([lines[0]], W, H)) });
    expect(result.status).toBe('completed');
    expect(result.findings.map(f => [f.symbol, f.quotedText, f.suggestedText, f.detector])).toEqual([
      ['SPC', 'days ,', 'days,', 'handwriting-mechanics-v1'], ['SPC', 'have .We', 'have. We', 'handwriting-mechanics-v1']]);
    expect(result.summary).toMatchObject({ version: engine.VERSION, status: 'completed', pages: 1, lines: 2, linesChecked: 2, groups: 2, calls: 2,
      promptTokens: 2000, completionTokens: 100, costUsd: 0.002, candidates: { SPC: 2, CAP: 0 }, findings: 2 });
    const event = logs.find(l => l.event === 'handwriting_mechanics_check');
    expect(event).toMatchObject({ submissionId: 'sub-1', status: 'completed', calls: 2, findings: 2 });
    const logged = JSON.stringify(logs);
    for (const word of ['Kids', 'days', 'have', 'know', 'win']) expect(logged).not.toContain(word);
  });

  test('the confidence floor comes from HANDWRITING_MECHANICS_MIN_CONFIDENCE (replies here say 0.95)', async () => {
    const high = await run(essay(), provider({ spaceBefore: ['days'] }), { ...ON, HANDWRITING_MECHANICS_MIN_CONFIDENCE: '0.99' });
    expect(high.result).toMatchObject({ status: 'completed', findings: [] });
    const normal = await run(essay(), provider({ spaceBefore: ['days'] }), { ...ON, HANDWRITING_MECHANICS_MIN_CONFIDENCE: '0.95' });
    expect(normal.result.findings.map(f => f.quotedText)).toEqual(['days ,']);
  });

  test('a PDF page is cropped from its saved page image, checked against the stored raster hash and size', async () => {
    const e = essay({ storedPage: { derivedImageFileId: 'raster-1', ocrInputSha256: undefined },
      fileDocs: { 'raster-1': { _id: 'raster-1', path: 'uploads/submissions/r.jpg', rasterHash: null } } });
    e.deps.loadFile = jest.fn(async id => (id === 'raster-1' ? { _id: id, path: 'uploads/submissions/r.jpg', rasterHash: sha(IMAGE) } : null));
    const call = provider({ spaceBefore: ['days'] });
    const { result } = await run(e, call);
    expect(e.deps.loadFile).toHaveBeenCalledWith('raster-1');
    expect(result.findings.map(f => f.quotedText)).toEqual(['days ,']);
    e.deps.loadFile = jest.fn(async id => ({ _id: id, path: 'uploads/submissions/r.jpg', rasterHash: 'f'.repeat(64) }));
    const mismatch = await run(e, provider());
    expect(mismatch.result).toMatchObject({ status: 'skipped', findings: [] });
    expect(mismatch.result.summary.pagesSkipped).toEqual({ PAGE_IMAGE_MISMATCH: 1 });
  });

  test.each([
    ['image hash differs from the bytes that were read', { storedPage: { ocrInputSha256: 'a'.repeat(64) } }, 'PAGE_IMAGE_MISMATCH'],
    ['image size differs from the stored page size', { storedPage: { width: 999 } }, 'PAGE_IMAGE_MISMATCH'],
    ['geometry in another coordinate space', { storedPage: { coordinateSpace: 'encoded-image' } }, 'COORDINATE_SPACE'],
    ['no file record', { fileDocs: {} }, 'FILE_UNAVAILABLE'],
    ['a stored path outside the backend', { fileDocs: { 'file-1': { _id: 'file-1', path: '../../outside/x.jpg' } } }, 'FILE_UNAVAILABLE']
  ])('%s: the page is skipped and logged, nothing is called, marking is not affected', async (_name, options, reason) => {
    const e = essay(options), call = provider();
    const { result, logs } = await run(e, call);
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'skipped', findings: [] });
    expect(result.summary.pagesSkipped).toEqual({ [reason]: 1 });
    expect(logs.find(l => l.event === 'handwriting_mechanics_check')).toMatchObject({ status: 'skipped', pagesSkipped: { [reason]: 1 } });
  });

  test('a file missing on disk is skipped (FILE_UNAVAILABLE), never thrown', async () => {
    const e = essay();
    e.deps.readFile = jest.fn(async () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); });
    const { result } = await run(e, provider());
    expect(result).toMatchObject({ status: 'skipped', findings: [], summary: expect.objectContaining({ pagesSkipped: { FILE_UNAVAILABLE: 1 } }) });
  });

  test('two pages: offsets follow the combined transcript; the line limit skips the rest (partial)', async () => {
    const e = essay({ pages: ['Kids these days , they win.', 'We have .We know it.'] });
    const { result } = await run(e, provider({ spaceBefore: ['days', 'have'], tightAfter: ['have'] }));
    const second = result.findings.find(f => f.quotedText === 'have .We');
    expect(e.transcript.slice(second.startChar, second.endChar)).toBe('have .We');
    expect(second.startChar).toBeGreaterThan(27);
    const limited = await run(essay(), provider({ spaceBefore: ['days', 'have'] }), { ...ON, HANDWRITING_MECHANICS_MAX_LINES: '1' });
    expect(limited.result.status).toBe('partial');
    expect(limited.result.summary).toMatchObject({ linesChecked: 1, linesSkipped: { MAX_LINES: 1 } });
    expect(limited.result.findings.map(f => f.quotedText)).toEqual(['days ,']);
  });

  test('a reply with the wrong count or a provider error discards only that group', async () => {
    const e = essay();
    let n = 0;
    const call = jest.fn(async options => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('rate limited'), { code: 'AI_RATE_LIMITED', status: 429 });
      return { content: JSON.stringify({ marks: [], cases: [] }), returnedModel: profile.MODEL, usage: { cost: 0.001 } };
    });
    const { result } = await run(e, call);
    expect(result.status).toBe('failed');
    expect(result.summary.callsFailed).toEqual({ AI_RATE_LIMITED: 1 });
    expect(result.summary.groupsDiscarded).toEqual({ REPLY_COUNT_MISMATCH: 1 });
    expect(result.findings).toEqual([]);
  });

  test('the correction failed: the check is stopped and its findings are discarded', async () => {
    const e = essay(), call = provider({ spaceBefore: ['days'], delayMs: 5000 });
    const started = Date.now();
    const { result } = await run(e, call, ON, { correctionSucceeded: false, waitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ status: 'discarded', findings: [] });
    expect(call.mock.calls.every(([o]) => o.signal.aborted)).toBe(true);
  });

  test('the wait after the correction is bounded: slow calls are cancelled, finished groups are kept (partial)', async () => {
    const e = essay();
    let n = 0;
    const fast = provider({ spaceBefore: ['days'] }), slow = provider({ delayMs: 10000 });
    const call = jest.fn(o => (++n === 1 ? fast(o) : slow(o)));
    const started = Date.now();
    const { result } = await run(e, call, ON, { correctionSucceeded: true, waitMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe('partial');
    expect(result.summary.aborted).toBe('wait_limit');
    expect(result.findings.map(f => f.quotedText)).toEqual(['days ,']);
    expect(slow.mock.calls[0][0].signal.aborted).toBe(true);
  });

  test('a check that ended before the wait was up reports no abort reason and its own running time', async () => {
    const e = essay();
    let clock = 1000;
    const handle = stage.start({ doc: e.doc, transcript: e.transcript, pages: e.pages, transcriptComplete: true, env: ON,
      deps: { ...e.deps, providerAttempt: provider(), logger: { info() {}, warn() {} }, now: () => clock } });
    clock = 1400; await handle.done;
    // The correction call ends much later: that time is not the check's.
    clock = 19000;
    const result = await handle.settle({ correctionSucceeded: true, waitMs: 5000 });
    expect(result.summary).toMatchObject({ status: 'completed', aborted: null, durationMs: 400 });
    // Also when there was nothing to check (no geometry): skipped, not stopped by the wait.
    const none = essay(); none.doc.ocrPages.forEach(p => p.words.forEach(w => { w.bbox = null; }));
    const skipped = await run(none, provider());
    expect(skipped.result.summary).toMatchObject({ status: 'skipped', aborted: null, calls: 0 });
    expect(skipped.result.summary.linesSkipped).toEqual({ NO_GEOMETRY: 2 });
  });

  test('the stage budget cancels the calls on its own', async () => {
    const e = essay(), call = provider({ delayMs: 10000 });
    const handle = stage.start({ doc: e.doc, transcript: e.transcript, pages: e.pages, transcriptComplete: true,
      env: { ...ON, HANDWRITING_MECHANICS_STAGE_BUDGET_MS: '80' }, deps: { ...e.deps, providerAttempt: call, logger: { info() {}, warn() {} } } });
    await handle.done;
    const result = await handle.settle({ correctionSucceeded: true, waitMs: 5000 });
    expect(result).toMatchObject({ status: 'failed', findings: [], summary: expect.objectContaining({ aborted: 'stage_budget' }) });
    expect(call.mock.calls.every(([o]) => o.signal.aborted)).toBe(true);
  });

  test('concurrency is limited process-wide, across essays', async () => {
    let active = 0, peak = 0;
    const call = provider({ delayMs: 40, onCall: () => { active += 1; peak = Math.max(peak, active); } });
    const wrapped = jest.fn(async o => { try { return await call(o); } finally { active -= 1; } });
    const env = { ...ON, HANDWRITING_MECHANICS_CONCURRENCY: '2' };
    const three = [essay(), essay(), essay()];
    await Promise.all(three.map(e => run(e, wrapped, env)));
    expect(wrapped).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  test('never throws: an incomplete transcript is skipped; unexpected errors become status failed', async () => {
    const e = essay();
    e.transcriptComplete = false;
    expect((await run(e, provider())).result).toMatchObject({ status: 'skipped', findings: [], summary: expect.objectContaining({ reason: 'TRANSCRIPT_INCOMPLETE' }) });
    const broken = essay();
    broken.deps.loadFile = () => { throw new TypeError('boom'); };
    expect((await run(broken, provider())).result).toMatchObject({ status: 'skipped', findings: [] });
    const garbage = stage.start({ doc: exactDoc({ ocrPages: null }), transcript: null, pages: null, transcriptComplete: true, env: ON,
      deps: { providerAttempt: provider(), logger: { info() {}, warn() {} } } });
    await expect(garbage.settle({ correctionSucceeded: true, waitMs: 100 })).resolves.toMatchObject({ findings: [] });
  });

  test('production default path: no injected fetch or provider; the real gateway gets a fetch function (stubbed global.fetch)', async () => {
    const e = essay({ pages: ['Kids these days , they win.'] });
    const text = 'Kids these days , they win.';
    const items = engine.groupItems(engine.pageLines({ text, startChar: 0, words: words(text), width: W, height: H }));
    const content = JSON.stringify({ marks: items.marks.map(m => ({ space_before: m.before.text === 'days', space_after: true, confidence: 0.9 })),
      cases: items.words.map(w => ({ case_as_written: /^\p{Lu}/u.test(w.text) ? 'capital' : 'small', is_proper_noun: 'false', confidence: 0.9 })) });
    const original = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: profile.MODEL,
      choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1400, completion_tokens: 60, cost: 0.0012 } }) }));
    try {
      const { result } = await run({ ...e, deps: { loadFile: e.deps.loadFile, readFile: e.deps.readFile } }, undefined);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: profile.MODEL, seed: profile.SEED });
      expect(result).toMatchObject({ status: 'completed', summary: expect.objectContaining({ callsFailed: {}, costUsd: 0.0012 }) });
      expect(result.findings.map(f => f.quotedText)).toEqual(['days ,']);
    } finally { global.fetch = original; }
  });

  test('through the real gateway (fetch mocked): the request carries the profile, and cost comes back', async () => {
    const e = essay({ pages: ['Kids these days , they win.'] });
    const bodies = [];
    const fetchImpl = jest.fn(async (_url, request) => {
      const body = JSON.parse(request.body); bodies.push(body);
      const items = engine.groupItems(engine.pageLines({ text: 'Kids these days , they win.', startChar: 0, words: words('Kids these days , they win.'), width: W, height: H }));
      const content = JSON.stringify({ marks: items.marks.map(m => ({ space_before: m.before.text === 'days', space_after: true, confidence: 0.9 })),
        cases: items.words.map(w => ({ case_as_written: /^\p{Lu}/u.test(w.text) ? 'capital' : 'small', is_proper_noun: 'false', confidence: 0.9 })) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: profile.MODEL, choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 1450, completion_tokens: 80, cost: 0.0015 } }) };
    });
    const { result } = await run({ ...e, deps: { ...e.deps, fetchImpl } }, undefined);
    expect(bodies[0]).toMatchObject({ model: profile.MODEL, seed: profile.SEED, temperature: 0, reasoning: { effort: 'low' } });
    expect(result.findings.map(f => f.quotedText)).toEqual(['days ,']);
    expect(result.summary.costUsd).toBe(0.0015);
  });
});
