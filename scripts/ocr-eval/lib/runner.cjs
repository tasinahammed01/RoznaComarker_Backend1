'use strict';
/**
 * Orchestration: plan -> authorize -> (catalog) -> call each photo x variant x model once -> score -> write reports.
 * Nothing here reads environment variables or files outside the dataset: the caller injects the API key,
 * the fetch function and the logger. Live calls cannot start before guards.authorizeRun() has approved the plan.
 *
 * Failure handling
 *  - a failed call is recorded and the run continues with the next call
 *  - a failure that came back as an HTTP error response (rejected before generation) costs nothing and has no
 *    effect on --max-cost-usd; a call that produced output, or reported a cost, counts toward it
 *  - a call that ended without any response (timeout, network) may have been billed: flagged, never guessed
 *  - --max-failures N: after N consecutive failures a model's remaining calls are skipped (other models go on)
 *  - an authentication or credit error stops the whole run; a parameter rejection skips that model's remaining
 *    calls, because the identical request would be rejected again
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metrics = require('./metrics.cjs');
const { readImageBytes, isInsideDirectory } = require('./dataset.cjs');
const { VARIANTS, prepareVariant, ImageError } = require('./imageVariants.cjs');
const prompts = require('./prompts.cjs');
const openrouter = require('./openrouter.cjs');
const fake = require('./fakeModel.cjs');
const report = require('./report.cjs');
const guards = require('./guards.cjs');

const TOOL_VERSION = 'ocr-eval-1';
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_OUT = path.join(BACKEND_ROOT, 'tmp', 'ocr-eval-results'); // listed in .gitignore
const MODEL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/;
const DEFAULT_MAX_FAILURES = 5;

// Errors the API returned as a response before generating anything: no charge.
const NO_CHARGE_CODES = new Set(['AUTH_ERROR', 'PAYMENT_REQUIRED', 'RATE_LIMITED', 'PARAMETER_REJECTED', 'UNKNOWN_FAKE_MODEL']);
const isNoCharge = code => NO_CHARGE_CODES.has(code) || /^HTTP_\d+$/.test(code || '');
// Every later call would fail the same way, so the whole run stops.
const RUN_FATAL = Object.freeze({
  AUTH_ERROR: 'AUTH_ERROR: the API rejected the key (HTTP 401/403). Every further call would fail the same way, so the run stopped. Check OPENROUTER_API_KEY.',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED: OpenRouter reports insufficient credits (HTTP 402). Every further call would fail the same way, so the run stopped.',
});

class RunError extends Error {
  constructor(code, message) { super(message); this.name = 'RunError'; this.code = code; }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function assertOutputAllowed(outDir) {
  const resolved = path.resolve(outDir);
  if (isInsideDirectory(resolved, BACKEND_ROOT) && !isInsideDirectory(resolved, DEFAULT_OUT)) {
    throw new guards.GuardError(`The output folder ${resolved} is inside the repository and is not git-ignored. Results contain student text: use a folder outside the repository (OCR_EVAL_OUT) or the default ${DEFAULT_OUT}.`, 'OUTPUT_IN_REPO');
  }
  return resolved;
}

function defaultRunId(clock, mode) {
  return `${clock().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}${mode === 'dry-run' ? '-dry' : ''}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

function loadReusable(runDir, model, variant, name, fingerprint) {
  const file = path.join(runDir, 'raw', report.safeName(model), variant, `${name}.json`);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record?.fingerprint === fingerprint && record.result?.ok === true ? record : null;
  } catch { return null; }
}

function rowFor({ item, model, variant, image, source, result, sent, reasoning, prompt, options, prices, catalogPricing, temperatureMode = '0' }) {
  const row = {
    name: item.name, model, variant, source, status: 'error', errorCode: null, errorDetail: null, httpStatus: null, rejectedParam: null,
    validation: null, mayBeBilled: false, substitutions: null, deletions: null, insertions: null,
    callsPerPage: prompt.callsPerPage ?? 1, temperatureMode,
    cerCs: null, werCs: null, cerCi: null, werCi: null, referenceWords: null, uncertainMasked: null, overcorrection: null,
    costUsd: null, costSource: null, promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null,
    reasoningTokens: result.usage?.reasoningTokens ?? null, reasoningNotOff: false, latencyMs: result.latencyMs ?? null,
    provider: result.provider ?? result.providerName ?? null, returnedModel: result.returnedModel ?? null, finishReason: result.finishReason ?? null, truncated: false,
    temperatureSent: sent.temperature, reasoningParamSent: sent.reasoning, reasoningMode: reasoning.mode, reasoningSent: reasoning.sent,
    promptMode: prompt.mode, sort: options.sort || 'default',
    pinnedProvider: options.provider || null, imageBytes: image?.byteLength ?? null, imageWidth: image?.width ?? null, imageHeight: image?.height ?? null,
    text: null,
  };
  if (Number.isFinite(result.usage?.costUsd)) { row.costUsd = result.usage.costUsd; row.costSource = 'api'; }
  else {
    const estimated = openrouter.estimateCost(result.usage, prices[model] || catalogPricing);
    if (estimated !== null) { row.costUsd = estimated; row.costSource = 'estimated'; }
  }
  row.reasoningNotOff = (result.usage?.reasoningTokens ?? 0) > 0 || result.reasoningText === true;
  row.truncated = ['length', 'max_tokens'].includes(String(result.finishReason).toLowerCase());
  if (!result.ok) {
    row.errorCode = result.errorCode || 'ERROR'; row.errorDetail = result.errorDetail || null;
    row.httpStatus = result.httpStatus ?? null; row.rejectedParam = result.rejectedParam ?? null;
    return row;
  }

  const extracted = prompts.extractTranscript(prompt.mode, result.content);
  row.validation = extracted.validation;
  if (extracted.status !== 'ok' || !extracted.text.trim()) {
    row.errorCode = extracted.status === 'empty' ? 'EMPTY_RESPONSE' : 'INVALID_JSON';
    return row;
  }
  const scores = metrics.evaluatePair(item.groundTruth, extracted.text, { wildcardSpan: options.wildcardSpan });
  row.status = 'ok';
  row.text = extracted.text;
  row.cerCs = scores.caseSensitive.cer; row.werCs = scores.caseSensitive.wer;
  row.cerCi = scores.caseInsensitive.cer; row.werCi = scores.caseInsensitive.wer;
  row.referenceWords = scores.caseSensitive.referenceWords; row.uncertainMasked = scores.caseSensitive.uncertain.referenceTokensMasked;
  row.substitutions = scores.caseSensitive.substitutions; row.deletions = scores.caseSensitive.deletions; row.insertions = scores.caseSensitive.insertions;
  row.overcorrection = metrics.overCorrection(item.groundTruth, extracted.text, item.mistakes, { wildcardSpan: options.wildcardSpan });
  return row;
}

/** A failed call with no reported cost: an HTTP error response cost nothing; no response at all is unknown. */
function settleFailureCost(row, mode) {
  if (row.status === 'ok' || row.costUsd !== null) return;
  if (isNoCharge(row.errorCode)) { row.costUsd = 0; row.costSource = 'failed-no-charge'; }
  else if (mode === 'live') row.mayBeBilled = true;
}

