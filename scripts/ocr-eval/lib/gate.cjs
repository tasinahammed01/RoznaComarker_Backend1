'use strict';
/**
 * Acceptance gate for a candidate OCR design, computed from results.csv files only (numbers and photo names; never
 * raw outputs or ground-truth text). Every arm is run twice; the candidate passes only if EACH of its runs passes.
 *
 *   ROUTING  every row measured at production routing (sort=latency)
 *   G1  mean CER (case-sensitive) <= plain + 0.5 points        G2  same for WER
 *   G3  no photo more than 3 points worse than plain, for CER (G3-CER) and for WER (G3-WER)
 *   G4  every page under 30 s
 *   G5  every photo succeeded and produced production evidence (accepted, or rejected only as unreadable)
 *   G6  pages rejected as unreadable: no more than production today, and none that plain read at under 5% CER
 *   G7  no photo loses more than 2 words compared with plain (word deletions)
 *   G8  over-correction rate not worse than plain (n/a until mistakes lists exist)
 *   G9  one call per page, and cost per page no higher than production today (or an explicit --cost-ceiling)
 *   G10 no crossed-out phrase from a photo's struck list appears in the answer                (absolute, not relative to plain)
 *   G11 no line of a photo's copied question appears in the answer                            (absolute, not relative to plain)
 * G10/G11 need the candidate's leak columns; photos without a struck/question file are not counted. A candidate may be
 * measured at sort=latency or with a pinned provider (for example Gemini on one provider); baselines stay at sort=latency.
 * The plain baseline is the per-photo mean over its runs; "production today" is the mean over the production runs.
 */
const { naturalCompare } = require('./dataset.cjs');

const LIMITS = Object.freeze({ meanDelta: 0.005, photoDelta: 0.03, latencyMs: 30000, deletionDelta: 2, plainRejectCer: 0.05, callsPerPage: 1, runsPerArm: 2 });
const REJECTIONS = new Set(['OCR_GPT_SOURCE_UNCERTAIN', 'OCR_GPT_SOURCE_EMPTY']); // production's "upload a clearer image" outcomes
const EPS = 1e-9;

class GateError extends Error {}

