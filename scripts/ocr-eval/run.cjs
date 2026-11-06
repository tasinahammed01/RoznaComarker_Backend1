#!/usr/bin/env node
'use strict';
/**
 * OCR evaluation harness - compares vision models on handwritten pages against ground truth.
 * Run `node scripts/ocr-eval/run.cjs --help`. Dry-run (simulated models) is the default; real, paid calls
 * need --live together with --confirm <exact number of calls>.
 */
const path = require('path');
const metrics = require('./lib/metrics.cjs');
const dataset = require('./lib/dataset.cjs');
const openrouter = require('./lib/openrouter.cjs');
const guards = require('./lib/guards.cjs');
const { VARIANTS, DEFAULT_VARIANTS } = require('./lib/imageVariants.cjs');
const { PROMPT_MODES } = require('./lib/prompts.cjs');
const { DEFAULT_OUT, DEFAULT_MAX_FAILURES, MODEL_ID, RunError, runEvaluation, rescoreRun } = require('./lib/runner.cjs');

const HELP = `OCR evaluation harness

Environment
  OCR_EVAL_DIR          folder with <name>.jpg|.jpeg|.png + <name>.txt, outside the repo. Optional per photo:
                        <name>.mistakes.tsv (genuine student mistakes), <name>.answer.txt (the answer without the copied
                        question), <name>.question.txt (the copied question), <name>.struck.txt (crossed-out phrases, one
                        per line), <name>.assignment.json ({"title": "...", "instructions": "..."} as stored in the app)
  OCR_EVAL_OUT          output folder, outside the repo (default: backend/tmp/ocr-eval-results, git-ignored)
  OPENROUTER_API_KEY    only read for --live runs; never printed or written anywhere

Modes
  (default)             dry run: simulated models, no network, no cost
  --live --confirm N    real paid calls; N must equal the number of calls printed in the plan
  --inspect             read-only dataset check: counts and file names only
  --check-models        free OpenRouter catalog lookup for --models (no paid calls)

Options
  --models a/b,c/d      OpenRouter model ids (dry run also accepts fake/perfect, fake/noisy, fake/autocorrect, fake/reasoning,
                        fake/needs-reasoning, fake/always-fails)
  --reasoning-for m=MODE  reasoning setting for one model (repeatable). MODE: none (default for every model),
                        minimal, low, medium, high, or omit (send no reasoning parameter). What was sent is recorded
                        per model in summary.md and results.csv
  --max-failures N      skip a model's remaining calls after N consecutive failures (default ${DEFAULT_MAX_FAILURES}); other models continue.
                        An authentication or credit error stops the whole run; a rejected parameter skips that model at once
  --variants list       original,preprocessed,client-export (default original,preprocessed)
  --prompt mode         plain (default) | production | plain-first (A) | production-trim (C) | lean-json (D) |
                        verbatim-json (separates question, answer, crossed-out and uncertain; strict JSON) |
                        plain-first-excl (plain-first, with the copied question excluded by the production code rule)
  --temperature T       0 (default) | omit (send no temperature: provider default, as production does today)
  --rescore RUN_ID      offline: rebuild results.csv, summary.md and diffs of a run from its saved calls with the
                        current metrics (no API calls, no key). Older runs need --prompt <mode they used>
  --max-cost-usd X      stop once the run has cost X (live: needs the API or --price to report cost)
  --price model=in:out  USD per million tokens (repeatable). Used when the API reports no cost, and, when it does, to flag
                        calls whose reported cost differs from tokens x this price by more than 15% (a different pricing tier)
  --resume --run-id ID  reuse successful calls already saved in that run (no repeat spending)
  --run-id ID           name of the run folder inside the output folder
  --provider A,B        pin one or more providers or endpoint tags (provider.only); cannot be combined with --sort
  --ignore-providers A,B  exclude providers or endpoint tags (provider.ignore), for example a pricing tier
  --sort S              latency | throughput | price | default (default = no sort; production uses latency for Qwen)
  --only a,b            only these photos (names such as image11); the plan and --confirm cover just them
  --limit N             only the first N photos (natural order; applied after --only)
  --suggest-mistakes    write draft <name>.mistakes.draft.tsv files into the run folder
  --no-catalog          live: skip the free catalog check (send every parameter to every model)
  --timeout-ms N        per-call timeout (default 180000)
  --wildcard-span N     model words one [?] may absorb (default ${metrics.DEFAULT_WILDCARD_SPAN})
  --out DIR             output folder (overrides OCR_EVAL_OUT)
`;

