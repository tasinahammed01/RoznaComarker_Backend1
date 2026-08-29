'use strict';

const crypto = require('crypto');
const semanticWriting = require('./semanticWritingCorrections.service');
const canonical = require('./correctionCanonical.service');
const { getSemanticAIConfig } = require('./semanticAIClient.service');
const { CORRECTION_CATEGORIES } = require('./structuredOutputSchemas.service');
const VERSION = 'semantic-chunk-coordinator-v1';

const integer = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
};

function config(env = process.env) {
  return {
    enabled: String(env.SEMANTIC_AI_CHUNKING_ENABLED || 'true').toLowerCase() !== 'false',
    singleRequestThresholdTokens: integer(env.SEMANTIC_AI_SINGLE_REQUEST_THRESHOLD_TOKENS, 5000),
    chunkInputTokens: integer(env.SEMANTIC_AI_CHUNK_INPUT_TOKENS, 3500),
    overlapTokens: integer(env.SEMANTIC_AI_CHUNK_OVERLAP_TOKENS, 150, 0),
    chunkMaxOutputTokens: integer(env.SEMANTIC_AI_CHUNK_MAX_OUTPUT_TOKENS, 2500),
    maxConcurrency: integer(env.SEMANTIC_AI_MAX_CONCURRENCY, 2),
    maxChunks: integer(env.SEMANTIC_AI_MAX_CHUNKS, 12),
    totalBudgetMs: integer(env.SEMANTIC_AI_CHUNK_TOTAL_BUDGET_MS, 180000, 1000)
  };
}

const hash = (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex');

function preferredBoundary(text, from, ideal, maximum, pageEnds = []) {
  const minimumEnd = from + (ideal - from) * 0.65;
  const candidates = pageEnds.filter((end) => end > from && end <= maximum && end >= minimumEnd);
  if (candidates.length) return candidates[candidates.length - 1];
  const window = text.slice(from, maximum);
  const minimumLocal = Math.max(1, Math.floor((ideal - from) * 0.65));
  for (const pattern of [/\n\s*\n/gu, /[.!?][\s\n]+/gu, /\s+/gu]) {
    let match; let last = null;
    while ((match = pattern.exec(window))) if (match.index + match[0].length >= minimumLocal) last = match.index + match[0].length;
    if (last) return from + last;
  }
  return maximum;
}

function buildChunks(transcript, pages = [], options = {}) {
  const text = String(transcript || '');
  if (!text) return [];
  const overlapChars = Math.min(integer(options.overlapTokens, 150, 0) * 4, Math.max(0, text.length - 1));
  let targetChars = integer(options.chunkInputTokens, 2500) * 4;
  const maxChunks = integer(options.maxChunks, 12);
  if (Math.ceil(text.length / Math.max(1, targetChars - overlapChars)) > maxChunks) {
    targetChars = Math.ceil((text.length + overlapChars * (maxChunks - 1)) / maxChunks);
  }
  const pageEnds = pages.map((page) => Number(page?.endChar)).filter((end) => Number.isFinite(end) && end > 0 && end < text.length);
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const maximum = Math.min(text.length, start + targetChars);
    const preferred = maximum === text.length ? text.length
      : preferredBoundary(text, start, start + targetChars, maximum, pageEnds);
    const remainingSlots = maxChunks - chunks.length - 1;
    const minimumForRemaining = remainingSlots > 0
      ? text.length - remainingSlots * Math.max(1, targetChars - overlapChars) : text.length;
    const end = Math.min(text.length, Math.max(preferred, minimumForRemaining));
    chunks.push({ index: chunks.length, startChar: start, endChar: end, text: text.slice(start, end) });
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - overlapChars);
    start = next;
  }
  return chunks;
}

function localSpans(spans, chunk) {
  return (spans || []).filter((span) => span.start < chunk.endChar && span.end > chunk.startChar)
    .map((span) => ({ ...span, start: span.start - chunk.startChar, end: span.end - chunk.startChar }));
}

function localPages(pages, chunk) {
  return (pages || []).filter((page) => Number(page.endChar) > chunk.startChar && Number(page.startChar) < chunk.endChar)
    .map((page) => ({ ...page, startChar: Math.max(0, Number(page.startChar) - chunk.startChar),
      endChar: Math.min(chunk.text.length, Number(page.endChar) - chunk.startChar) }));
}

function remapCorrections(items, chunk, input) {
  return (items || []).map((item) => canonical.normalizeCorrection({ ...item,
    startChar: Number(item.startChar) + chunk.startChar,
    endChar: Number(item.endChar) + chunk.startChar
  }, input.transcript, input.spans || [], input.legend, 'AI')).filter(Boolean);
}

