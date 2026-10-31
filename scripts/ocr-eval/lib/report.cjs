'use strict';
/**
 * Report writers. results.csv and summary.md contain numbers and names only. The diff files DO contain
 * student text and are meant to stay in the (outside-the-repo) output folder.
 */
const { alignTokens, isUncertainToken, normalizeText, tokenize, DEFAULT_WILDCARD_SPAN } = require('./metrics.cjs');
const { naturalCompare } = require('./dataset.cjs');

const safeName = model => String(model).replace(/[^A-Za-z0-9._-]+/g, '__');

// ---- CSV ---------------------------------------------------------------------------------------------------------

const oc = row => row.overcorrection;
const CSV_COLUMNS = Object.freeze([
  ['photo', r => r.name], ['model', r => r.model], ['variant', r => r.variant], ['source', r => r.source],
  ['status', r => r.status], ['error_code', r => r.errorCode], ['validation', r => r.validation],
  ['cer_case', r => r.cerCs], ['wer_case', r => r.werCs], ['cer_nocase', r => r.cerCi], ['wer_nocase', r => r.werCi],
  ['reference_words', r => r.referenceWords], ['uncertain_masked', r => r.uncertainMasked],
  ['mistakes_listed', r => oc(r)?.listed], ['preserved', r => oc(r)?.preserved], ['overcorrected', r => oc(r)?.overcorrected],
  ['misread', r => oc(r)?.misread], ['dropped', r => oc(r)?.dropped], ['overcorrection_rate', r => oc(r)?.overcorrectionRate],
  ['unlisted_substitutions', r => oc(r)?.unlistedSubstitutions?.count],
  ['cost_usd', r => r.costUsd], ['cost_source', r => r.costSource],
  ['prompt_tokens', r => r.promptTokens], ['completion_tokens', r => r.completionTokens], ['reasoning_tokens', r => r.reasoningTokens],
  ['reasoning_not_off', r => r.reasoningNotOff], ['latency_ms', r => r.latencyMs],
  ['provider', r => r.provider], ['returned_model', r => r.returnedModel], ['finish_reason', r => r.finishReason],
  ['temperature_sent', r => r.temperatureSent], ['reasoning_param_sent', r => r.reasoningParamSent],
  ['prompt_mode', r => r.promptMode], ['sort', r => r.sort], ['pinned_provider', r => r.pinnedProvider],
  ['image_bytes', r => r.imageBytes], ['image_width', r => r.imageWidth], ['image_height', r => r.imageHeight],
]);

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(([header]) => header).join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ---- Aggregation ---------------------------------------------------------------------------------------------------