const skipText = (code, maxFailures) => (code === 'SKIPPED_PARAMETER_REJECTED'
  ? "Skipped: this model's request was rejected (PARAMETER_REJECTED); the same request would be rejected again."
  : `Skipped: this model failed ${maxFailures} times in a row (--max-failures ${maxFailures}).`);

async function runEvaluation(options, deps) {
  const {
    dataset, models, variants, promptMode = 'plain', live = false, confirm, maxCostUsd, resume = false, provider = null, sort = null,
    wildcardSpan = metrics.DEFAULT_WILDCARD_SPAN, suggestMistakes = false, prices = {}, timeoutMs = openrouter.DEFAULT_TIMEOUT_MS,
    limit = null, noCatalog = false, outDir = DEFAULT_OUT, runId: requestedRunId, maxFailures = DEFAULT_MAX_FAILURES, reasoningFor = {},
    temperature = '0',
  } = options;
  const { logger, fetchImpl, apiKey = null, now = () => performance.now(), clock = () => new Date() } = deps;

  if (!Array.isArray(models) || !models.length) throw new RunError('NO_MODELS', 'At least one model id is required (--models).');
  for (const model of models) if (!MODEL_ID.test(model)) throw new RunError('BAD_MODEL', `Not a valid model id: ${model}`);
  if (!Array.isArray(variants) || !variants.length || variants.some(v => !VARIANTS.includes(v))) throw new RunError('BAD_VARIANT', `Variants must be among: ${VARIANTS.join(', ')}`);
  if (!Number.isInteger(maxFailures) || maxFailures < 1) throw new RunError('BAD_MAX_FAILURES', '--max-failures must be a whole number of at least 1.');
  if (!openrouter.TEMPERATURE_MODES.includes(temperature)) throw new RunError('BAD_TEMPERATURE', `--temperature must be one of: ${openrouter.TEMPERATURE_MODES.join(', ')}.`);
  for (const [model, mode] of Object.entries(reasoningFor)) {
    if (!models.includes(model)) throw new RunError('BAD_REASONING', `--reasoning-for names ${model}, which is not in --models.`);
    if (!openrouter.REASONING_MODES.includes(mode)) throw new RunError('BAD_REASONING', `Unknown reasoning mode "${mode}" for ${model}. Use one of: ${openrouter.REASONING_MODES.join(', ')}.`);
  }
  const prompt = prompts.promptSpec(promptMode);
  const items = limit ? dataset.items.slice(0, limit) : dataset.items;
  const resolvedOut = assertOutputAllowed(outDir);
  const intent = live ? 'live' : 'dry-run';
  const runId = requestedRunId || defaultRunId(clock, intent);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new RunError('BAD_RUN_ID', 'The run id may only contain letters, digits, dot, dash and underscore.');
  if (resume && !fs.existsSync(path.join(resolvedOut, runId))) throw new RunError('NOTHING_TO_RESUME', `No earlier run named ${runId} in ${resolvedOut}.`);
  const runDir = path.join(resolvedOut, runId);
  const reasoningModeOf = model => reasoningFor[model] || 'none';

  // ---- prepare images (local, free) and plan --------------------------------------------------------------------
  const prepared = new Map();
  for (const item of items) {
    let bytes = null, readError = null;
    try { bytes = readImageBytes(item); } catch { readError = new ImageError('IMAGE_UNREADABLE', 'The image file could not be read.'); }
    for (const variant of variants) {
      if (readError) { prepared.set(`${item.name}|${variant}`, { error: readError }); continue; }
      try { prepared.set(`${item.name}|${variant}`, { image: await prepareVariant(variant, bytes) }); }
      catch (error) { prepared.set(`${item.name}|${variant}`, { error: error instanceof ImageError ? error : new ImageError('IMAGE_PREPARE_FAILED', 'The image could not be processed.') }); }
    }
  }
  const combos = [];
  for (const item of items) for (const variant of variants) for (const model of models) {
    const entry = prepared.get(`${item.name}|${variant}`);
    // Non-default settings join the fingerprint; defaults add nothing, so earlier saved results stay reusable.
    const extra = [...(reasoningModeOf(model) === 'none' ? [] : [`reasoning:${reasoningModeOf(model)}`]), ...(temperature === 'omit' ? ['temperature:omit'] : [])];
    const fingerprint = entry.image ? sha256(JSON.stringify([TOOL_VERSION, intent, model, variant, entry.image.sha256, prompt.sha256, promptMode, sort, provider, openrouter.MAX_OUTPUT_TOKENS, ...extra])) : null;
    const reusable = resume && fingerprint ? loadReusable(runDir, model, variant, item.name, fingerprint) : null;
    combos.push({ item, variant, model, entry, fingerprint, reusable });
  }
  const callable = combos.filter(c => c.entry.image && !c.reusable);
  const plannedCalls = callable.length;
  const reusedCalls = combos.filter(c => c.reusable).length;

  // ---- authorization: nothing below may reach the network unless this approves it -------------------------------
  const authorization = guards.authorizeRun({ live, confirm, plannedCalls, apiKeyPresent: Boolean(apiKey), models, maxCostUsd });
  const mode = authorization.mode;
  logger.info(`Plan: ${items.length} photos x ${variants.length} variants x ${models.length} models = ${combos.length} calls (${reusedCalls} reused, ${plannedCalls} to run).`);
  logger.info(mode === 'live'
    ? `Mode: LIVE - up to ${plannedCalls} paid call(s)${maxCostUsd ? `, stopping at $${maxCostUsd}` : ''}; a model is skipped after ${maxFailures} consecutive failures.`
    : 'Mode: dry-run - simulated models, no network, no cost.');

  // ---- model capabilities (free catalog request, live runs only) ---------------------------------------------------
  const capabilities = new Map();
  if (mode === 'live' && plannedCalls > 0 && !noCatalog) {
    logger.info('Reading the OpenRouter model catalog (free request) to check each model...');
    let catalog;
    try { catalog = await openrouter.fetchCatalog({ fetchImpl }); } catch (error) { throw new RunError('CATALOG_UNAVAILABLE', `${error.message} Re-run with --no-catalog to skip the capability check.`); }
    for (const model of models) {
      const caps = openrouter.capabilitiesFromCatalog(catalog.get(model));
      if (!caps.found) throw new RunError('MODEL_NOT_FOUND', `${model} is not in the OpenRouter catalog.`);
      if (caps.vision === false) throw new RunError('NO_VISION', `${model} does not accept image input.`);
      if (prompt.responseSchema && caps.structuredOutputs === false) throw new RunError('NO_STRUCTURED_OUTPUT', `${model} does not support structured outputs, which --prompt ${promptMode} needs.`);
      capabilities.set(model, caps);
    }
  }

  // ---- run ---------------------------------------------------------------------------------------------------------------
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = clock().toISOString();
  const rows = [];
  const consecutiveFailures = new Map(), skippedModels = new Map();
  let totalCostUsd = 0, made = 0, stoppedEarly = null;
  const settings = { sort, provider, wildcardSpan };
  const metaNow = partial => ({ runId, mode, startedAt, promptMode, sort, provider, variants, models, photoCount: items.length, reusedCalls, totalCostUsd,
    stoppedEarly, wildcardSpan, maxFailures, maxOutputTokens: openrouter.MAX_OUTPUT_TOKENS, temperature, partial, plannedRows: combos.length,
    datasetWarnings: dataset.warnings || [] });
  const runJsonNow = complete => ({ complete, datasetDirectory: dataset.directory, plannedCalls, callsMade: made, reasoningDefault: 'none', reasoningFor,
    promptSha256: prompt.sha256, photos: items.map(i => i.name) });
  for (let index = 0; index < combos.length; index++) {
    const { item, variant, model, entry, fingerprint, reusable } = combos[index];
    const label = `[${String(index + 1).padStart(String(combos.length).length)}/${combos.length}] ${item.name} | ${variant} | ${model}`;
    const caps = capabilities.get(model) || null;
    const reasoningMode = reasoningModeOf(model);
    const plan = openrouter.reasoningPlan(reasoningMode, caps);
    const sent = reusable?.sent || { temperature: caps?.temperature !== false && temperature !== 'omit', reasoning: Boolean(plan.param) };
    const reasoning = { mode: reasoningMode, sent: reusable?.reasoningSent || plan.sent };
    const common = { item, model, variant, sent, reasoning, prompt, options: settings, prices, catalogPricing: caps?.pricing, temperatureMode: temperature };
    let row, fatal = false;
    if (!entry.image) {
      row = rowFor({ ...common, image: null, source: mode, result: { ok: false, errorCode: entry.error.code, errorDetail: entry.error.message }, catalogPricing: null });
    } else if (reusable) {
      row = rowFor({ ...common, image: entry.image, source: 'resumed', result: reusable.result });
    } else if (skippedModels.has(model)) {
      const code = skippedModels.get(model);
      row = rowFor({ ...common, image: entry.image, source: 'skipped', result: { ok: false, errorCode: code, errorDetail: skipText(code, maxFailures) } });
      row.status = 'skipped';
    } else {
      let result;
      if (mode === 'dry-run') result = fake.simulate({ model, item, variant, promptMode, image: entry.image, reasoningMode });
      else {
        const { body } = openrouter.buildRequest({ model, prompt, image: entry.image, capabilities: caps, options: { ...settings, reasoningMode, temperature } });
        result = await openrouter.callOpenRouter({ body, apiKey, fetchImpl, timeoutMs, now });
      }
      made++;
      row = rowFor({ ...common, image: entry.image, source: mode, result });
      settleFailureCost(row, mode);
      writeJson(path.join(runDir, 'raw', report.safeName(model), variant, `${item.name}.json`), {
        toolVersion: TOOL_VERSION, fingerprint, mode, savedAt: clock().toISOString(), model, variant, name: item.name, sent,
        reasoningMode: reasoning.mode, reasoningSent: reasoning.sent, promptMode, sort, pinnedProvider: provider, temperatureMode: temperature, result });
      totalCostUsd += row.costUsd || 0;

      if (row.status === 'ok') consecutiveFailures.set(model, 0);
      else {
        const count = (consecutiveFailures.get(model) || 0) + 1;
        consecutiveFailures.set(model, count);
        if (RUN_FATAL[row.errorCode]) { stoppedEarly = RUN_FATAL[row.errorCode]; fatal = true; }
        else if (row.errorCode === 'PARAMETER_REJECTED') skippedModels.set(model, 'SKIPPED_PARAMETER_REJECTED');
        else if (count >= maxFailures) skippedModels.set(model, 'SKIPPED_MAX_FAILURES');
      }
    }
    rows.push(row);

    const outcome = row.status === 'ok' ? `ok, CER ${report.pct(row.cerCs)}`
      : row.status === 'skipped' ? `skipped (${row.errorCode})`
        : `error ${row.errorCode}${row.httpStatus ? ` (HTTP ${row.httpStatus})` : ''}${row.errorDetail ? `: ${row.errorDetail.slice(0, 200)}` : ''}`;
    logger.info(`${label} -> ${outcome}${row.costUsd !== null && (row.status === 'ok' || row.costUsd > 0) ? `, ${report.money(row.costUsd)}` : ''}${row.latencyMs !== null && row.status !== 'skipped' ? `, ${(row.latencyMs / 1000).toFixed(1)} s` : ''}${row.provider && row.status === 'ok' ? `, via ${row.provider}` : ''}${row.reasoningNotOff ? ', REASONING NOT OFF' : ''}${row.mayBeBilled ? ', may have been billed' : ''}${row.source === 'resumed' ? ' (reused)' : ''}`);
    writeReports(runDir, rows, metaNow(true), runJsonNow(false)); // keep results if the run is interrupted
    if (fatal) break;

    // The cap is judged on calls whose cost is known; a failed call that cost nothing never trips it.
    if (maxCostUsd !== undefined && row.source !== 'resumed' && row.source !== 'skipped' && entry.image) {
      if (mode === 'live' && row.status === 'ok' && row.costUsd === null) {
        stoppedEarly = `a call returned no cost information, so --max-cost-usd cannot be enforced (stopped after ${made} call(s)). Give --price model=input:output (USD per million tokens) to estimate cost from tokens.`;
        break;
      }
      if (totalCostUsd >= maxCostUsd) { stoppedEarly = `--max-cost-usd ${maxCostUsd} reached ($${totalCostUsd.toFixed(4)} after ${made} call(s)); remaining calls were not made.`; break; }
    }
  }

  // ---- reports --------------------------------------------------------------------------------------------------------------
  const summaryText = writeReports(runDir, rows, metaNow(false), runJsonNow(true));
  const files = { runDir, csv: path.join(runDir, 'results.csv'), summary: path.join(runDir, 'summary.md'),
    ...writeDiffsAndDrafts({ runDir, rows, items, wildcardSpan, suggestMistakes }) };
  for (const row of rows) delete row.text; // transcripts live only in raw/ and diffs/

  return { runId, mode, rows, plannedCalls, reusedCalls, callsMade: made, totalCostUsd, stoppedEarly, files, summary: summaryText };
}

