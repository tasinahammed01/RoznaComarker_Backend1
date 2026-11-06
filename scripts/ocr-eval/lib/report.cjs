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
  // Appended last so earlier columns keep their position in existing spreadsheets.
  ['http_status', r => r.httpStatus], ['error_detail', r => r.errorDetail], ['rejected_param', r => r.rejectedParam],
  ['may_be_billed', r => r.mayBeBilled], ['reasoning_mode', r => r.reasoningMode], ['reasoning_sent', r => r.reasoningSent],
  // Word-level (case-sensitive) edit counts behind wer_case; deletions = words lost.
  ['substitutions', r => r.substitutions], ['deletions', r => r.deletions], ['insertions', r => r.insertions],
  ['calls_per_page', r => r.callsPerPage], ['temperature_mode', r => r.temperatureMode],
  // Answer-only accuracy and leaks (empty = the photo has no answer/question/struck file). Counts only, never text.
  ['answer_cer_case', r => r.answerCerCs], ['answer_wer_case', r => r.answerWerCs],
  ['question_phrases', r => r.questionPhrases], ['question_leaked', r => r.questionLeaked],
  ['struck_phrases', r => r.struckPhrases], ['struck_leaked', r => r.struckLeaked],
  // What a verbatim-json reply reported about the page (counts), and reported cost against --price (1 = as expected).
  ['uncertain_flagged', r => r.uncertainFlagged], ['struck_reported', r => r.struckReported],
  ['question_lines_reported', r => r.questionLinesReported], ['name_present', r => r.namePresent],
  ['cost_price_ratio', r => r.costPriceRatio],
  ['uncertain_dropped', r => r.uncertainDropped],
  // struck_leaked is the old gate count (any extra occurrence); struck_real_leaked counts real extra words only and decides G10.
  ['struck_real_leaked', r => r.struckRealLeaked],
  ['struck_dropped', r => r.struckDropped],
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
      model, variant, calls: all.length, ok: ok.length, failed: all.filter(r => r.status === 'error').length,
      skipped: all.filter(r => r.status === 'skipped').length,
      rejected: ok.filter(r => r.validation && r.validation !== 'accepted').length,
      truncated: ok.filter(r => r.truncated).length,
      reasoningFlagged: all.filter(r => r.reasoningNotOff).length,
      cerCs: meanOf(ok.map(r => r.cerCs)), werCs: meanOf(ok.map(r => r.werCs)),
      cerCi: meanOf(ok.map(r => r.cerCi)), werCi: meanOf(ok.map(r => r.werCi)),
      overcorrection: pooledOvercorrection(ok),
      // Cost per page is the cost of pages that were read; failed calls (cost 0) must not dilute it.
      costMean: meanOf(ok.map(r => r.costUsd)), costKnown: numeric(all.map(r => r.costUsd)).length, costTotal: sumOf(all.map(r => r.costUsd)),
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
    if (own.some(r => r.reasoningParamSent === false && r.reasoningMode !== 'omit' && r.source !== 'skipped')) warnings.push(`${model}: the catalog says it has no reasoning control, so the reasoning parameter was not sent. Check the reasoning-token column.`);
    if (own.some(r => r.reasoningMode === 'omit')) warnings.push(`${model}: the reasoning parameter was omitted on request, so the model's own default applies. Check its reasoning tokens.`);
    if (own.some(r => r.temperatureSent === false && r.temperatureMode !== 'omit' && r.source !== 'skipped')) warnings.push(`${model}: the catalog says it does not accept temperature, so it ran at the provider default (not temperature 0).`);
    if (own.some(r => r.temperatureMode === 'omit')) warnings.push(`${model}: temperature omitted on request (--temperature omit), so the provider default sampling applies, as in production today.`);
    const errors = new Map();
    for (const r of own.filter(x => x.status === 'error')) errors.set(r.errorCode || 'ERROR', (errors.get(r.errorCode || 'ERROR') || 0) + 1);
    if (errors.size) warnings.push(`${model}: failed calls - ${[...errors].map(([code, n]) => `${code} x${n}`).join(', ')} (details under Failed calls).`);
    const skippedCount = own.filter(x => x.status === 'skipped').length;
    if (skippedCount) warnings.push(`${model}: ${skippedCount} call(s) were skipped after repeated failures or a rejected request, so its averages cover fewer photos.`);
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
  // Honest comparison: say so whenever models did not receive the same reasoning setting.
  const reasoningByModel = new Map();
  for (const r of rows.filter(x => x.source !== 'skipped' && x.imageBytes != null && x.reasoningSent)) {
    if (!reasoningByModel.has(r.model)) reasoningByModel.set(r.model, new Set());
    reasoningByModel.get(r.model).add(r.reasoningSent);
  }
  const profiles = new Set([...reasoningByModel.values()].map(set => [...set].sort().join(' / ')));
  if (profiles.size > 1) {
    warnings.push(`Models were run with different reasoning settings (${[...reasoningByModel].map(([m, set]) => `${m}: ${[...set].join(' / ')}`).join('; ')}). Compare accuracy with care, and do not compare cost or latency between reasoning-on and reasoning-off runs.`);
  }
  for (const model of models) {
    const off = rows.filter(r => r.model === model && Number.isFinite(r.costPriceRatio) && Math.abs(r.costPriceRatio - 1) > 0.15);
    if (off.length) {
      const ratios = off.map(r => r.costPriceRatio);
      warnings.push(`${model}: ${off.length} call(s) cost differently from tokens x the --price you gave (ratio ${Math.min(...ratios).toFixed(2)} to ${Math.max(...ratios).toFixed(2)}, 1 = as expected). A different pricing tier or provider may have served them; check the provider column and the Serving provider section.`);
    }
  }
  if (rows.some(r => r.status === 'ok' && !Number.isFinite(r.costUsd))) warnings.push('Some calls have no cost: the API did not report one and no --price was given. Cost columns skip them.');
  if (meta.stoppedEarly) warnings.push(`**Run stopped early:** ${meta.stoppedEarly}`);
  for (const w of meta.datasetWarnings || []) warnings.push(`Dataset: ${w}`);
  return warnings;
}