const numeric = values => values.filter(v => Number.isFinite(v));
const meanOf = values => { const v = numeric(values); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const medianOf = values => {
  const v = numeric(values).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const sumOf = values => numeric(values).reduce((a, b) => a + b, 0);

function pooledOvercorrection(rows) {
  const usable = rows.filter(r => oc(r)?.available && oc(r).listed > 0);
  const listed = sumOf(usable.map(r => oc(r).listed)), over = sumOf(usable.map(r => oc(r).overcorrected));
  return { listed, overcorrected: over, rate: listed ? over / listed : null };
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.variant}`;
    if (!groups.has(key)) groups.set(key, { model: row.model, variant: row.variant, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(({ model, variant, rows: all }) => {
    const ok = all.filter(r => r.status === 'ok');
    const providers = new Map();
    for (const r of ok) providers.set(r.provider || 'unknown', (providers.get(r.provider || 'unknown') || 0) + 1);
    return {
      model, variant, calls: all.length, ok: ok.length, failed: all.length - ok.length,
      rejected: ok.filter(r => r.validation && r.validation !== 'accepted').length,
      truncated: ok.filter(r => r.truncated).length,
      reasoningFlagged: all.filter(r => r.reasoningNotOff).length,
      cerCs: meanOf(ok.map(r => r.cerCs)), werCs: meanOf(ok.map(r => r.werCs)),
      cerCi: meanOf(ok.map(r => r.cerCi)), werCi: meanOf(ok.map(r => r.werCi)),
      overcorrection: pooledOvercorrection(ok),
      costMean: meanOf(all.map(r => r.costUsd)), costKnown: numeric(all.map(r => r.costUsd)).length, costTotal: sumOf(all.map(r => r.costUsd)),
      latencyMean: meanOf(all.map(r => r.latencyMs)), latencyMedian: medianOf(all.map(r => r.latencyMs)),
      providers,
    };
  });
}

/** Paired by photo: only photos that succeeded for BOTH the original and the other variant. */
function pairedComparison(rows, model, variant) {
  const of = v => new Map(rows.filter(r => r.model === model && r.variant === v && r.status === 'ok').map(r => [r.name, r]));
  const base = of('original'), other = of(variant);
  const names = [...base.keys()].filter(name => other.has(name));
  const baseRows = names.map(n => base.get(n)), otherRows = names.map(n => other.get(n));
  const delta = pick => meanOf(names.map((_, i) => (Number.isFinite(pick(otherRows[i])) && Number.isFinite(pick(baseRows[i])) ? pick(otherRows[i]) - pick(baseRows[i]) : null)));
  return { n: names.length, dCer: delta(r => r.cerCs), dWer: delta(r => r.werCs),
    overcorrectionBase: pooledOvercorrection(baseRows), overcorrectionVariant: pooledOvercorrection(otherRows) };
}

function selectWorst(rows, count = 3) {
  const groups = new Map();
  for (const row of rows) {
    // A perfect result has nothing to show in a diff.
    if (row.status !== 'ok' || !Number.isFinite(row.cerCs) || row.cerCs === 0) continue;
    const key = `${row.model}\u0000${row.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap(list =>
    list.sort((a, b) => b.cerCs - a.cerCs || naturalCompare(a.name, b.name)).slice(0, count));
}

// ---- summary.md ------------------------------------------------------------------------------------------------------

const pct = (v, digits = 1) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(digits)}%`);
const signedPct = v => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`);
const money = v => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(v !== 0 && Math.abs(v) < 0.001 ? 5 : 4)}`);
const seconds = ms => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const ocText = o => (o.listed ? `${pct(o.rate)} (${o.overcorrected}/${o.listed})` : 'n/a');

function buildWarnings(rows, meta) {
  const warnings = [];
  const models = [...new Set(rows.map(r => r.model))];
  for (const model of models) {
    const own = rows.filter(r => r.model === model);
    const flagged = own.filter(r => r.reasoningNotOff);
    if (flagged.length) {
      warnings.push(`**${model}: reasoning was NOT off** on ${flagged.length}/${own.length} calls (reasoning tokens reported). Its latency, cost and accuracy are not comparable with non-reasoning runs. Examples: ${[...new Set(flagged.map(r => `${r.name}/${r.variant}`))].slice(0, 3).join(', ')}.`);
    }
    if (own.some(r => r.reasoningParamSent === false)) warnings.push(`${model}: the catalog says it has no reasoning control, so the reasoning parameter was not sent. Check the reasoning-token column.`);
    if (own.some(r => r.temperatureSent === false)) warnings.push(`${model}: the catalog says it does not accept temperature, so it ran at the provider default (not temperature 0).`);
    const errors = new Map();
    for (const r of own.filter(x => x.status !== 'ok')) errors.set(r.errorCode || 'ERROR', (errors.get(r.errorCode || 'ERROR') || 0) + 1);
    if (errors.size) warnings.push(`${model}: failed calls - ${[...errors].map(([code, n]) => `${code} x${n}`).join(', ')}.${errors.has('PARAMETER_REJECTED') ? ' PARAMETER_REJECTED means no provider of this model accepts one of the requested parameters (temperature, reasoning, structured output).' : ''}`);
    const okRows = own.filter(r => r.status === 'ok');
    const providers = new Set(okRows.map(r => r.provider || 'unknown'));
    if (providers.size > 1) warnings.push(`${model}: served by ${providers.size} different providers (${[...providers].join(', ')}). Results can differ by provider or quantization; pin one with --provider to test.`);
    if (okRows.length && providers.size === 1 && providers.has('unknown')) warnings.push(`${model}: the response did not report which provider served the call.`);
    const rejected = okRows.filter(r => r.validation && r.validation !== 'accepted');
    if (rejected.length) warnings.push(`${model}: the production validator would reject ${rejected.length}/${okRows.length} pages (${[...new Set(rejected.map(r => r.validation))].join(', ')}). They are still scored here.`);
    if (okRows.some(r => r.truncated)) warnings.push(`${model}: ${okRows.filter(r => r.truncated).length} output(s) were cut off by the token limit.`);
    const mismatch = okRows.filter(r => r.returnedModel && r.returnedModel !== model);
    if (mismatch.length) warnings.push(`${model}: ${mismatch.length} response(s) came from a different model id (${[...new Set(mismatch.map(r => r.returnedModel))].join(', ')}).`);
  }
  if (rows.some(r => r.status === 'ok' && !Number.isFinite(r.costUsd))) warnings.push('Some calls have no cost: the API did not report one and no --price was given. Cost columns skip them.');
  if (meta.stoppedEarly) warnings.push(`**Run stopped early:** ${meta.stoppedEarly}`);
  for (const w of meta.datasetWarnings || []) warnings.push(`Dataset: ${w}`);
  return warnings;
}

function renderSummary({ meta, rows }) {
  const groups = aggregate(rows);
  const out = [];
  out.push('# OCR evaluation summary', '');
  if (meta.mode === 'dry-run') {
    out.push('> **DRY RUN - simulated models.** Every number below is synthetic. It only shows the shape of the report; it says nothing about real models.', '');
  }
  out.push(`- Run: \`${meta.runId}\` (${meta.startedAt})`);
  out.push(`- Mode: ${meta.mode} | prompt: \`${meta.promptMode}\` | temperature 0 | reasoning requested off | sort: ${meta.sort || 'default'} | pinned provider: ${meta.provider || 'none'}`);
  out.push(`- Photos: ${meta.photoCount} | variants: ${meta.variants.join(', ')} | models: ${meta.models.join(', ')}`);
  out.push(`- Calls: ${rows.length} recorded (${meta.reusedCalls} reused from an earlier run) | cost this run: ${money(meta.totalCostUsd)} | [?] wildcard span: ${meta.wildcardSpan} words`, '');

  out.push('## Results (mean per photo)', '');
  out.push('| Model | Variant | OK / calls | CER (case) | WER (case) | CER (any case) | WER (any case) | Over-correction | Cost / page | Latency (mean) | Reasoning not off |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of groups) {
    out.push(`| ${g.model} | ${g.variant} | ${g.ok} / ${g.calls} | ${pct(g.cerCs)} | ${pct(g.werCs)} | ${pct(g.cerCi)} | ${pct(g.werCi)} | ${ocText(g.overcorrection)} | ${money(g.costMean)} | ${seconds(g.latencyMean)} | ${g.reasoningFlagged ? `**${g.reasoningFlagged}**` : '0'} |`);
  }
  out.push('', 'CER/WER: lower is better, averaged over photos whose call succeeded. "Case" is case-sensitive; "any case" ignores capitalisation. Over-correction: share of listed student mistakes that the model silently replaced with the correct form, pooled over photos with a mistakes list (n/a without one). Cost: from the API response where available.', '');

  const comparisons = [];
  for (const model of meta.models) {
    for (const variant of meta.variants.filter(v => v !== 'original')) {
      if (!rows.some(r => r.model === model && r.variant === variant)) continue;
      comparisons.push({ model, variant, ...pairedComparison(rows, model, variant) });
    }
  }
  if (comparisons.length) {
    out.push('## Does preprocessing help? (paired by photo, variant minus original)', '');
    out.push('| Model | Variant | Photos | Change in CER (case) | Change in WER (case) | Over-correction original -> variant | Verdict |', '|---|---|---|---|---|---|---|');
    for (const c of comparisons) {
      const verdict = !c.n ? 'no paired photos' : c.dCer <= -0.005 ? 'better' : c.dCer >= 0.005 ? 'worse' : 'no clear change';
      out.push(`| ${c.model} | ${c.variant} | ${c.n} | ${signedPct(c.dCer)} | ${signedPct(c.dWer)} | ${ocText(c.overcorrectionBase)} -> ${ocText(c.overcorrectionVariant)} | ${verdict} |`);
    }
    out.push('', 'Negative = fewer errors than the original. With a small photo set a difference under about one percentage point is within noise.', '');
  }

  const warnings = buildWarnings(rows, meta);
  out.push('## Warnings', '');
  out.push(...(warnings.length ? warnings.map(w => `- ${w}`) : ['- None.']), '');

  const providerLines = groups.filter(g => g.providers.size).map(g => `- ${g.model} / ${g.variant}: ${[...g.providers].map(([p, n]) => `${p} x${n}`).join(', ')}`);
  if (providerLines.length) out.push('## Serving provider per call', '', ...providerLines, '');
  return `${out.join('\n')}\n`;
}

