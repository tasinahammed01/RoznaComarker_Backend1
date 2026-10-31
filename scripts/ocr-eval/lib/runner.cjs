'use strict';
/**
 * Orchestration: plan -> authorize -> (catalog) -> call each photo x variant x model once -> score -> write reports.
 * Nothing here reads environment variables or files outside the dataset: the caller injects the API key,
 * the fetch function and the logger. Live calls cannot start before guards.authorizeRun() has approved the plan.
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

class RunError extends Error {
  constructor(code, message) { super(message); this.name = 'RunError'; this.code = code; }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const keyOf = (name, variant, model) => `${name}|${variant}|${model}`;

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

function rowFor({ item, model, variant, image, source, result, sent, prompt, options, prices, catalogPricing }) {
  const row = {
    name: item.name, model, variant, source, status: 'error', errorCode: null, errorDetail: null, validation: null,
    cerCs: null, werCs: null, cerCi: null, werCi: null, referenceWords: null, uncertainMasked: null, overcorrection: null,
    costUsd: null, costSource: null, promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null,
    reasoningTokens: result.usage?.reasoningTokens ?? null, reasoningNotOff: false, latencyMs: result.latencyMs ?? null,
    provider: result.provider ?? null, returnedModel: result.returnedModel ?? null, finishReason: result.finishReason ?? null, truncated: false,
    temperatureSent: sent.temperature, reasoningParamSent: sent.reasoning, promptMode: prompt.mode, sort: options.sort || 'default',
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
  if (!result.ok) { row.errorCode = result.errorCode || 'ERROR'; row.errorDetail = result.errorDetail || null; return row; }

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
  row.overcorrection = metrics.overCorrection(item.groundTruth, extracted.text, item.mistakes, { wildcardSpan: options.wildcardSpan });
  return row;
}

async function runEvaluation(options, deps) {
  const {
    dataset, models, variants, promptMode = 'plain', live = false, confirm, maxCostUsd, resume = false, provider = null, sort = null,
    wildcardSpan = metrics.DEFAULT_WILDCARD_SPAN, suggestMistakes = false, prices = {}, timeoutMs = openrouter.DEFAULT_TIMEOUT_MS,
    limit = null, noCatalog = false, outDir = DEFAULT_OUT, runId: requestedRunId,
  } = options;
  const { logger, fetchImpl, apiKey = null, now = () => performance.now(), clock = () => new Date() } = deps;

  if (!Array.isArray(models) || !models.length) throw new RunError('NO_MODELS', 'At least one model id is required (--models).');
  for (const model of models) if (!MODEL_ID.test(model)) throw new RunError('BAD_MODEL', `Not a valid model id: ${model}`);
  if (!Array.isArray(variants) || !variants.length || variants.some(v => !VARIANTS.includes(v))) throw new RunError('BAD_VARIANT', `Variants must be among: ${VARIANTS.join(', ')}`);
  const prompt = prompts.promptSpec(promptMode);
  const items = limit ? dataset.items.slice(0, limit) : dataset.items;
  const resolvedOut = assertOutputAllowed(outDir);
  const intent = live ? 'live' : 'dry-run';
  const runId = requestedRunId || defaultRunId(clock, intent);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new RunError('BAD_RUN_ID', 'The run id may only contain letters, digits, dot, dash and underscore.');
  if (resume && !fs.existsSync(path.join(resolvedOut, runId))) throw new RunError('NOTHING_TO_RESUME', `No earlier run named ${runId} in ${resolvedOut}.`);
  const runDir = path.join(resolvedOut, runId);

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
    const fingerprint = entry.image ? sha256(JSON.stringify([TOOL_VERSION, intent, model, variant, entry.image.sha256, prompt.sha256, promptMode, sort, provider, openrouter.MAX_OUTPUT_TOKENS])) : null;
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
    ? `Mode: LIVE - ${plannedCalls} paid call(s) will be made${maxCostUsd ? `, stopping at $${maxCostUsd}` : ''}.`
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
      if (promptMode === 'production' && caps.structuredOutputs === false) throw new RunError('NO_STRUCTURED_OUTPUT', `${model} does not support structured outputs, which --prompt production needs.`);
      capabilities.set(model, caps);
    }
  }

  // ---- run ---------------------------------------------------------------------------------------------------------------
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = clock().toISOString();
  const rows = [];
  let totalCostUsd = 0, made = 0, stoppedEarly = null;
  const settings = { sort, provider, wildcardSpan };
  for (let index = 0; index < combos.length; index++) {
    const { item, variant, model, entry, fingerprint, reusable } = combos[index];
    const label = `[${String(index + 1).padStart(String(combos.length).length)}/${combos.length}] ${item.name} | ${variant} | ${model}`;
    const caps = capabilities.get(model) || null;
    const sent = reusable?.sent || { temperature: caps?.temperature !== false, reasoning: caps?.reasoning !== false };
    let row;
    if (!entry.image) {
      row = rowFor({ item, model, variant, image: null, source: mode, result: { ok: false, errorCode: entry.error.code, errorDetail: entry.error.message }, sent, prompt, options: settings, prices, catalogPricing: null });
    } else if (reusable) {
      row = rowFor({ item, model, variant, image: entry.image, source: 'resumed', result: reusable.result, sent, prompt, options: settings, prices, catalogPricing: caps?.pricing });
    } else {
      let result;
      if (mode === 'dry-run') result = fake.simulate({ model, item, variant, promptMode, image: entry.image });
      else {
        const { body } = openrouter.buildRequest({ model, prompt, image: entry.image, capabilities: caps, options: settings });
        result = await openrouter.callOpenRouter({ body, apiKey, fetchImpl, timeoutMs, now });
      }
      made++;
      row = rowFor({ item, model, variant, image: entry.image, source: mode, result, sent, prompt, options: settings, prices, catalogPricing: caps?.pricing });
      writeJson(path.join(runDir, 'raw', report.safeName(model), variant, `${item.name}.json`), {
        toolVersion: TOOL_VERSION, fingerprint, mode, savedAt: clock().toISOString(), model, variant, name: item.name, sent, result });
      totalCostUsd += row.costUsd || 0;
    }
    rows.push(row);
    logger.info(`${label} -> ${row.status === 'ok' ? `ok, CER ${report.pct(row.cerCs)}` : `error ${row.errorCode}`}${row.costUsd !== null ? `, ${report.money(row.costUsd)}` : ''}${row.latencyMs !== null ? `, ${(row.latencyMs / 1000).toFixed(1)} s` : ''}${row.provider ? `, via ${row.provider}` : ''}${row.reasoningNotOff ? ', REASONING NOT OFF' : ''}${row.source === 'resumed' ? ' (reused)' : ''}`);

    if (maxCostUsd !== undefined && row.source !== 'resumed' && entry.image) {
      if (mode === 'live' && row.costUsd === null) {
        stoppedEarly = `a call returned no cost information, so --max-cost-usd cannot be enforced (stopped after ${made} call(s)). Give --price model=input:output (USD per million tokens) to estimate cost from tokens.`;
        break;
      }
      if (totalCostUsd >= maxCostUsd) { stoppedEarly = `--max-cost-usd ${maxCostUsd} reached ($${totalCostUsd.toFixed(4)} after ${made} call(s)); remaining calls were not made.`; break; }
    }
  }

  // ---- reports --------------------------------------------------------------------------------------------------------------
  const meta = { runId, mode, startedAt, promptMode, sort, provider, variants, models, photoCount: items.length, reusedCalls, totalCostUsd,
    stoppedEarly, wildcardSpan, datasetWarnings: dataset.warnings || [] };
  const files = { runDir, csv: path.join(runDir, 'results.csv'), summary: path.join(runDir, 'summary.md'), diffs: [], drafts: [] };
  fs.writeFileSync(files.csv, report.toCsv(rows));
  const summaryText = report.renderSummary({ meta, rows });
  fs.writeFileSync(files.summary, summaryText);

  const byName = new Map(items.map(item => [item.name, item]));
  for (const worst of report.selectWorst(rows, 3)) {
    const file = path.join(runDir, 'diffs', report.safeName(worst.model), worst.variant, `${worst.name}.diff.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report.renderDiff({ name: worst.name, model: worst.model, variant: worst.variant, groundTruth: byName.get(worst.name).groundTruth,
      output: worst.text, cerCs: worst.cerCs, werCs: worst.werCs, wildcardSpan }));
    files.diffs.push(file);
  }
  if (suggestMistakes) {
    for (const item of items) {
      const outputs = rows.filter(r => r.name === item.name && r.status === 'ok').map(r => ({ label: `${r.model}|${r.variant}`, text: r.text }));
      const candidates = metrics.suggestMistakes(item.groundTruth, outputs, { wildcardSpan });
      if (!candidates.length) continue;
      const file = path.join(runDir, 'mistakes-drafts', `${item.name}.mistakes.draft.tsv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, metrics.formatMistakesDraft(candidates, { name: item.name }));
      files.drafts.push(file);
    }
  }
  writeJson(path.join(runDir, 'run.json'), { toolVersion: TOOL_VERSION, ...meta, datasetDirectory: dataset.directory, plannedCalls, callsMade: made, temperature: 0,
    reasoningRequested: 'none', maxOutputTokens: openrouter.MAX_OUTPUT_TOKENS, promptSha256: prompt.sha256, photos: items.map(i => i.name) });
  for (const row of rows) delete row.text; // transcripts live only in raw/ and diffs/

  return { runId, mode, rows, plannedCalls, reusedCalls, callsMade: made, totalCostUsd, stoppedEarly, files, summary: summaryText };
}

module.exports = { TOOL_VERSION, DEFAULT_OUT, MODEL_ID, RunError, assertOutputAllowed, runEvaluation };