/** Failed and skipped calls, with the API's own error text (never student text). */
function failedCallsSection(rows) {
  const failed = rows.filter(r => r.status === 'error');
  const skipped = rows.filter(r => r.status === 'skipped');
  if (!failed.length && !skipped.length) return [];
  const out = ['## Failed calls', ''];
  const groups = new Map();
  for (const r of failed) {
    const key = [r.model, r.errorCode, r.httpStatus, r.rejectedParam, r.errorDetail].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    const r = list[0];
    out.push(`- **${r.model}** - ${r.errorCode}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''} x${list.length}${r.rejectedParam ? ` - rejected parameter: \`${r.rejectedParam}\`` : ''}${r.provider ? ` - provider: ${r.provider}` : ''}${r.errorDetail ? ` - "${r.errorDetail}"` : ''}`);
    if (r.errorCode === 'PARAMETER_REJECTED' && (!r.rejectedParam || r.rejectedParam.startsWith('reasoning'))) {
      out.push(`  - If reasoning is the cause, try \`--reasoning-for ${r.model}=low\` (or \`=omit\`) and compare the Request settings table.`);
    }
  }
  const skips = new Map();
  for (const r of skipped) { const key = `${r.model}\u0000${r.errorCode}`; skips.set(key, [...(skips.get(key) || []), r]); }
  for (const list of skips.values()) out.push(`- **${list[0].model}** - ${list.length} call(s) skipped (${list[0].errorCode}): ${list[0].errorDetail}`);
  const unknown = rows.filter(r => r.mayBeBilled);
  if (unknown.length) {
    out.push(`- ${unknown.length} call(s) ended without any response (timeout or network error) and may have been billed; their cost is not in the totals (${[...new Set(unknown.map(r => r.model))].join(', ')}).`);
  }
  return [...out, ''];
}

const JSON_MODES = Object.freeze(['production', 'production-trim', 'lean-json', 'verbatim-json', 'verbatim-json-v2', 'verbatim-json-v2-no14']);

/** Answer-only accuracy and leaks, per model and variant, for the photos that have the sidecar files. Counts and rates only. */
function answerSection(rows) {
  const groups = new Map();
  for (const row of rows.filter(r => r.status === 'ok')) {
    const key = `${row.model}\u0000${row.variant}`;
    if (!groups.has(key)) groups.set(key, { model: row.model, variant: row.variant, rows: [] });
    groups.get(key).rows.push(row);
  }
  const table = [...groups.values()].map(({ model, variant, rows: list }) => {
    const answers = list.filter(r => Number.isFinite(r.answerCerCs)), asked = list.filter(r => Number.isFinite(r.questionPhrases)), struck = list.filter(r => Number.isFinite(r.struckPhrases));
    if (!answers.length && !asked.length && !struck.length) return null;
    const total = (items, pick) => items.reduce((sum, r) => sum + (pick(r) || 0), 0);
    return `| ${model} | ${variant} | ${answers.length} | ${pct(meanOf(answers.map(r => r.answerCerCs)))} | ${pct(meanOf(answers.map(r => r.answerWerCs)))} | ${asked.length ? `${total(asked, r => r.questionLeaked)} of ${total(asked, r => r.questionPhrases)}` : 'n/a'} | ${struck.length ? `${total(struck, r => r.struckLeaked)} of ${total(struck, r => r.struckPhrases)}` : 'n/a'} | ${meanOf(list.map(r => r.uncertainFlagged)) === null ? 'n/a' : total(list, r => r.uncertainFlagged)} |`;
  }).filter(Boolean);
  if (!table.length) return [];
  return ['## Answer-only accuracy and leakage', '',
    '| Model | Variant | Photos with answer file | Answer CER (case) | Answer WER (case) | Question lines leaked | Crossed-out phrases leaked | Uncertain words flagged |', '|---|---|---|---|---|---|---|---|',
    ...table, '',
    'Answer-only: the text a reader kept as the student\'s answer, scored against the answer file. A leak means question or crossed-out text appears in that answer more often than in the answer file. The ordinary CER/WER above use the full transcription. Counts only; no text is shown.', ''];
}
const temperatureCell = r => (r.temperatureMode === 'omit' ? 'not sent (requested omit)'
  : r.temperatureSent === false ? 'not sent (catalog: not supported)' : 'sent: 0');