// ---- diffs ---------------------------------------------------------------------------------------------------------------

const escapeMd = text => String(text).replace(/[\\|*_`~<>[\]]/g, ch => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : `\\${ch}`));
const bold = text => `**${escapeMd(text)}**`;

function renderDiff({ name, model, variant, groundTruth, output, cerCs, werCs, wildcardSpan = DEFAULT_WILDCARD_SPAN }) {
  const refTokens = tokenize(normalizeText(groundTruth)), hypTokens = tokenize(normalizeText(output));
  const { ops } = alignTokens(refTokens, hypTokens, { isWildcard: isUncertainToken, wildcardSpan });
  const cells = ops.map(op => {
    if (op.type === 'match') return { g: escapeMd(refTokens[op.ref]), m: escapeMd(hypTokens[op.hyp]), kind: null };
    if (op.type === 'sub') return { g: bold(refTokens[op.ref]), m: bold(hypTokens[op.hyp]), kind: 'Different word', gt: refTokens[op.ref], mt: hypTokens[op.hyp], at: op.ref };
    if (op.type === 'del') return { g: bold(refTokens[op.ref]), m: '∅', kind: 'Missing in model output', gt: refTokens[op.ref], mt: '', at: op.ref };
    if (op.type === 'ins') return { g: '∅', m: bold(hypTokens[op.hyp]), kind: 'Extra in model output', gt: '', mt: hypTokens[op.hyp], at: -1 };
    const consumed = hypTokens.slice(op.hypStart, op.hypEnd).join(' ');
    return { g: `_${escapeMd(refTokens[op.ref])}_`, m: consumed ? `_${escapeMd(consumed)}_` : '∅', kind: 'Uncertain in ground truth (ignored)', gt: refTokens[op.ref], mt: consumed, at: op.ref };
  });

  const out = [`# ${name} - ${model} - ${variant}`, '',
    '> Private: this file contains student text. Keep it outside the repository.', '',
    `CER (case-sensitive) ${pct(cerCs)} | WER (case-sensitive) ${pct(werCs)}. Differences are **bold**; ∅ = nothing; _italics_ = uncertain ground-truth region, ignored.`, '',
    '## Side by side (ground truth | model output)', '', '| Words | Ground truth | Model output |', '|---|---|---|'];
  const CHUNK = 10;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const slice = cells.slice(i, i + CHUNK);
    out.push(`| ${i + 1}-${i + slice.length} | ${slice.map(c => c.g).join(' ')} | ${slice.map(c => c.m).join(' ')} |`);
  }
  const different = cells.filter(c => c.kind);
  out.push('', `## Differences (${different.length})`, '');
  if (different.length) {
    out.push('| Kind | Ground truth | Model output | Context (ground truth) |', '|---|---|---|---|');
    for (const c of different) {
      const context = c.at >= 0 ? refTokens.slice(Math.max(0, c.at - 3), c.at + 4).join(' ') : '';
      out.push(`| ${c.kind} | ${escapeMd(c.gt)} | ${escapeMd(c.mt)} | ${escapeMd(context)} |`);
    }
  } else out.push('None.');
  return `${out.join('\n')}\n`;
}

module.exports = { safeName, CSV_COLUMNS, csvCell, toCsv, meanOf, medianOf, aggregate, pairedComparison, pooledOvercorrection,
  selectWorst, buildWarnings, renderSummary, renderDiff, pct, money };
