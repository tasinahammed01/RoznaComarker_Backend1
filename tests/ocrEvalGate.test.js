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
const row = (photo, over = {}) => {
  const result = { photo, model: MODEL, variant: 'original', status: 'ok', cer_case: '0.02', wer_case: '0.08', latency_ms: '2000',
    sort: 'latency', pinned_provider: '', validation: '', deletions: '1', mistakes_listed: '0', overcorrected: '0', calls_per_page: '1', cost_usd: '0.001', prompt_mode: 'plain',
    // Leak columns: empty = the run was scored but the photo has no sidecar list (G10/G11 not applicable).
    // struck_leaked is the old count (any extra occurrence); struck_real_leaked counts real extra words only. Unless a test says otherwise they are equal.
    question_phrases: '', question_leaked: '', struck_phrases: '', struck_leaked: '', struck_real_leaked: '', ...over };
  if (over.struck_leaked !== undefined && over.struck_real_leaked === undefined) result.struck_real_leaked = over.struck_leaked;
  return result;
};
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
      expect(run.checks.filter(c => c.status !== 'PASS').map(c => [c.id, c.status])).toEqual([['G8', 'N/A'], ['G10', 'N/A'], ['G11', 'N/A']]);
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
  test('G10 crossed-out text: any phrase of a struck list found in the answer fails; none leaked passes; no lists is n/a', () => {
    const lists = leaked => (p, i) => ({ struck_phrases: '1', struck_leaked: i === 2 ? leaked : '0' });
    const pass = check(evaluate({ cand: candidatesOf(lists('0')) }), 'G10');
    expect(pass.status).toBe('PASS');
    expect(pass.value).toMatch(/real extra words: 0 of 10/);
    const fail = check(evaluate({ cand: candidatesOf(lists('1')) }), 'G10');
    expect(fail.status).toBe('FAIL');
    expect(fail.detail).toContain('image3');
    expect(check(evaluate(), 'G10').status).toBe('N/A');
  });
  describe('G10 counts REAL extra words; the old gate count is always printed beside it', () => {
    const cands = (real, count) => candidatesOf((p, i) => ({ struck_phrases: '2', struck_leaked: i < count ? '1' : '0', struck_real_leaked: i < real ? '1' : '0' }));
    test('the verdict uses real extra words: a count-only "leak" (a word read differently elsewhere) does not fail G10', () => {
      const result = evaluate({ cand: cands(0, 3) });
      const g10 = check(result, 'G10');
      expect(g10.status).toBe('PASS');
      expect(g10.value).toMatch(/real extra words: 0 of 20/);
      expect(g10.value).toMatch(/old gate count: 3 of 20/);
      expect(g10.limit).toMatch(/verdict uses real extra words/i);
    });
    test('a real extra word fails G10 and names the photos, and both numbers are shown', () => {
      const result = evaluate({ cand: cands(2, 5) });
      const g10 = check(result, 'G10');
      expect(g10.status).toBe('FAIL');
      expect(g10.value).toMatch(/real extra words: 2 of 20/);
      expect(g10.value).toMatch(/old gate count: 5 of 20/);
      expect(g10.detail).toContain('image1');
      expect(g10.detail).toContain('image2');
      expect(g10.detail).not.toContain('image3');
    });
    test('the report says in words which of the two numbers decides', () => {
      expect(gate.renderGate(evaluate({ cand: cands(0, 3) }))).toMatch(/G10 verdict: real extra words \(the old gate count is shown for comparison\)/);
    });
    test('a results.csv from before the real count existed is incomplete and points to --rescore, never a silent fallback to the old count', () => {
      const old = candidatesOf((p, i) => ({ struck_phrases: '2', struck_leaked: '0' })); old.forEach(run => run.rows.forEach(r => { delete r.struck_real_leaked; }));
      const g10 = check(evaluate({ cand: old }), 'G10');
      expect(g10.status).toBe('INCOMPLETE');
      expect(g10.detail).toMatch(/--rescore/);
    });
  });
  test('G11 question text: any copied question line found in the answer fails', () => {
    const lists = leaked => (p, i) => ({ question_phrases: '2', question_leaked: i === 6 ? leaked : '0' });
    expect(check(evaluate({ cand: candidatesOf(lists('0')) }), 'G11').status).toBe('PASS');
    const fail = check(evaluate({ cand: candidatesOf(lists('2')) }), 'G11');
    expect(fail.status).toBe('FAIL');
    expect(fail.detail).toContain('image7');
    expect(check(evaluate(), 'G11').status).toBe('N/A');
  });
  test('G10/G11 are absolute: the plain baseline is not compared, and an old results.csv without the columns is incomplete, not skipped', () => {
    const old = candidatesOf(); old.forEach(run => run.rows.forEach(r => { delete r.struck_leaked; delete r.struck_real_leaked; delete r.struck_phrases; delete r.question_leaked; delete r.question_phrases; }));
    const result = evaluate({ cand: old });
    expect(check(result, 'G10').status).toBe('INCOMPLETE');
    expect(check(result, 'G10').detail).toMatch(/--rescore/);
    expect(check(result, 'G11').status).toBe('INCOMPLETE');
    expect(result.verdict).toBe('INCOMPLETE');
    // the baseline and production runs never need the columns
    const bare = baselines(); bare.forEach(run => run.rows.forEach(r => { delete r.struck_leaked; delete r.question_leaked; }));
    expect(evaluate({ base: bare }).verdict).toBe('PASS');
  });
  test('a failed photo does not hide a leak on the others, and a leak in one run fails the gate', () => {
    const leakyRun = candidate('cand-2', (p, i) => ({ struck_phrases: '1', struck_leaked: i === 0 ? '1' : '0' }));
    const result = evaluate({ cand: [candidate('cand-1', () => ({ struck_phrases: '1', struck_leaked: '0' })), leakyRun] });
    expect(result.runs.map(r => check(result, 'G10', result.runs.indexOf(r)).status)).toEqual(['PASS', 'FAIL']);
    expect(result.verdict).toBe('FAIL');
  });
  test('routing for a candidate may be a pinned provider instead of sort=latency; the baselines still need sort=latency', () => {
    const pinned = candidatesOf(() => ({ sort: 'default', pinned_provider: 'google-ai-studio' }));
    const result = evaluate({ cand: pinned });
    expect(check(result, 'ROUTING').status).toBe('PASS');
    expect(check(result, 'ROUTING').value).toMatch(/pinned provider/);
    expect(check(evaluate({ cand: candidatesOf(() => ({ sort: 'default', pinned_provider: '' })) }), 'ROUTING').status).toBe('FAIL');
    const pinnedBaseline = evaluate({ base: baselines(() => ({ sort: 'default', pinned_provider: 'x' })) });
    expect(pinnedBaseline.verdict).toBe('INCOMPLETE');
  });
  test('an explicit cost ceiling replaces "no more than production" in G9, and is shown in the report', () => {
    const dear = candidatesOf(() => ({ cost_usd: '0.006' }));
    expect(check(evaluate({ cand: dear }), 'G9').status).toBe('FAIL');
    const result = gate.evaluateGate({ baselines: baselines(), candidates: dear, productions: productions(), costCeiling: 0.01 });
    expect(check(result, 'G9').status).toBe('PASS');
    expect(check(result, 'G9').limit).toMatch(/0\.01/);
    expect(check(gate.evaluateGate({ baselines: baselines(), candidates: candidatesOf(() => ({ cost_usd: '0.012' })), productions: productions(), costCeiling: 0.01 }), 'G9').status).toBe('FAIL');
    expect(gate.renderGate(result)).toMatch(/cost ceiling/i);
  });
  test('a cost ceiling also lets the gate run without production runs for G9, but G6 still needs them', () => {
    const result = gate.evaluateGate({ baselines: baselines(), candidates: candidatesOf(), productions: [], costCeiling: 0.01 });
    expect(check(result, 'G9').status).toBe('PASS');
    expect(check(result, 'G6').status).toBe('INCOMPLETE');
  });
  describe('photos with incomplete ground truth', () => {
    const bad = (photoIndex, values) => candidatesOf(at(photoIndex, values));
    const withExclusion = (cand, excludePhotos) => gate.evaluateGate({ baselines: baselines(), candidates: cand, productions: productions(), excludePhotos });
    test('excluded photos never decide the verdict: a terrible reading of image5 fails the gate, unless image5 is excluded', () => {
      const cand = bad(4, { cer_case: '0.40', wer_case: '0.60', deletions: '30', struck_phrases: '1', struck_leaked: '1' });
      expect(evaluate({ cand }).verdict).toBe('FAIL');
      const result = withExclusion(cand, ['image5']);
      expect(result.verdict).toBe('PASS');
      expect(result.photos).not.toContain('image5');
      expect(result.photos).toHaveLength(9);
      expect(check(result, 'G10').status).toBe('N/A');           // the leak was on an excluded photo
    });
    test('their numbers are still reported, separately, with plain and every candidate run', () => {
      const result = withExclusion(bad(4, { cer_case: '0.40', wer_case: '0.60' }), ['image5', 'image7']);
      expect(result.excluded).toEqual(['image5', 'image7']);
      const row = result.incomplete.find(r => r.photo === 'image5');
      expect(row.plain).toEqual({ cer: 0.02, wer: 0.08 });
      expect(row.candidates).toEqual([{ run: 'cand-1', cer: 0.4, wer: 0.6 }, { run: 'cand-2', cer: 0.4, wer: 0.6 }]);
      const text = gate.renderGate(result);
      expect(text).toMatch(/incomplete ground truth/i);
      expect(text).toMatch(/not part of the verdict/i);
      expect(text).toMatch(/\| image5 \| 2\.00% \/ 8\.00% \| 40\.00% \/ 60\.00% \| 40\.00% \/ 60\.00% \|/);
    });
    test('a name that is in none of the runs is an error, never silently ignored; excluding every photo is an error', () => {
      expect(() => withExclusion(candidatesOf(), ['image99'])).toThrow(/image99/);
      expect(() => withExclusion(candidatesOf(), PHOTOS)).toThrow(gate.GateError);
    });
    test('baseline and production rows of excluded photos are ignored too', () => {
      const base = baselines(at(3, { status: 'error' }));         // the plain baseline failed on image4
      expect(gate.evaluateGate({ baselines: base, candidates: candidatesOf(), productions: productions() }).verdict).toBe('INCOMPLETE');
      expect(gate.evaluateGate({ baselines: base, candidates: candidatesOf(), productions: productions(), excludePhotos: ['image4'] }).verdict).toBe('PASS');
    });
  });

  describe('production today next to the candidate', () => {
    const lists = (leaked, over) => (p, i) => ({ struck_phrases: '2', struck_leaked: i < leaked ? '1' : '0', question_phrases: '1', question_leaked: '1', mistakes_listed: '4', overcorrected: String(over) });
    const clean = () => ({ struck_phrases: '2', struck_leaked: '0', question_phrases: '1', question_leaked: '0', mistakes_listed: '4', overcorrected: '0' });
    test('production G10, G11 and G8 are computed on the same photos as the candidate and printed side by side', () => {
      const result = evaluate({ prod: productions(lists(3, 1)), cand: candidatesOf(clean) });
      expect(result.comparison.production).toEqual([
        { run: 'prod-1', g10: { leaked: 3, phrases: 20 }, g10Count: { leaked: 3, phrases: 20 }, g11: { leaked: 10, phrases: 10 }, g8: { overcorrected: 10, listed: 40 } },
        { run: 'prod-2', g10: { leaked: 3, phrases: 20 }, g10Count: { leaked: 3, phrases: 20 }, g11: { leaked: 10, phrases: 10 }, g8: { overcorrected: 10, listed: 40 } }]);
      expect(result.comparison.candidates[0]).toEqual({ run: 'cand-1', g10: { leaked: 0, phrases: 20 }, g10Count: { leaked: 0, phrases: 20 }, g11: { leaked: 0, phrases: 10 }, g8: { overcorrected: 0, listed: 40 } });
      const text = gate.renderGate(result);
      expect(text).toMatch(/## Production today and the candidate, same photos/);
      // columns: G10 real extra words | G10 old gate count | G11 | G8
      expect(text).toMatch(/\| prod-1 \| production \| 3 of 20 \| 3 of 20 \| 10 of 10 \| 10 of 40 \|/);
      expect(text).toMatch(/\| cand-1 \| candidate \| 0 of 20 \| 0 of 20 \| 0 of 10 \| 0 of 40 \|/);
    });
    test('excluded photos are left out of production\'s numbers too, so both sides cover the same photos', () => {
      const result = gate.evaluateGate({ baselines: baselines(), candidates: candidatesOf(clean), productions: productions(lists(10, 1)), excludePhotos: ['image1', 'image2'] });
      expect(result.comparison.production[0]).toMatchObject({ g10: { leaked: 8, phrases: 16 }, g11: { leaked: 8, phrases: 8 }, g8: { overcorrected: 8, listed: 32 } });
    });
    test('production\'s two G10 numbers are printed separately: real extra words, and the old gate count', () => {
      const prod = productions((p, i) => ({ struck_phrases: '2', struck_leaked: i < 4 ? '1' : '0', struck_real_leaked: i < 1 ? '1' : '0' }));
      const result = evaluate({ prod });
      expect(result.comparison.production[0]).toMatchObject({ g10: { leaked: 1, phrases: 20 }, g10Count: { leaked: 4, phrases: 20 } });
      expect(gate.renderGate(result)).toMatch(/\| prod-1 \| production \| 1 of 20 \| 4 of 20 \|/);
    });
    test('a production results.csv without the leak columns says so instead of printing zeros', () => {
      const old = productions(); old.forEach(run => run.rows.forEach(r => { delete r.struck_phrases; delete r.struck_leaked; delete r.struck_real_leaked; delete r.question_phrases; delete r.question_leaked; }));
      const result = evaluate({ prod: old });
      expect(result.comparison.production[0].g10).toBeNull();
      expect(gate.renderGate(result)).toMatch(/\| prod-1 \| production \| n\/a \(run --rescore\) \| n\/a \(run --rescore\) \| n\/a \(run --rescore\) \|/);
      expect(result.verdict).toBe('PASS');                              // production's numbers are for comparison only
    });
    test('photos without lists print "none" rather than 0 of 0', () => {
      const result = evaluate();
      expect(gate.renderGate(result)).toMatch(/\| prod-1 \| production \| none \| none \| none \| none \|/);
    });
  });

  describe('switch decision', () => {
    const decision = result => gate.renderGate(result).split('## Switch decision')[1] || '';
    test('G10 failing says plainly not to switch, naming the check and the run', () => {
      const cand = [candidate('cand-1'), candidate('cand-2', (p, i) => ({ struck_phrases: '1', struck_leaked: i === 0 ? '1' : '0', question_phrases: '1', question_leaked: '0' }))];
      const text = decision(evaluate({ cand }));
      expect(text).toMatch(/DO NOT SWITCH PRODUCTION/);
      expect(text).toMatch(/G10 in cand-2/);
      expect(text).not.toMatch(/G10 in cand-1/);
    });
    test.each([['G11', { question_phrases: '1', question_leaked: '1' }], ['G8', { mistakes_listed: '2', overcorrected: '2' }]])('%s failing is a do-not-switch', (id, over) => {
      const lists = { mistakes_listed: '2', overcorrected: '0', struck_phrases: '1', struck_leaked: '0', question_phrases: '1', question_leaked: '0' };
      const result = evaluate({ base: baselines(() => lists), cand: candidatesOf(() => ({ ...lists, ...over })) });
      expect(check(result, id).status).toBe('FAIL');
      expect(decision(result)).toMatch(new RegExp(`DO NOT SWITCH PRODUCTION[^]*${id} in cand-1`));
    });
    test('a pass says so, and names every check that could not be judged', () => {
      expect(decision(evaluate())).toMatch(/G8, G10, G11 could not be judged/);
      const lists = { mistakes_listed: '2', overcorrected: '0', struck_phrases: '1', struck_leaked: '0', question_phrases: '1', question_leaked: '0' };
      const full = decision(evaluate({ base: baselines(() => lists), cand: candidatesOf(() => lists) }));
      expect(full).toMatch(/All checks passed in both runs/);
      expect(full).not.toMatch(/DO NOT SWITCH/);
    });
    test('another failing check, or missing inputs, is not a pass either', () => {
      expect(decision(evaluate({ cand: candidatesOf(() => ({ cer_case: '0.05' })) }))).toMatch(/Do not switch: the gate failed/);
      expect(decision(evaluate({ cand: [candidate('cand-1')] }))).toMatch(/Not decided/);
    });
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
  test('--exclude-photos removes photos from the verdict, reports them, and refuses unknown names', async () => {
    writeRun(candidate('cand-1', at(3, { cer_case: '0.40' }))); writeRun(candidate('cand-2', at(3, { cer_case: '0.40' })));
    expect(await gateCli.main(args, { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: sink() })).toBe(1);
    const out = sink();
    expect(await gateCli.main([...args, '--exclude-photos', 'image4, image9'], { env: { OCR_EVAL_OUT: dir }, stdout: out, stderr: sink() })).toBe(0);
    expect(out.text()).toMatch(/Verdict: PASS/);
    expect(out.text()).toMatch(/\| image4 \|/);
    const err = sink();
    expect(await gateCli.main([...args, '--exclude-photos', 'image44'], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: err })).toBe(2);
    expect(err.text()).toMatch(/image44/);
  });
  test('--cost-ceiling is parsed, applied, and must be a positive number', async () => {
    writeRun(candidate('cand-1', () => ({ cost_usd: '0.006' }))); writeRun(candidate('cand-2', () => ({ cost_usd: '0.006' })));
    expect(await gateCli.main(args, { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: sink() })).toBe(1);
    const out = sink();
    expect(await gateCli.main([...args, '--cost-ceiling', '0.01'], { env: { OCR_EVAL_OUT: dir }, stdout: out, stderr: sink() })).toBe(0);
    expect(out.text()).toMatch(/cost ceiling/i);
    for (const bad of ['0', '-1', 'abc']) {
      const err = sink();
      expect(await gateCli.main([...args, '--cost-ceiling', bad], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: err })).toBe(2);
      expect(err.text()).toMatch(/--cost-ceiling/);
    }
  });
  test('exit 2 for a missing run or missing arguments', async () => {
    const err = sink();
    expect(await gateCli.main(['--baseline', 'plain-1,plain-2', '--production', 'prod-1,prod-2', '--candidate', 'nope,cand-2'], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: err })).toBe(2);
    expect(err.text()).toMatch(/results\.csv not found for nope/);
    expect(await gateCli.main(['--baseline', 'plain-1'], { env: { OCR_EVAL_OUT: dir }, stdout: sink(), stderr: sink() })).toBe(2);
  });
});