async function runBounded(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function aggregateMetrics(results, chunks, startedAt, mode) {
  const successful = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');
  const attempts = successful.flatMap((result) => result.value.metrics?.attempts || [])
    .concat(failed.flatMap((result) => result.reason?.attempts || []));
  const inputTokens = attempts.reduce((sum, attempt) => sum + Number(attempt.promptTokenCount || 0), 0)
    || successful.reduce((sum, result) => sum + Number(result.value.metrics?.promptInputTokenEstimate || 0), 0);
  const outputTokens = attempts.reduce((sum, attempt) => sum + Number(attempt.candidateTokenCount || 0), 0)
    || successful.reduce((sum, result) => sum + Number(result.value.metrics?.outputTokenCount || 0), 0);
  const fallbackCalls = attempts.filter((attempt) => Number(attempt.fallbackIndex || 0) > 0).length;
  const timeoutCount = attempts.filter((attempt) => attempt.code === 'AI_ATTEMPT_TIMEOUT').length;
  const truncationCount = attempts.filter((attempt) => ['length', 'max_tokens', 'MAX_TOKENS']
    .includes(attempt.finishReason) || attempt.code === 'AI_OUTPUT_TRUNCATED').length;
  return { mode, chunkCount: chunks.length, numberOfChunks: chunks.length,
    requestCount: results.length, providerCallCount: attempts.length || results.length,
    semanticInputTokens: inputTokens || null, semanticOutputTokens: outputTokens || null,
    semanticFallbackCalls: fallbackCalls, timeoutCount, truncationCount,
    successfulRequestCount: successful.length,
    failedRequestCount: failed.length, maxChunkCharacters: Math.max(0, ...chunks.map((chunk) => chunk.text.length)),
    coveredCharacters: chunks.reduce((ranges, chunk) => {
      const previous = ranges[ranges.length - 1];
      if (previous && chunk.startChar <= previous.end) previous.end = Math.max(previous.end, chunk.endChar);
      else ranges.push({ start: chunk.startChar, end: chunk.endChar });
      return ranges;
    }, []).reduce((sum, range) => sum + range.end - range.start, 0),
    attempts, attemptCount: attempts.length, semanticDurationMs: Date.now() - startedAt,
    totalDurationMs: Date.now() - startedAt };
}

async function analyze(input, dependencies = {}) {
  const startedAt = Date.now();
  const env = dependencies.env || process.env;
  const settings = { ...config(env), ...(dependencies.settings || {}) };
  const semanticService = dependencies.semanticService || semanticWriting;
  const requestEstimate = typeof semanticService.buildSemanticRequest === 'function'
    ? semanticService.buildSemanticRequest(input).promptInputTokenEstimate
    : Math.ceil(String(input.transcript || '').length / 4);
  if (!settings.enabled || requestEstimate <= settings.singleRequestThresholdTokens) {
    const result = await semanticService.analyze(input, dependencies);
    const coordinatorMetrics = aggregateMetrics([{ status: 'fulfilled', value: result }],
      [{ text: input.transcript, startChar: 0, endChar: input.transcript.length }], startedAt, 'single');
    return { ...result, status: 'completed', coverage: { complete: true, coveredCharacters: input.transcript.length,
      totalCharacters: input.transcript.length }, metrics: { ...(result.metrics || {}), ...coordinatorMetrics } };
  }

  const localPromptOverheadTokens = semanticWriting.buildSemanticRequest({ ...input, transcript: '',
    analysisMode: 'local_chunk', categories: CORRECTION_CATEGORIES }).promptInputTokenEstimate;
  const chunks = buildChunks(input.transcript, input.pageManifest || [], { ...settings,
    chunkInputTokens: Math.max(400, settings.chunkInputTokens - localPromptOverheadTokens) });
  const deadlineAt = Math.min(Number(input.deadlineAt) || Infinity, startedAt + settings.totalBudgetMs);
  const baseConfig = dependencies.config || getSemanticAIConfig();
  const chunkConfig = { ...baseConfig, maxOutputTokens: Math.min(Number(baseConfig.maxOutputTokens) || settings.chunkMaxOutputTokens,
    settings.chunkMaxOutputTokens) };
  const tasks = chunks.map((chunk) => async () => {
    const chunkHash = hash(`${input.transcriptHash}|local|${chunk.startChar}|${chunk.endChar}|${chunk.text}`);
    const result = await semanticService.analyze({ ...input, transcript: chunk.text, transcriptHash: chunkHash,
      spans: localSpans(input.spans, chunk), pageManifest: localPages(input.pageManifest, chunk),
      analysisMode: 'local_chunk', categories: CORRECTION_CATEGORIES, disableCategoryAudit: true, deadlineAt },
    { ...dependencies, config: chunkConfig });
    return { ...result, corrections: remapCorrections(result.corrections, chunk, input), chunk };
  });
  tasks.push(async () => semanticService.analyze({ ...input, analysisMode: 'document_structure',
    categories: ['CONTENT', 'ORGANIZATION'], disableCategoryAudit: true, deadlineAt },
  { ...dependencies, config: chunkConfig }));
  const results = await runBounded(tasks, settings.maxConcurrency);
  const successful = results.filter((result) => result.status === 'fulfilled');
  const merged = canonical.mergeCanonicalCorrections({ aiCorrections: successful.flatMap((result) => result.value.corrections || []) });
  const localSuccessCount = results.slice(0, chunks.length).filter((result) => result.status === 'fulfilled').length;
  const structuralSucceeded = results[chunks.length]?.status === 'fulfilled';
  const status = localSuccessCount === chunks.length && structuralSucceeded ? 'completed'
    : successful.length ? 'partial' : 'failed';
  const errors = results.filter((result) => result.status === 'rejected').map((result, index) => ({ index,
    code: result.reason?.code || 'SEMANTIC_CHUNK_FAILED' }));
  const metrics = { ...aggregateMetrics(results, chunks, startedAt, 'chunked'),
    configuredChunkInputTokens: settings.chunkInputTokens, localPromptOverheadTokens };
  return { status, corrections: merged.corrections, provider: successful[0]?.value.provider || null,
    model: successful[0]?.value.model || null, diagnostics: { chunking: { localChunkCount: chunks.length,
      localSuccessCount, structuralSucceeded, errors, mergeDiagnostics: merged.diagnostics } }, metrics,
    coverage: { complete: status === 'completed', coveredCharacters: metrics.coveredCharacters,
      totalCharacters: input.transcript.length, successfulChunks: localSuccessCount, totalChunks: chunks.length } };
}

module.exports = { VERSION, config, preferredBoundary, buildChunks, localSpans, localPages, remapCorrections,
  runBounded, aggregateMetrics, analyze };