/** results.csv, summary.md and run.json. Called after every call (partial) and at the end, so an interrupted run keeps its results. */
function writeReports(runDir, rows, meta, runJson) {
  fs.writeFileSync(path.join(runDir, 'results.csv'), report.toCsv(rows));
  const summaryText = report.renderSummary({ meta, rows });
  fs.writeFileSync(path.join(runDir, 'summary.md'), summaryText);
  writeJson(path.join(runDir, 'run.json'), { toolVersion: TOOL_VERSION, ...meta, ...runJson });
  return summaryText;
}

/** Worst-3 diffs per model and variant, and (optionally) mistakes drafts. Both contain student text. */
function writeDiffsAndDrafts({ runDir, rows, items, wildcardSpan, suggestMistakes }) {
  const diffs = [], drafts = [];
  const byName = new Map(items.map(item => [item.name, item]));
  for (const worst of report.selectWorst(rows, 3)) {
    if (!byName.has(worst.name) || typeof worst.text !== 'string') continue;
    const file = path.join(runDir, 'diffs', report.safeName(worst.model), worst.variant, `${worst.name}.diff.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report.renderDiff({ name: worst.name, model: worst.model, variant: worst.variant, groundTruth: byName.get(worst.name).groundTruth,
      output: worst.text, cerCs: worst.cerCs, werCs: worst.werCs, wildcardSpan }));
    diffs.push(file);
  }
  if (suggestMistakes) {
    for (const item of items) {
      const outputs = rows.filter(r => r.name === item.name && r.status === 'ok').map(r => ({ label: `${r.model}|${r.variant}`, text: r.text }));
      const found = metrics.suggestMistakes(item.groundTruth, outputs, { wildcardSpan });
      if (!found.length) continue;
      const file = path.join(runDir, 'mistakes-drafts', `${item.name}.mistakes.draft.tsv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, metrics.formatMistakesDraft(found, { name: item.name }));
      drafts.push(file);
    }
  }
  return { diffs, drafts };
}

function listRawFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? listRawFiles(path.join(dir, entry.name))
    : entry.name.endsWith('.json') ? [path.join(dir, entry.name)] : []));
}

/**
 * Offline re-scoring: rebuilds results.csv, summary.md, run.json and the diffs of an existing run from its saved calls
 * (raw/) with the current metrics. No network, no API key, no new spending. Older saved calls do not record their
 * prompt mode: pass it explicitly; if both are present they must agree.
 */
async function rescoreRun({ dataset, outDir = DEFAULT_OUT, runId, promptMode: requestedMode = null, wildcardSpan = metrics.DEFAULT_WILDCARD_SPAN, logger, clock = () => new Date() }) {
  if (!runId || !/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new RunError('BAD_RUN_ID', 'Give the run id to rescore, e.g. --rescore 20261101-000748.');
  const runDir = path.join(assertOutputAllowed(outDir), runId);
  const files = listRawFiles(path.join(runDir, 'raw'));
  if (!files.length) throw new RunError('NOTHING_TO_RESCORE', `No saved calls in ${path.join(runDir, 'raw')}.`);
  let previousMeta = {};
  try { previousMeta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); } catch { /* interrupted runs may have none */ }
  const previousRows = new Map();
  try {
    for (const r of require('./csv.cjs').parseCsv(fs.readFileSync(path.join(runDir, 'results.csv'), 'utf8'))) previousRows.set(`${r.photo}|${r.variant}|${r.model}`, r);
  } catch { /* none yet */ }

  const byName = new Map(dataset.items.map(item => [item.name, item]));
  const records = [];
  for (const file of files) {
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { logger.warn(`Skipped an unreadable saved call: ${path.relative(runDir, file)}`); continue; }
    if (!byName.has(record?.name)) { logger.warn(`Skipped ${record?.name ?? path.basename(file)}: not in the evaluation folder.`); continue; }
    const promptMode = record.promptMode ?? previousMeta.promptMode ?? requestedMode;
    if (!promptMode) throw new RunError('PROMPT_MODE_REQUIRED', 'These saved calls do not record their prompt mode. Re-run with --prompt <mode> (the mode the run used).');
    if (requestedMode && promptMode !== requestedMode) throw new RunError('PROMPT_MODE_CONFLICT', `--prompt ${requestedMode} does not match the saved calls (${promptMode}).`);
    records.push({ ...record, promptMode });
  }
  const modelOrder = previousMeta.models || [...new Set(records.map(r => r.model))];
  const order = r => [modelOrder.indexOf(r.model), VARIANTS.indexOf(r.variant)];
  records.sort((a, b) => require('./dataset.cjs').naturalCompare(a.name, b.name) || order(a)[1] - order(b)[1] || order(a)[0] - order(b)[0]);

  const rows = records.map(record => {
    const before = previousRows.get(`${record.name}|${record.variant}|${record.model}`);
    const image = before && before.image_bytes !== '' ? { byteLength: Number(before.image_bytes), width: Number(before.image_width), height: Number(before.image_height) } : null;
    const row = rowFor({ item: byName.get(record.name), model: record.model, variant: record.variant, image, source: record.mode || 'live', result: record.result || { ok: false, errorCode: 'ERROR' },
      sent: record.sent || { temperature: true, reasoning: true }, reasoning: { mode: record.reasoningMode || 'none', sent: record.reasoningSent || null },
      prompt: prompts.promptSpec(record.promptMode), options: { sort: record.sort ?? previousMeta.sort ?? null, provider: record.pinnedProvider ?? previousMeta.provider ?? null, wildcardSpan },
      prices: {}, catalogPricing: null, temperatureMode: record.temperatureMode || '0' });
    settleFailureCost(row, record.mode);
    return row;
  });
  const items = dataset.items.filter(item => records.some(r => r.name === item.name));
  const variants = VARIANTS.filter(v => records.some(r => r.variant === v));
  const meta = { ...previousMeta, runId, mode: records[0].mode || previousMeta.mode || 'live', promptMode: records[0].promptMode,
    startedAt: previousMeta.startedAt || records.map(r => r.savedAt).filter(Boolean).sort()[0] || null,
    models: modelOrder, variants, photoCount: items.length, reusedCalls: previousMeta.reusedCalls ?? 0,
    totalCostUsd: rows.reduce((sum, r) => sum + (r.costUsd || 0), 0), stoppedEarly: previousMeta.stoppedEarly ?? null, wildcardSpan,
    maxOutputTokens: openrouter.MAX_OUTPUT_TOKENS, temperature: records[0].temperatureMode || previousMeta.temperature || '0', partial: false,
    datasetWarnings: dataset.warnings || [] };
  const summaryText = writeReports(runDir, rows, meta, { rescoredAt: clock().toISOString(), rescoredCalls: rows.length, complete: previousMeta.complete ?? null });
  const extra = writeDiffsAndDrafts({ runDir, rows, items, wildcardSpan, suggestMistakes: false });
  for (const row of rows) delete row.text;
  logger.info(`Rescored ${rows.length} saved call(s) in ${runDir} (no API calls).`);
  return { runId, rows, summary: summaryText, files: { runDir, csv: path.join(runDir, 'results.csv'), summary: path.join(runDir, 'summary.md'), ...extra } };
}

module.exports = { TOOL_VERSION, DEFAULT_OUT, DEFAULT_MAX_FAILURES, MODEL_ID, RunError, assertOutputAllowed, runEvaluation, rescoreRun };
