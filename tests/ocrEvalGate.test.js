'use strict';
// Acceptance gate (G1-G9) and the CSV reader it uses. Synthetic results only; the gate never reads raw/ or text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('../scripts/ocr-eval/lib/gate.cjs');
const csv = require('../scripts/ocr-eval/lib/csv.cjs');
const report = require('../scripts/ocr-eval/lib/report.cjs');
const gateCli = require('../scripts/ocr-eval/gate.cjs');

const PHOTOS = Array.from({ length: 10 }, (_, i) => `image${i + 1}`);
const MODEL = 'qwen/qwen3.8-27b';
const row = (photo, over = {}) => ({ photo, model: MODEL, variant: 'original', status: 'ok', cer_case: '0.02', wer_case: '0.08', latency_ms: '2000',
  sort: 'latency', validation: '', deletions: '1', mistakes_listed: '0', overcorrected: '0', calls_per_page: '1', cost_usd: '0.001', prompt_mode: 'plain', ...over });
const runOf = (name, over = () => ({})) => ({ name, rows: PHOTOS.map((photo, i) => row(photo, over(photo, i))) });
const baselines = (over) => [runOf('plain-1', over), runOf('plain-2', over)];
const productions = (over = () => ({})) => [1, 2].map(n => runOf(`prod-${n}`, (p, i) => ({ prompt_mode: 'production', validation: 'accepted', cost_usd: '0.003', ...over(p, i) })));
const candidate = (name, over = () => ({})) => runOf(name, (p, i) => ({ prompt_mode: 'plain-first', validation: 'accepted', ...over(p, i) }));
const candidatesOf = (over) => [candidate('cand-1', over), candidate('cand-2', over)];
const at = (n, values) => (p, i) => (i === n ? values : {});
const evaluate = ({ cand = candidatesOf(), base = baselines(), prod = productions() } = {}) => gate.evaluateGate({ baselines: base, candidates: cand, productions: prod });
const check = (result, id, run = 0) => result.runs[run].checks.find(c => c.id === id);

describe('CSV reader', () => {
  test('reads quoted fields with commas, doubled quotes and line breaks, and empty cells', () => {
    expect(csv.parseCsv('a,b,c\r\n1,"x, ""y""\nz",\r\n2,plain,3\n')).toEqual([{ a: '1', b: 'x, "y"\nz', c: '' }, { a: '2', b: 'plain', c: '3' }]);
  });
  test('round-trips what the harness writes', () => {
    const rows = csv.parseCsv(report.toCsv([{ name: 'image1', model: MODEL, variant: 'original', errorDetail: 'He said "no", then left', cerCs: 0.0123 }]));
    expect(rows[0]).toMatchObject({ photo: 'image1', model: MODEL, error_detail: 'He said "no", then left', cer_case: '0.0123' });
  });
});