const num = value => (value === undefined || value === null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const mean = values => { const v = values.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = v => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const pts = v => (v === null ? 'n/a' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)} pts`);

function selectRows(run, { model, variant }) {
  let rows = run.rows;
  if (model) rows = rows.filter(r => r.model === model);
  if (variant) rows = rows.filter(r => r.variant === variant);
  const models = new Set(rows.map(r => r.model)), variants = new Set(rows.map(r => r.variant));
  if (models.size > 1 || variants.size > 1) {
    throw new GateError(`${run.name} contains several models or variants (${[...models].join(', ')} / ${[...variants].join(', ')}). Choose one with --model and --variant.`);
  }
  if (!rows.length) throw new GateError(`${run.name} has no rows${model || variant ? ' for the chosen model and variant' : ''}.`);
  return { name: run.name, rows };
}

function pooledOvercorrection(rows) {
  const listed = rows.reduce((s, r) => s + (num(r.mistakes_listed) || 0), 0), over = rows.reduce((s, r) => s + (num(r.overcorrected) || 0), 0);
  return { listed, over, rate: listed ? over / listed : null };
}

/** Leak columns: { measured, leaked, phrases } over the rows that have a list; columns missing from the file = not measured. */
function leakTotals(rows, phrasesColumn, leakedColumn) {
  if (rows.some(r => r[phrasesColumn] === undefined || r[leakedColumn] === undefined)) return { missingColumns: true, leakedPhotos: [], leaked: 0, phrases: 0, photos: 0 };
  const measured = rows.filter(r => num(r[phrasesColumn]) !== null);
  const leakedPhotos = measured.filter(r => (num(r[leakedColumn]) || 0) > 0);
  return { missingColumns: false, leakedPhotos: leakedPhotos.map(r => r.photo), leaked: measured.reduce((s, r) => s + (num(r[leakedColumn]) || 0), 0),
    phrases: measured.reduce((s, r) => s + (num(r[phrasesColumn]) || 0), 0), photos: measured.length };
}

function evaluateGate({ baselines, candidates, productions = [], model = null, variant = null, costCeiling = null, excludePhotos = [] }) {
  const pick = runs => runs.map(run => selectRows(run, { model, variant }));
  const all = { B: pick(baselines), C: pick(candidates), P: pick(productions) };
  // Photos with incomplete ground truth: reported on their own, never part of the verdict.
  const excluded = [...new Set(excludePhotos)];
  const known = new Set(Object.values(all).flat().flatMap(run => run.rows.map(r => r.photo)));
  for (const photo of excluded) if (!known.has(photo)) throw new GateError(`--exclude-photos names ${photo}, which is not in any of the runs.`);
  const keep = runs => runs.map(run => ({ name: run.name, rows: run.rows.filter(r => !excluded.includes(r.photo)) }));
  const B = keep(all.B), C = keep(all.C), P = keep(all.P);
  if ([...B, ...C, ...P].some(run => !run.rows.length)) throw new GateError('No photos are left after --exclude-photos.');
  const meanReading = (runs, photo) => {
    const rows = runs.map(run => run.rows.find(r => r.photo === photo)).filter(r => r?.status === 'ok');
    return { cer: mean(rows.map(r => num(r.cer_case))), wer: mean(rows.map(r => num(r.wer_case))) };
  };
  const incomplete = excluded.map(photo => ({ photo, plain: meanReading(all.B, photo), production: all.P.length ? meanReading(all.P, photo) : null,
    candidates: all.C.map(run => { const r = run.rows.find(x => x.photo === photo); return { run: run.name, cer: r?.status === 'ok' ? num(r.cer_case) : null, wer: r?.status === 'ok' ? num(r.wer_case) : null }; }) }));
  const problems = [];
  for (const [label, runs] of [['plain baseline', B], ['candidate', C], ['production', P]]) {
    if (runs.length < LIMITS.runsPerArm) problems.push(`${label}: ${runs.length} run(s) given; each arm must be run ${LIMITS.runsPerArm} times.`);
  }
  for (const run of [...B, ...P]) {
    if (run.rows.some(r => r.sort !== 'latency')) problems.push(`${run.name}: not measured at production routing (sort=latency).`);
  }
  for (const run of B) if (run.rows.some(r => r.status !== 'ok')) problems.push(`${run.name}: the plain baseline has failed or skipped calls; re-run it.`);

  // Plain baseline per photo (photos present and ok in every baseline run).
  const rowOf = (run, photo) => run.rows.find(r => r.photo === photo);
  const photos = [...new Set(B.flatMap(run => run.rows.map(r => r.photo)))]
    .filter(photo => B.every(run => rowOf(run, photo)?.status === 'ok')).sort(naturalCompare);
  const base = new Map(photos.map(photo => {
    const rows = B.map(run => rowOf(run, photo));
    const deletions = rows.map(r => num(r.deletions));
    return [photo, { cer: mean(rows.map(r => num(r.cer_case))), wer: mean(rows.map(r => num(r.wer_case))), deletions: deletions.every(Number.isFinite) ? mean(deletions) : null }];
  }));
  const baseCer = mean(photos.map(p => base.get(p).cer)), baseWer = mean(photos.map(p => base.get(p).wer));
  const baseOc = pooledOvercorrection(B.flatMap(run => run.rows));
  const prodRejections = P.length ? mean(P.map(run => run.rows.filter(r => r.status === 'ok' && REJECTIONS.has(r.validation)).length)) : null;
  const prodCost = P.length ? mean(P.map(run => mean(run.rows.filter(r => r.status === 'ok').map(r => num(r.cost_usd))))) : null;

  const runs = C.map(run => {
    const checks = [];
    const add = (id, title, status, value, limit, detail = '') => checks.push({ id, title, status, value, limit, detail });
    const byPhoto = new Map(run.rows.map(r => [r.photo, r]));
    const ok = photos.map(p => byPhoto.get(p)).filter(r => r?.status === 'ok');

    // A candidate may run at sort=latency or on a deliberately pinned provider (its own production routing).
    const offRoute = run.rows.filter(r => r.sort !== 'latency' && !r.pinned_provider);
    const pinned = run.rows.filter(r => r.sort !== 'latency' && r.pinned_provider);
    add('ROUTING', 'Measured at production routing', offRoute.length ? 'FAIL' : 'PASS',
      pinned.length ? `${pinned.length}/${run.rows.length} rows on a pinned provider (${[...new Set(pinned.map(r => r.pinned_provider))].join(', ')})` : `${run.rows.length - offRoute.length}/${run.rows.length} rows sort=latency`,
      'sort=latency or a pinned provider', offRoute.length ? 'sort=latency or --provider required (production routing)' : '');

    for (const [id, column, baseValue, label] of [['G1', 'cer_case', baseCer, 'Mean CER (case-sensitive)'], ['G2', 'wer_case', baseWer, 'Mean WER (case-sensitive)']]) {
      const value = mean(ok.map(r => num(r[column])));
      const delta = value === null || baseValue === null ? null : value - baseValue;
      add(id, label, delta === null ? 'FAIL' : delta <= LIMITS.meanDelta + EPS ? 'PASS' : 'FAIL', `${pct(value)} vs plain ${pct(baseValue)} (${pts(delta)})`, '<= +0.50 pts');
    }
    for (const [id, column, key, label] of [['G3-CER', 'cer_case', 'cer', 'Worst photo, CER'], ['G3-WER', 'wer_case', 'wer', 'Worst photo, WER']]) {
      const deltas = ok.map(r => ({ photo: r.photo, delta: num(r[column]) - base.get(r.photo)[key] })).filter(d => Number.isFinite(d.delta)).sort((a, b) => b.delta - a.delta);
      const over = deltas.filter(d => d.delta > LIMITS.photoDelta + EPS);
      add(id, label, deltas.length && !over.length ? 'PASS' : 'FAIL', deltas.length ? `${deltas[0].photo} ${pts(deltas[0].delta)}` : 'n/a', '<= +3.00 pts per photo',
        over.length ? `over the limit: ${over.map(d => `${d.photo} ${pts(d.delta)}`).join(', ')}` : '');
    }
    const latencies = run.rows.filter(r => r.status === 'ok').map(r => num(r.latency_ms)).filter(Number.isFinite);
    const slowest = latencies.length ? Math.max(...latencies) : null;
    add('G4', 'Slowest page', slowest === null ? 'INCOMPLETE' : slowest < LIMITS.latencyMs ? 'PASS' : 'FAIL', slowest === null ? 'n/a' : `${(slowest / 1000).toFixed(1)} s`, '< 30 s every page');

    const missing = photos.filter(p => !byPhoto.has(p));
    const failed = photos.map(p => byPhoto.get(p)).filter(r => r && r.status !== 'ok');
    const invalid = ok.filter(r => r.validation !== 'accepted' && !REJECTIONS.has(r.validation));
    const g5Problems = [...missing.map(p => `${p}: missing`), ...failed.map(r => `${r.photo}: ${r.status} ${r.error_code || ''}`.trim()),
      ...invalid.map(r => `${r.photo}: ${r.validation ? `invalid evidence (${r.validation})` : 'no production evidence'}`)];
    add('G5', 'Valid production evidence', g5Problems.length ? 'FAIL' : 'PASS', `${ok.length - invalid.length}/${photos.length} photos`, 'all photos', g5Problems.join('; '));

    const rejected = ok.filter(r => REJECTIONS.has(r.validation));
    const easyRejected = rejected.filter(r => base.get(r.photo).cer < LIMITS.plainRejectCer);
    if (prodRejections === null) add('G6', 'Pages rejected as unreadable', 'INCOMPLETE', `${rejected.length}`, 'needs production runs', 'give --production runs');
    else {
      const tooMany = rejected.length > prodRejections + EPS;
      add('G6', 'Pages rejected as unreadable', tooMany || easyRejected.length ? 'FAIL' : 'PASS', `${rejected.length} (production ${prodRejections.toFixed(1)})`,
        '<= production, none plain read at < 5% CER',
        [tooMany ? 'more rejections than production' : '', easyRejected.length ? `rejected although plain read it well: ${easyRejected.map(r => r.photo).join(', ')}` : ''].filter(Boolean).join('; '));
    }

    const missingDeletions = [...B.filter(b => b.rows.some(r => num(r.deletions) === null)).map(b => b.name), ...(ok.some(r => num(r.deletions) === null) ? [run.name] : [])];
    if (missingDeletions.length) add('G7', 'Words lost vs plain', 'INCOMPLETE', 'n/a', '<= +2 words per photo', `deletion counts missing in ${missingDeletions.join(', ')}; run --rescore <run> to add them`);
    else {
      const deltas = ok.map(r => ({ photo: r.photo, delta: num(r.deletions) - base.get(r.photo).deletions })).sort((a, b) => b.delta - a.delta);
      const over = deltas.filter(d => d.delta > LIMITS.deletionDelta + EPS);
      add('G7', 'Words lost vs plain', over.length ? 'FAIL' : 'PASS', deltas.length ? `${deltas[0].photo} ${deltas[0].delta > 0 ? '+' : ''}${deltas[0].delta.toFixed(1)} words` : 'n/a', '<= +2 words per photo',
        over.length ? `over the limit: ${over.map(d => d.photo).join(', ')}` : '');
    }

    const candOc = pooledOvercorrection(ok);
    if (!baseOc.listed && !candOc.listed) add('G8', 'Over-correction', 'N/A', 'no mistakes lists', 'not worse than plain');
    else if (!baseOc.listed || !candOc.listed) add('G8', 'Over-correction', 'INCOMPLETE', 'n/a', 'not worse than plain', 'mistakes lists missing in one arm');
    else add('G8', 'Over-correction', candOc.rate <= baseOc.rate + EPS ? 'PASS' : 'FAIL', `${pct(candOc.rate)} vs plain ${pct(baseOc.rate)}`, 'not worse than plain');

    const calls = run.rows.map(r => num(r.calls_per_page));
    const cost = mean(ok.map(r => num(r.cost_usd)));
    let g9 = 'PASS';
    const g9Detail = [];
    if (calls.some(c => c === null)) { g9 = 'INCOMPLETE'; g9Detail.push('calls_per_page missing'); }
    else if (calls.some(c => c > LIMITS.callsPerPage)) { g9 = 'FAIL'; g9Detail.push('more than one call per page'); }
    const costLimit = costCeiling !== null ? costCeiling : prodCost;
    if (cost === null || costLimit === null) { if (g9 !== 'FAIL') g9 = 'INCOMPLETE'; g9Detail.push(cost === null ? 'cost missing' : 'needs production runs'); }
    else if (cost > costLimit + EPS) { g9 = 'FAIL'; g9Detail.push(costCeiling !== null ? 'above the cost ceiling' : 'more expensive than production'); }
    add('G9', 'Calls and cost per page', g9, `${calls.every(Number.isFinite) ? Math.max(...calls) : 'n/a'} call(s), $${cost === null ? 'n/a' : cost.toFixed(5)} vs ${costCeiling !== null ? 'ceiling' : 'production'} $${costLimit === null ? 'n/a' : costLimit.toFixed(5)}`,
      costCeiling !== null ? `1 call, <= cost ceiling $${costCeiling}` : '1 call, <= production cost', g9Detail.join('; '));

    // G10 / G11: question or crossed-out text must never reach the graded answer. Absolute, so no baseline is involved.
    // G10 is judged on REAL extra words (struck_real_leaked); the old count (any extra occurrence) is printed beside it but does not decide.
    for (const [id, title, phrasesColumn, leakedColumn, what] of [['G10', 'Crossed-out text in the answer', 'struck_phrases', 'struck_real_leaked', 'crossed-out phrase'],
      ['G11', 'Question text in the answer', 'question_phrases', 'question_leaked', 'question line']]) {
      const totals = leakTotals(run.rows, phrasesColumn, leakedColumn);
      const oldCount = id === 'G10' ? leakTotals(run.rows, 'struck_phrases', 'struck_leaked') : null;
      if (totals.missingColumns) add(id, title, 'INCOMPLETE', 'n/a', `0 leaked ${what}s`, `this results.csv has no ${leakedColumn} column; run --rescore <run> with the sidecar files in place`);
      else if (!totals.photos) add(id, title, 'N/A', `no ${what} files`, `0 leaked ${what}s`);
      else if (id === 'G10') {
        add(id, title, totals.leaked ? 'FAIL' : 'PASS',
          `real extra words: ${totals.leaked} of ${totals.phrases} ${what}s; old gate count: ${oldCount.missingColumns ? 'n/a' : `${oldCount.leaked} of ${oldCount.phrases}`} (${totals.photos} photos)`,
          '0 real extra words (the verdict uses real extra words)', totals.leaked ? `real extra words in: ${totals.leakedPhotos.join(', ')}` : '');
      } else add(id, title, totals.leaked ? 'FAIL' : 'PASS', `${totals.leaked} leaked of ${totals.phrases} ${what}s (${totals.photos} photos)`, `0 leaked ${what}s`,
        totals.leaked ? `leaked in: ${totals.leakedPhotos.join(', ')}` : '');
    }

    const verdict = checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS';
    return { name: run.name, verdict, checks };
  });

  // Production's own G10 / G11 / G8 numbers on the very photos that decide the verdict, for comparison only (never part of the verdict).
  const side = run => {
    const ok = run.rows.filter(r => r.status === 'ok'), g10 = leakTotals(ok, 'struck_phrases', 'struck_real_leaked'), g10Count = leakTotals(ok, 'struck_phrases', 'struck_leaked');
    const g11 = leakTotals(ok, 'question_phrases', 'question_leaked'), oc = pooledOvercorrection(ok);
    const cell = totals => (totals.missingColumns ? null : { leaked: totals.leaked, phrases: totals.phrases });
    return { run: run.name, g10: cell(g10), g10Count: cell(g10Count), g11: cell(g11), g8: { overcorrected: oc.over, listed: oc.listed } };
  };
  const comparison = { production: P.map(side), candidates: C.map(side) };

  const verdict = problems.length ? 'INCOMPLETE' : runs.some(r => r.verdict === 'FAIL') ? 'FAIL' : runs.some(r => r.verdict === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS';
  return { verdict, problems, photos, excluded, incomplete, comparison, costCeiling, baseline: { runs: B.map(r => r.name), cer: baseCer, wer: baseWer }, production: { runs: P.map(r => r.name), rejections: prodRejections, cost: prodCost }, runs };
}

// G8 (student mistakes preserved), G10 (no crossed-out text in the graded text) and G11 (no question in it) protect what grading sees:
// a failure of any of them means production must not be switched, whatever else passed. Says so in plain words.
const BLOCKING_CHECKS = Object.freeze(['G8', 'G10', 'G11']);
function switchDecision(result) {
  const failing = result.runs.flatMap(run => run.checks.filter(c => BLOCKING_CHECKS.includes(c.id) && c.status === 'FAIL').map(c => `${c.id} in ${run.name}`));
  if (failing.length) {
    return [`**DO NOT SWITCH PRODUCTION: ${failing.join('; ')} failed.**`, '',
      'G10 and G11 mean crossed-out text or the copied question reached the text that is graded; G8 means student mistakes were silently corrected.'];
  }
  if (result.verdict === 'FAIL') return ['**Do not switch: the gate failed** (see the checks above).'];
  if (result.verdict === 'INCOMPLETE') return ['**Not decided:** the inputs are incomplete (see "Problems" or the INCOMPLETE checks). Do not switch on this report.'];
  const unjudged = BLOCKING_CHECKS.filter(id => result.runs.some(run => run.checks.find(c => c.id === id)?.status !== 'PASS'));
  if (unjudged.length) return [`Passed, but ${unjudged.join(', ')} could not be judged (no mistakes, question or crossed-out lists for the photos in the verdict), so the pass says nothing about them.`];
  return ['All checks passed in both runs, including G8, G10 and G11.'];
}

function incompleteSection(result) {
  if (!result.excluded?.length) return [];
  const heads = result.incomplete[0].candidates.map(c => c.run), cell = r => `${pct(r.cer)} / ${pct(r.wer)}`;
  return ['## Photos with incomplete ground truth (reported only; not part of the verdict)', '',
    `| Photo | Plain (CER / WER) | ${heads.join(' | ')}${result.incomplete[0].production ? ' | Production' : ''} |`, `|---|---|${heads.map(() => '---|').join('')}${result.incomplete[0].production ? '---|' : ''}`,
    ...result.incomplete.map(row => `| ${row.photo} | ${cell(row.plain)} | ${row.candidates.map(cell).join(' | ')}${row.production ? ` | ${cell(row.production)}` : ''} |`),
    '', 'Their ground truth leaves out unreadable scribbles or white-out, so a high error rate here may be the ground truth, not the reader. Case-sensitive CER / WER.', ''];
}

function comparisonSection(result) {
  if (!result.comparison?.production.length) return [];
  const leak = cell => (cell === null ? 'n/a (run --rescore)' : cell.phrases ? `${cell.leaked} of ${cell.phrases}` : 'none');
  const mistakes = g8 => (g8.listed ? `${g8.overcorrected} of ${g8.listed}` : 'none');
  const row = (item, arm) => `| ${item.run} | ${arm} | ${leak(item.g10)} | ${leak(item.g10Count)} | ${leak(item.g11)} | ${mistakes(item.g8)} |`;
  return ['## Production today and the candidate, same photos (for comparison; not part of the verdict)', '',
    '| Run | Arm | G10 real extra words (decides G10) | G10 old gate count (comparison only) | G11 question lines that leaked | G8 listed mistakes over-corrected |', '|---|---|---|---|---|---|',
    ...result.comparison.production.map(item => row(item, 'production')), ...result.comparison.candidates.map(item => row(item, 'candidate')), ''];
}

function renderGate(result) {
  const out = ['# OCR acceptance gate', '', `**Verdict: ${result.verdict}**`, '',
    `- Plain baseline: ${result.baseline.runs.join(', ') || 'none'} (mean CER ${pct(result.baseline.cer)}, WER ${pct(result.baseline.wer)}, ${result.photos.length} photos in the verdict)`,
    ...(result.excluded?.length ? [`- Left out of the verdict (incomplete ground truth): ${result.excluded.join(', ')}`] : []),
    '- G10 verdict: real extra words (the old gate count is shown for comparison)',
    `- Production today: ${result.production.runs.join(', ') || 'none'}`,
    ...(result.costCeiling !== null && result.costCeiling !== undefined ? [`- Cost ceiling for G9: $${result.costCeiling} per page (given explicitly; replaces "no more than production")`] : []), ''];
  if (result.problems.length) out.push('## Problems with the inputs', '', ...result.problems.map(p => `- ${p}`), '');
  for (const run of result.runs) {
    out.push(`## ${run.name}: ${run.verdict}`, '', '| Check | What | Value | Limit | Result | Detail |', '|---|---|---|---|---|---|');
    for (const c of run.checks) out.push(`| ${c.id} | ${c.title} | ${c.value} | ${c.limit} | ${c.status} | ${c.detail || ''} |`);
    out.push('');
  }
  out.push(...comparisonSection(result));
  out.push(...incompleteSection(result));
  out.push('Both runs of every arm must pass. Run-to-run noise between two plain runs was about 0.15 (CER) to 0.26 (WER) points.', '');
  out.push('## Switch decision', '', ...switchDecision(result), '');
  return out.join('\n');
}

module.exports = { LIMITS, REJECTIONS, GateError, evaluateGate, renderGate };
