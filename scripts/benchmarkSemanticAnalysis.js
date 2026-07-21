'use strict';

require('dotenv').config();
const { performance } = require('perf_hooks');
const fixtures = require('../tests/fixtures/semanticAccuracyFixtures');
const semantic = require('../src/services/semanticWritingCorrections.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');
const canonical = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');

const sentence = 'Evidence-based planning helps communities compare practical choices and explain their likely consequences clearly.';
function words(text) { return String(text).trim().split(/\s+/u).filter(Boolean); }
function essayOfSize(target) {
  const output = [];
  while (output.length < target) output.push(...words(sentence));
  return output.slice(0, target).join(' ');
}
function pagesFor(text, count) {
  const size = Math.ceil(text.length / count);
  return Array.from({ length: count }, (_, index) => ({ fileId: `file-${index + 1}`, pageNumber: 1,
    startChar: index * size, endChar: Math.min(text.length, (index + 1) * size) }));
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const config = getSemanticAIConfig();
  const cases = [
    { id: '150_words', text: essayOfSize(150), pages: 1 },
    { id: '450_words', text: essayOfSize(450), pages: 1 },
    { id: '1000_words', text: essayOfSize(1000), pages: 1 },
    { id: 'two_page', text: essayOfSize(450), pages: 2 },
    { id: 'ten_page', text: essayOfSize(1000), pages: 10 }
  ];
  const promptMeasurements = cases.map((item) => {
    const hash = `benchmark-${item.id}`;
    const input = { transcript: item.text, transcriptHash: hash, assignment: { title: 'Sanitized benchmark',
      instructions: 'Present a clear position with relevant evidence and a conclusion.', rubric: { content: 'Develop ideas', organization: 'Connect paragraphs', vocabulary: 'Use precise language' } },
      pageManifest: pagesFor(item.text, item.pages), languageToolCorrections: [{ symbol: 'AGR', startChar: 10, endChar: 18,
        quotedText: item.text.slice(10, 18), message: 'A deliberately verbose LanguageTool explanation excluded by the compact request.' }] };
    const before = semantic.buildLegacySemanticRequestForBenchmark(input);
    const after = semantic.buildSemanticRequest(input);
    return { id: item.id, words: words(item.text).length, pages: item.pages,
      beforeCharacters: before.promptCharacters, afterCharacters: after.promptCharacters,
      reductionPercent: Number(((1 - after.promptCharacters / before.promptCharacters) * 100).toFixed(1)),
      beforeTokenEstimate: before.promptInputTokenEstimate, afterTokenEstimate: after.promptInputTokenEstimate };
  });
  const report = { mode: process.argv.includes('--live') ? 'live' : 'local-structural',
    current: { provider: process.env.PRIMARY_AI_PROVIDER || 'openrouter', model: process.env.PRIMARY_AI_MODEL || null,
      attemptTimeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS) || 60000, attempts: Number(process.env.AI_MAX_RETRIES) || 3,
      outputTokenBudget: Number(process.env.OPENROUTER_MAX_TOKENS) || 4000,
      calculatedWorstCaseMs: (Number(process.env.OPENROUTER_TIMEOUT_MS) || 60000) * (Number(process.env.AI_MAX_RETRIES) || 3)
        + Math.max(0, (Number(process.env.AI_MAX_RETRIES) || 3) - 1) * (Number(process.env.AI_RETRY_DELAY_MS) || 1000) },
    optimized: { provider: config.provider, model: config.model, attemptTimeoutMs: config.attemptTimeoutMs,
      totalBudgetMs: config.totalBudgetMs, maxRetries: config.maxRetries, outputTokenBudget: config.maxOutputTokens,
      fallback: config.fallback }, promptMeasurements, accuracyFixtureCount: fixtures.length, liveCandidates: [] };
  if (process.argv.includes('--live')) {
    const explicitlyApproved = new Set(config.approvedModels);
    let candidates = [
      { provider: process.env.PRIMARY_AI_PROVIDER || 'openrouter', model: process.env.PRIMARY_AI_MODEL, source: 'current_primary' },
      { provider: config.provider, model: config.model, source: 'semantic_config' },
      { provider: process.env.FALLBACK_AI_PROVIDER, model: process.env.FALLBACK_AI_MODEL, source: 'existing_project_fallback' }
    ].filter((item) => item.provider && item.model)
      .filter((item) => ['current_primary', 'existing_project_fallback'].includes(item.source) || explicitlyApproved.has(item.model))
      .filter((item, index, list) => list.findIndex((candidate) => candidate.provider === item.provider && candidate.model === item.model) === index);
    const onlyArgument = process.argv.find((item) => item.startsWith('--only='));
    const only = String(onlyArgument ? onlyArgument.slice('--only='.length) : process.env.SEMANTIC_BENCHMARK_ONLY || '').trim();
    if (only) candidates = candidates.filter((item) => `${item.provider}:${item.model}` === only);
    for (const candidate of candidates) {
      const { provider, model } = candidate;
      const latencies = []; let valid = 0; let expectedFound = 0; let expectedTotal = 0; let predictedTotal = 0;
      let rawCorrectionCount = 0; let acceptedCorrectionCount = 0; let invalidEvidenceCount = 0; let duplicateCount = 0;
      const failureCodeCounts = {};
      for (const fixture of fixtures) {
        const transcriptHash = `fixture-${fixture.id}`;
        expectedTotal += fixture.expected.length;
        const startedAt = performance.now();
        try {
          const result = await semantic.analyze({ transcript: fixture.text, transcriptHash, assignment: { title: 'Sanitized fixture' },
            pageManifest: pagesFor(fixture.text, fixture.pageBreaks?.length ? 2 : 1), languageToolCorrections: [] },
          { config: { ...config, provider, model, fallback: null } });
          latencies.push(performance.now() - startedAt); valid += 1;
          rawCorrectionCount += result.corrections.length;
          const normalized = result.corrections.map((item) => canonical.normalizeCorrection(item, fixture.text, [], defaultLegend(), 'AI')).filter(Boolean);
          invalidEvidenceCount += result.corrections.length - normalized.length;
          const merged = canonical.mergeCorrections(normalized);
          duplicateCount += normalized.length - merged.length;
          acceptedCorrectionCount += merged.length;
          const symbols = new Set(merged.map((item) => item.symbol));
          expectedFound += fixture.expected.filter((symbol) => symbols.has(symbol)).length;
          predictedTotal += symbols.size;
        } catch (error) {
          latencies.push(performance.now() - startedAt);
          const code = String(error?.code || (error?.status ? `HTTP_${error.status}` : error?.name || 'UNKNOWN'));
          failureCodeCounts[code] = (failureCodeCounts[code] || 0) + 1;
        }
      }
      report.liveCandidates.push({ provider, model, source: candidate.source,
        medianMs: percentile(latencies, 50), p95Ms: percentile(latencies, 95),
        successRate: valid / fixtures.length, validJsonAndHashRate: valid / fixtures.length,
        expectedSymbolRecall: expectedTotal ? expectedFound / expectedTotal : 1,
        expectedSymbolPrecision: predictedTotal ? expectedFound / predictedTotal : expectedTotal ? 0 : 1,
        rawCorrectionCount, acceptedCorrectionCount, invalidEvidenceCount, duplicateCount, failureCodeCounts });
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`Semantic benchmark failed: ${error?.message || error}\n`); process.exitCode = 1; });