describe('acceptance gate', () => {
  test('a candidate that matches the plain baseline passes every check (G8 is n/a without mistakes lists)', () => {
    const result = evaluate();
    expect(result.verdict).toBe('PASS');
    for (const run of result.runs) {
      expect(run.verdict).toBe('PASS');
      expect(run.checks.filter(c => c.status !== 'PASS').map(c => [c.id, c.status])).toEqual([['G8', 'N/A']]);
    }
  });
  test('G1 mean CER: +0.4 points passes, +0.6 points fails', () => {
    expect(check(evaluate({ cand: candidatesOf(() => ({ cer_case: '0.024' })) }), 'G1').status).toBe('PASS');
    expect(check(evaluate({ cand: candidatesOf(() => ({ cer_case: '0.026' })) }), 'G1').status).toBe('FAIL');
  });
  test('G2 mean WER: +0.4 points passes, +0.6 points fails', () => {
    expect(check(evaluate({ cand: candidatesOf(() => ({ wer_case: '0.084' })) }), 'G2').status).toBe('PASS');
    expect(check(evaluate({ cand: candidatesOf(() => ({ wer_case: '0.086' })) }), 'G2').status).toBe('FAIL');
  });
  test('G3 per photo: CER and WER may each be at most 3 points worse than plain on any photo', () => {
    const cer = evaluate({ cand: candidatesOf(at(4, { cer_case: '0.051' })) });
    expect(check(cer, 'G1').status).toBe('PASS'); // the mean barely moves
    expect(check(cer, 'G3-CER').status).toBe('FAIL');
    expect(check(cer, 'G3-CER').detail).toContain('image5');
    expect(check(evaluate({ cand: candidatesOf(at(4, { cer_case: '0.05' })) }), 'G3-CER').status).toBe('PASS');
    expect(check(evaluate({ cand: candidatesOf(at(2, { wer_case: '0.111' })) }), 'G3-WER').status).toBe('FAIL');
  });
  test('G4 latency: every page under 30 s', () => {
    expect(check(evaluate({ cand: candidatesOf(at(0, { latency_ms: '29999' })) }), 'G4').status).toBe('PASS');
    expect(check(evaluate({ cand: candidatesOf(at(0, { latency_ms: '30500' })) }), 'G4').status).toBe('FAIL');
  });
  test('G5 valid evidence: every photo succeeds and yields production evidence; a readability rejection is not a G5 failure', () => {
    expect(check(evaluate({ cand: candidatesOf(at(1, { status: 'error' })) }), 'G5').status).toBe('FAIL');
    expect(check(evaluate({ cand: candidatesOf(at(1, { validation: 'OCR_GPT_SOURCE_SCHEMA' })) }), 'G5').status).toBe('FAIL');
    expect(check(evaluate({ cand: candidatesOf(() => ({ validation: '' })) }), 'G5').status).toBe('FAIL');
    const missing = candidatesOf(); missing.forEach(run => run.rows.pop());
    expect(check(evaluate({ cand: missing }), 'G5').status).toBe('FAIL');
    expect(check(evaluate({ cand: candidatesOf(at(1, { validation: 'OCR_GPT_SOURCE_UNCERTAIN' })) }), 'G5').status).toBe('PASS');
  });
  test('G6 rejections: no more than production, and never a page plain read at under 5% CER', () => {
    const prod = productions(at(3, { validation: 'OCR_GPT_SOURCE_UNCERTAIN' })); // production rejects 1 page per run
    const hardPage = baselines(at(6, { cer_case: '0.06' }));
    expect(check(evaluate({ prod, base: hardPage, cand: candidatesOf(at(6, { validation: 'OCR_GPT_SOURCE_UNCERTAIN', cer_case: '0.06' })) }), 'G6').status).toBe('PASS');
    expect(check(evaluate({ prod, cand: candidatesOf(at(6, { validation: 'OCR_GPT_SOURCE_UNCERTAIN' })) }), 'G6').status).toBe('FAIL'); // plain read it at 2%
    const two = candidatesOf((p, i) => (i === 6 || i === 7 ? { validation: 'OCR_GPT_SOURCE_UNCERTAIN' } : {}));
    expect(check(evaluate({ prod, base: baselines((p, i) => (i >= 6 ? { cer_case: '0.08' } : {})), cand: two }), 'G6').status).toBe('FAIL'); // 2 > 1
  });
  test('G7 lost words: at most 2 more deleted words than plain on any photo; missing counts point to --rescore', () => {
    expect(check(evaluate({ cand: candidatesOf(at(5, { deletions: '3' })) }), 'G7').status).toBe('PASS');
    expect(check(evaluate({ cand: candidatesOf(at(5, { deletions: '4' })) }), 'G7').status).toBe('FAIL');
    const old = evaluate({ base: baselines(() => ({ deletions: '' })) });
    expect(check(old, 'G7').status).toBe('INCOMPLETE');
    expect(check(old, 'G7').detail).toMatch(/--rescore/);
    expect(old.verdict).toBe('INCOMPLETE');
  });
  test('G8 over-correction: n/a without lists; with lists the candidate may not over-correct more than plain', () => {
    const lists = (over) => (p, i) => ({ mistakes_listed: '2', overcorrected: i === 0 ? over : '0' });
    expect(check(evaluate({ base: baselines(lists('1')), cand: candidatesOf(lists('1')) }), 'G8').status).toBe('PASS');
    expect(check(evaluate({ base: baselines(lists('1')), cand: candidatesOf(lists('2')) }), 'G8').status).toBe('FAIL');
  });
  test('G9 one call per page and no more expensive than production', () => {
    expect(check(evaluate({ cand: candidatesOf(() => ({ calls_per_page: '2' })) }), 'G9').status).toBe('FAIL');
    expect(check(evaluate({ cand: candidatesOf(() => ({ cost_usd: '0.004' })) }), 'G9').status).toBe('FAIL');
    expect(check(evaluate({ cand: candidatesOf(() => ({ cost_usd: '' })) }), 'G9').status).toBe('INCOMPLETE');
  });
  test('both candidate runs must pass: one failing run fails the gate', () => {
    const result = evaluate({ cand: [candidate('cand-1'), candidate('cand-2', () => ({ cer_case: '0.03' }))] });
    expect(result.runs.map(r => r.verdict)).toEqual(['PASS', 'FAIL']);
    expect(result.verdict).toBe('FAIL');
  });
  test('each arm must be run twice: a single run of any arm leaves the gate incomplete', () => {
    expect(evaluate({ cand: [candidate('cand-1')] }).verdict).toBe('INCOMPLETE');
    expect(evaluate({ base: [runOf('plain-1')] }).verdict).toBe('INCOMPLETE');
    const noProd = evaluate({ prod: [] });
    expect(noProd.verdict).toBe('INCOMPLETE');
    expect(check(noProd, 'G6').status).toBe('INCOMPLETE');
  });
  test('everything must be measured at production routing (sort=latency)', () => {
    const offCandidate = evaluate({ cand: candidatesOf(() => ({ sort: 'default' })) });
    expect(check(offCandidate, 'ROUTING').status).toBe('FAIL');
    expect(offCandidate.verdict).toBe('FAIL');
    const offBaseline = evaluate({ base: baselines(() => ({ sort: 'default' })) });
    expect(offBaseline.verdict).toBe('INCOMPLETE');
    expect(offBaseline.problems.join(' ')).toMatch(/plain-1.*sort=latency/);
  });
  test('a run with several models or variants needs --model/--variant', () => {
    const mixed = candidatesOf(); mixed[0].rows.push(row('image1', { model: 'other/model' }));
    expect(() => evaluate({ cand: mixed })).toThrow(gate.GateError);
    expect(gate.evaluateGate({ baselines: baselines(), candidates: mixed, productions: productions(), model: MODEL }).verdict).toBe('PASS');
  });
  test('the report lists every check per run and the verdict', () => {
    const text = gate.renderGate(evaluate({ cand: [candidate('cand-1'), candidate('cand-2', () => ({ cer_case: '0.03' }))] }));
    expect(text).toMatch(/Verdict: FAIL/);
    expect(text).toMatch(/\| G1 \|/);
    expect(text).toContain('cand-2');
  });
});

