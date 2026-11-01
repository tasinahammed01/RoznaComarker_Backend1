#!/usr/bin/env node
'use strict';
/**
 * Acceptance gate CLI. Reads ONLY <OCR_EVAL_OUT>/<run>/results.csv for each run (numbers and photo names).
 *
 *   node scripts/ocr-eval/gate.cjs --baseline <plain-1>,<plain-2> --production <prod-1>,<prod-2> --candidate <cand-1>,<cand-2>
 *        [--model qwen/qwen3.8-27b] [--variant original] [--out <file.md>]
 *
 * A run is a run id inside OCR_EVAL_OUT, or a path to a run folder or a results.csv file.
 * Exit code: 0 PASS, 1 FAIL, 2 INCOMPLETE, missing input or usage error.
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csv.cjs');
const { GateError, evaluateGate, renderGate } = require('./lib/gate.cjs');
const { DEFAULT_OUT } = require('./lib/runner.cjs');

const HELP = `OCR acceptance gate
  --baseline a,b      plain-prompt runs (the reference), measured at sort=latency
  --production c,d    current production-mode runs (for rejections and cost), measured at sort=latency
  --candidate e,f     the design under test
  --model ID          when a run contains several models
  --variant NAME      when a run contains several variants (normally: original)
  --out FILE          also write the report to FILE
Runs are read from OCR_EVAL_OUT (default backend/tmp/ocr-eval-results). Only results.csv is read.`;

function parseArgs(argv) {
  const args = { baseline: [], candidate: [], production: [], model: null, variant: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s, 2);
    if (flag === 'help') { args.help = true; continue; }
    if (!['baseline', 'candidate', 'production', 'model', 'variant', 'out'].includes(flag) || !argv[i].startsWith('--')) throw new GateError(`Unknown argument: ${argv[i]}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new GateError(`--${flag} needs a value.`);
    if (['baseline', 'candidate', 'production'].includes(flag)) args[flag].push(...value.split(',').map(s => s.trim()).filter(Boolean));
    else args[flag] = value;
  }
  if (!args.help && (!args.baseline.length || !args.candidate.length)) throw new GateError('--baseline and --candidate are required (and --production for G6 and G9).');
  return args;
}

function loadRun(ref, root) {
  const isPath = path.isAbsolute(ref) || ref.includes('/') || ref.includes('\\');
  const target = isPath ? path.resolve(ref) : path.join(root, ref);
  const file = target.toLowerCase().endsWith('.csv') ? target : path.join(target, 'results.csv');
  if (!fs.existsSync(file)) throw new GateError(`results.csv not found for ${ref} (${file}). If that run was interrupted, rebuild its reports with --rescore.`);
  return { name: target.toLowerCase().endsWith('.csv') ? path.basename(path.dirname(target)) : path.basename(target), rows: parseCsv(fs.readFileSync(file, 'utf8')) };
}

async function main(argv, io = {}) {
  const env = io.env ?? process.env, stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  try {
    const args = parseArgs(argv);
    if (args.help) { stdout.write(`${HELP}\n`); return 0; }
    const root = env.OCR_EVAL_OUT || DEFAULT_OUT;
    const load = refs => refs.map(ref => loadRun(ref, root));
    const result = evaluateGate({ baselines: load(args.baseline), candidates: load(args.candidate), productions: load(args.production), model: args.model, variant: args.variant });
    const text = renderGate(result);
    stdout.write(`${text}\n`);
    if (args.out) fs.writeFileSync(args.out, text);
    return result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2;
  } catch (error) {
    stderr.write(`ERROR: ${error instanceof GateError ? error.message : `Unexpected failure: ${error?.message || error}`}\n`);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { HELP, parseArgs, main };