/** Exactly what each model was sent, so the comparison stays honest. */
function requestSettingsSection(rows, meta) {
  const sent = rows.filter(r => r.source !== 'skipped' && r.imageBytes !== null && r.imageBytes !== undefined);
  if (!sent.length) return [];
  const distinct = (list, pick) => [...new Set(list.map(pick))].join(' / ');
  const out = ['## Request settings per model', '',
    '| Model | Temperature | Reasoning (requested -> sent) | Max tokens | Sort | Pinned provider | Prompt | Output |', '|---|---|---|---|---|---|---|---|'];
  for (const model of meta.models) {
    const own = sent.filter(r => r.model === model);
    if (!own.length) continue;
    out.push(`| ${model} | ${distinct(own, temperatureCell)} | ${distinct(own, r => `${r.reasoningMode ?? 'n/a'} -> ${r.reasoningSent ?? 'n/a'}`)} | ${meta.maxOutputTokens ?? 'n/a'} | ${distinct(own, r => r.sort ?? 'default')} | ${distinct(own, r => r.pinnedProvider || 'none')} | ${distinct(own, r => r.promptMode ?? 'n/a')} | ${distinct(own, r => (JSON_MODES.includes(r.promptMode) ? 'strict JSON schema' : 'plain text'))} |`);
  }
  out.push('', 'Every model gets the same prompt, image variants and routing (require_parameters, no fallbacks). A parameter is left out only when asked for (`omit`) or when the model\'s catalog entry says it cannot take it.', '');
  return out;
}

function renderSummary({ meta, rows }) {
  const groups = aggregate(rows);
  const out = [];
  out.push('# OCR evaluation summary', '');
  if (meta.mode === 'dry-run') {
    out.push('> **DRY RUN - simulated models.** Every number below is synthetic. It only shows the shape of the report; it says nothing about real models.', '');
  }
  out.push(`- Run: \`${meta.runId}\` (${meta.startedAt})`);
  if (meta.partial) {
    out.push(`> **Partial results: ${rows.length} of ${meta.plannedRows} rows so far.** The run is still going, or it was interrupted; \`--resume\` or \`--rescore\` completes it.`, '');
  }
  out.push(`- Mode: ${meta.mode} | prompt: \`${meta.promptMode}\` | temperature: ${meta.temperature === 'omit' ? 'omitted (provider default)' : '0'} | reasoning: see "Request settings per model" | sort: ${meta.sort || 'default'} | pinned provider: ${meta.provider || 'none'} | ignored providers: ${(meta.ignoreProviders || []).join(', ') || 'none'} | max consecutive failures per model: ${meta.maxFailures ?? 'n/a'}`);
  out.push(`- Photos: ${meta.photoCount} | variants: ${meta.variants.join(', ')} | models: ${meta.models.join(', ')}`);
  out.push(`- Calls: ${rows.length} recorded (${meta.reusedCalls} reused from an earlier run) | cost this run: ${money(meta.totalCostUsd)} | [?] wildcard span: ${meta.wildcardSpan} words`, '');

  out.push('## Results (mean per photo)', '');
  out.push('| Model | Variant | OK / calls | CER (case) | WER (case) | CER (any case) | WER (any case) | Over-correction | Cost / page | Latency (mean) | Reasoning not off |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of groups) {
    out.push(`| ${g.model} | ${g.variant} | ${g.ok} / ${g.calls}${g.skipped ? ` (${g.skipped} skipped)` : ''} | ${pct(g.cerCs)} | ${pct(g.werCs)} | ${pct(g.cerCi)} | ${pct(g.werCi)} | ${ocText(g.overcorrection)} | ${money(g.costMean)} | ${seconds(g.latencyMean)} | ${g.reasoningFlagged ? `**${g.reasoningFlagged}**` : '0'} |`);
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

  out.push(...answerSection(rows));

  const warnings = buildWarnings(rows, meta);
  out.push('## Warnings', '');
  out.push(...(warnings.length ? warnings.map(w => `- ${w}`) : ['- None.']), '');
  out.push(...failedCallsSection(rows));
  out.push(...requestSettingsSection(rows, meta));

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