describe('gate CLI', () => {
  let dir;
  const header = Object.keys(row('x'));
  const writeRun = run => {
    fs.mkdirSync(path.join(dir, run.name), { recursive: true });
    fs.writeFileSync(path.join(dir, run.name, 'results.csv'), [header.join(','), ...run.rows.map(r => header.map(h => r[h]).join(','))].join('\r\n'));
  };
  const sink = () => { const chunks = []; return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') }; };
  const args = ['--baseline', 'plain-1,plain-2', '--production', 'prod-1,prod-2', '--candidate', 'cand-1,cand-2'];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-gate-'));
    [...baselines(), ...productions(), ...candidatesOf()].forEach(writeRun);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('exit 0 and a PASS report when the candidate passes', async () => {
    const out = sink();
    expect(await gateCli.main(args, { env: { OCR_EVAL_OUT: dir }, stdout: out, stderr: sink() })).toBe(0);
    expect(out.text()).toMatch(/Verdict: PASS/);
  });
  test('exit 1 when a check fails, and --out writes the report', async () => {
    writeRun(candidate('cand-2', () => ({ cer_case: '0.04' })));
    const file = path.join(dir, 'gate.md');
    expect(await gateCli.main([...args, '--out', file], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: sink() })).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/Verdict: FAIL/);
  });
  test('exit 2 for a missing run or missing arguments', async () => {
    const err = sink();
    expect(await gateCli.main(['--baseline', 'plain-1,plain-2', '--production', 'prod-1,prod-2', '--candidate', 'nope,cand-2'], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: err })).toBe(2);
    expect(err.text()).toMatch(/results\.csv not found for nope/);
    expect(await gateCli.main(['--baseline', 'plain-1'], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: sink() })).toBe(2);
  });
});