class UsageError extends Error {}

const VALUE_FLAGS = new Set(['models', 'variants', 'prompt', 'confirm', 'max-cost-usd', 'run-id', 'provider', 'sort', 'out', 'limit', 'price', 'timeout-ms', 'wildcard-span',
  'max-failures', 'reasoning-for', 'temperature', 'rescore', 'ignore-providers', 'only']);
const BOOLEAN_FLAGS = new Set(['live', 'dry-run', 'resume', 'suggest-mistakes', 'check-models', 'inspect', 'no-catalog', 'help']);

function integer(name, text, min = 0) {
  if (!/^\d+$/.test(String(text)) || Number(text) < min) throw new UsageError(`--${name} must be a whole number${min ? ` of at least ${min}` : ''}.`);
  return Number(text);
}

function parseArgs(argv) {
  const raw = { prices: {}, reasoningFor: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new UsageError(`Unexpected argument: ${token}`);
    const [flag, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`--${flag} does not take a value.`);
      raw[flag] = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${flag} needs a value.`);
      if (flag === 'price') {
        const match = /^([^=]+)=(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
        if (!match) throw new UsageError('--price must look like model/id=0.30:1.20 (USD per million input:output tokens).');
        raw.prices[match[1]] = { inputPerMillion: Number(match[2]), outputPerMillion: Number(match[3]) };
      } else if (flag === 'reasoning-for') {
        const match = /^([^=]+)=(.+)$/.exec(value);
        if (!match) throw new UsageError(`--reasoning-for must look like model/id=MODE (MODE: ${openrouter.REASONING_MODES.join(', ')}).`);
        if (!MODEL_ID.test(match[1])) throw new UsageError(`--reasoning-for: not a valid model id: ${match[1]}`);
        if (!openrouter.REASONING_MODES.includes(match[2])) throw new UsageError(`--reasoning-for: unknown mode "${match[2]}". Use one of: ${openrouter.REASONING_MODES.join(', ')}.`);
        raw.reasoningFor[match[1]] = match[2];
      } else raw[flag] = value;
    } else throw new UsageError(`Unknown option: --${flag}`);
  }
  const split = text => [...new Set(String(text).split(',').map(s => s.trim()).filter(Boolean))];
  const args = {
    help: Boolean(raw.help), live: Boolean(raw.live), resume: Boolean(raw.resume), suggestMistakes: Boolean(raw['suggest-mistakes']),
    checkModels: Boolean(raw['check-models']), inspect: Boolean(raw.inspect), noCatalog: Boolean(raw['no-catalog']),
    models: raw.models ? split(raw.models) : [], variants: raw.variants ? split(raw.variants) : [...DEFAULT_VARIANTS],
    promptMode: raw.prompt ?? 'plain', runId: raw['run-id'], provider: raw.provider ?? null, sort: raw.sort ?? null, out: raw.out, prices: raw.prices,
    reasoningFor: raw.reasoningFor, temperature: raw.temperature ?? '0', promptGiven: raw.prompt !== undefined, rescore: raw.rescore ?? null,
    ignoreProviders: raw['ignore-providers'] ? split(raw['ignore-providers']) : [], only: raw.only ? split(raw.only) : [],
  };
  const badOnly = args.only.find(name => !/^[A-Za-z0-9._-]{1,80}$/.test(name));
  if (badOnly) throw new UsageError(`--only: "${badOnly.slice(0, 40)}" is not a photo name (letters, digits, dot, dash and underscore only).`);
  const badIgnored = args.ignoreProviders.find(name => !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(name));
  if (badIgnored) throw new UsageError(`--ignore-providers: "${badIgnored.slice(0, 40)}" is not a provider name or endpoint tag (letters, digits, dot, dash, underscore and slash only).`);
  if (!openrouter.TEMPERATURE_MODES.includes(args.temperature)) throw new UsageError(`--temperature must be one of: ${openrouter.TEMPERATURE_MODES.join(', ')} (omit = send none, like production today).`);
  if (args.rescore && (args.live || raw['dry-run'] || args.resume || raw.confirm !== undefined || args.checkModels || args.inspect)) {
    throw new UsageError('--rescore works offline on saved calls and cannot be combined with --live, --dry-run, --resume, --confirm, --check-models or --inspect.');
  }
  args.maxFailures = raw['max-failures'] !== undefined ? integer('max-failures', raw['max-failures'], 1) : DEFAULT_MAX_FAILURES;
  if (!args.checkModels) {
    for (const model of Object.keys(args.reasoningFor)) {
      if (args.models.length && !args.models.includes(model)) throw new UsageError(`--reasoning-for names ${model}, which is not in --models.`);
    }
  }
  if (raw.live && raw['dry-run']) throw new UsageError('Choose either --live or --dry-run, not both.');
  if (raw.confirm !== undefined) args.confirm = integer('confirm', raw.confirm);
  if (raw['max-cost-usd'] !== undefined) {
    const value = Number(raw['max-cost-usd']);
    if (!Number.isFinite(value) || value <= 0) throw new UsageError('--max-cost-usd must be a number greater than 0.');
    args.maxCostUsd = value;
  }
  if (raw.limit !== undefined) args.limit = integer('limit', raw.limit, 1);
  args.timeoutMs = raw['timeout-ms'] !== undefined ? integer('timeout-ms', raw['timeout-ms'], 1000) : openrouter.DEFAULT_TIMEOUT_MS;
  args.wildcardSpan = raw['wildcard-span'] !== undefined ? integer('wildcard-span', raw['wildcard-span']) : metrics.DEFAULT_WILDCARD_SPAN;
  if (!PROMPT_MODES.includes(args.promptMode)) throw new UsageError(`--prompt must be one of: ${PROMPT_MODES.join(', ')}.`);
  const badVariant = args.variants.find(v => !VARIANTS.includes(v));
  if (badVariant || !args.variants.length) throw new UsageError(`--variants must be a list from: ${VARIANTS.join(', ')}.`);
  const badModel = args.models.find(m => !MODEL_ID.test(m));
  if (badModel) throw new UsageError(`Not a valid model id: ${badModel}`);
  if (args.sort !== null && !openrouter.SORT_VALUES.includes(args.sort)) throw new UsageError(`--sort must be one of: ${openrouter.SORT_VALUES.join(', ')}.`);
  if (args.provider && args.sort && args.sort !== 'default') throw new UsageError('--provider and --sort cannot be combined.');
  if (args.resume && !args.runId) throw new UsageError('--resume needs --run-id.');
  return args;
}

const refuseNetwork = () => { throw new Error('Network access is disabled in dry-run mode.'); };

function printInspect(loaded, logger) {
  logger.info(`Folder: ${loaded.directory}`);
  logger.info(`Pairs: ${loaded.items.length}`);
  logger.info('name | image file | image bytes | words | [?] tokens | mistakes list | answer file | question lines | struck phrases | assignment text');
  for (const item of loaded.items) {
    const tokens = metrics.tokenize(metrics.normalizeText(item.groundTruth));
    const count = (list, unit) => (list ? `${list.length} ${unit}` : 'none');
    logger.info(`${item.name} | ${path.basename(item.imagePath)} | ${item.imageBytes} | ${tokens.length} | ${tokens.filter(metrics.isUncertainToken).length} | ${item.mistakes ? `${item.mistakes.entries.length} entries` : 'none'}`
      + ` | ${item.answerTruth ? 'yes' : 'none'} | ${count(item.questionPhrases, 'lines')} | ${count(item.struckPhrases, 'phrases')} | ${item.assignment ? 'yes' : 'none'}`);
  }
  logger.info(`Total words: ${loaded.items.reduce((sum, item) => sum + metrics.tokenize(metrics.normalizeText(item.groundTruth)).length, 0)}`);
  logger.info(`Warnings: ${loaded.warnings.length}`);
  for (const warning of loaded.warnings) logger.info(`  - ${warning}`);
}

async function printModelCheck(models, fetchImpl, logger) {
  const catalog = await openrouter.fetchCatalog({ fetchImpl });
  const yesNo = v => (v === null ? 'unknown' : v ? 'yes' : 'no');
  logger.info('model | in catalog | image input | temperature | reasoning control | structured output | USD per M tokens (in/out)');
  for (const model of models) {
    const caps = openrouter.capabilitiesFromCatalog(catalog.get(model));
    const price = caps.pricing ? `${caps.pricing.inputPerMillion ?? '?'} / ${caps.pricing.outputPerMillion ?? '?'}` : 'unknown';
    logger.info(`${model} | ${yesNo(caps.found)} | ${yesNo(caps.vision)} | ${yesNo(caps.temperature)} | ${yesNo(caps.reasoning)} | ${yesNo(caps.structuredOutputs)} | ${price}`);
  }
}

/** Returns the process exit code: 0 ok, 1 run/data problem, 2 usage or safety-guard refusal. */
async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const secrets = [];
  const logger = openrouter.createLogger({ secrets, stdout: io.stdout, stderr: io.stderr });
  let args;
  try { args = parseArgs(argv); } catch (error) {
    logger.error(error.message); logger.info('Run with --help for usage.'); return 2;
  }
  if (args.help) { logger.info(HELP); return 0; }
  const apiKey = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim() ? env.OPENROUTER_API_KEY.trim() : null;
  if (apiKey) secrets.push(apiKey);

  try {
    if (args.checkModels) {
      if (!args.models.length) throw new UsageError('--check-models needs --models.');
      await printModelCheck(args.models, io.fetchImpl ?? global.fetch, logger);
      return 0;
    }
    const loaded = dataset.loadDataset(dataset.resolveEvalDir(env));
    if (args.inspect) { printInspect(loaded, logger); return 0; }
    if (args.rescore) {
      const result = await rescoreRun({ dataset: loaded, outDir: args.out || env.OCR_EVAL_OUT || DEFAULT_OUT, runId: args.rescore,
        promptMode: args.promptGiven ? args.promptMode : null, wildcardSpan: args.wildcardSpan, logger });
      logger.info('');
      logger.info(result.summary);
      logger.info(`Run folder: ${result.files.runDir}`);
      logger.info(`Files: results.csv, summary.md, run.json, ${result.files.diffs.length} diff file(s). No API calls were made.`);
      return 0;
    }
    if (!args.models.length) throw new UsageError('--models is required.');
    const outDir = args.out || env.OCR_EVAL_OUT || DEFAULT_OUT;
    const result = await runEvaluation({ ...args, dataset: loaded, outDir }, {
      logger, apiKey, fetchImpl: args.live ? (io.fetchImpl ?? global.fetch) : refuseNetwork,
    });
    logger.info('');
    logger.info(result.summary);
    logger.info(`Run folder: ${result.files.runDir}`);
    logger.info(`Files: results.csv, summary.md, ${result.files.diffs.length} diff file(s)${args.suggestMistakes ? `, ${result.files.drafts.length} mistakes draft(s)` : ''}, raw/ (model outputs; private)`);
    for (const file of result.files.drafts) logger.info(`  draft: ${path.basename(file)}`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { logger.error(error.message); logger.info('Run with --help for usage.'); return 2; }
    if (error instanceof guards.GuardError) { logger.error(error.message); return 2; }
    if (error instanceof dataset.DatasetError || error instanceof RunError) { logger.error(error.message); return 1; }
    logger.error(`Unexpected failure: ${error?.message || 'unknown error'}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { HELP, UsageError, parseArgs, main };
