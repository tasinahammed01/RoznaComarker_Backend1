'use strict';

const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const canonical = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');

const semanticResult = (input) => {
  const at = input.transcript.indexOf('badword');
  const corrections = at < 0 || input.analysisMode === 'document_structure' ? [] : [canonical.normalizeCorrection({
    category: 'VOCABULARY', symbol: 'WC', quotedText: 'badword', suggestedText: 'better word',
    message: 'Use a more precise word.', confidence: 0.99, occurrence: 0,
    correctionKind: 'localized', severity: 'medium', stylePreference: false,
    startChar: at, endChar: at + 7
  }, input.transcript, input.spans || [], input.legend, 'AI')].filter(Boolean);
  return { corrections, diagnostics: {}, provider: 'test', model: 'test-model', metrics: { attempts: [] } };
};

describe('semantic correction chunk coordinator', () => {
  test('chunks cover the complete transcript without gaps and respect maxChunks without truncation', () => {
    const transcript = Array.from({ length: 80 }, (_, index) => `Paragraph ${index}. Sentence content here.`).join('\n\n');
    const chunks = coordinator.buildChunks(transcript, [], { chunkInputTokens: 40, overlapTokens: 5, maxChunks: 6 });
    expect(chunks.length).toBeLessThanOrEqual(6);
    expect(chunks[0].startChar).toBe(0);
    expect(chunks[chunks.length - 1].endChar).toBe(transcript.length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].startChar).toBeLessThanOrEqual(chunks[index - 1].endChar);
      expect(chunks[index].endChar).toBeGreaterThan(chunks[index].startChar);
    }
  });

  test('bounds concurrency, performs a structural pass, remaps offsets, and deduplicates overlap findings', async () => {
    const transcript = `${'a'.repeat(1580)}badword ${'b'.repeat(2400)}`;
    let active = 0; let peak = 0; const calls = [];
    const semanticService = { analyze: jest.fn(async (input) => {
      calls.push(input); active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1; return semanticResult(input);
    }) };
    const result = await coordinator.analyze({ transcript, transcriptHash: 'source', legend: defaultLegend(),
      spans: [], pageManifest: [], assignment: {} }, { semanticService,
      settings: { enabled: true, singleRequestThresholdTokens: 1, chunkInputTokens: 3100,
        overlapTokens: 10, chunkMaxOutputTokens: 1000, maxConcurrency: 2, maxChunks: 8, totalBudgetMs: 5000 },
      config: { maxOutputTokens: 2000 } });
    expect(result.status).toBe('completed');
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls.some((call) => call.analysisMode === 'document_structure'
      && call.categories.join(',') === 'CONTENT,ORGANIZATION')).toBe(true);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ quotedText: 'badword', startChar: 1580, endChar: 1587 });
    expect(result.coverage).toMatchObject({ complete: true, coveredCharacters: transcript.length,
      totalCharacters: transcript.length });
    expect(result.metrics).toMatchObject({ numberOfChunks: expect.any(Number), providerCallCount: expect.any(Number),
      semanticFallbackCalls: 0, timeoutCount: 0, truncationCount: 0 });
  });

  test('retains successful chunks and reports partial instead of discarding all corrections', async () => {
    const transcript = `${'a'.repeat(1580)}badword ${'b'.repeat(2400)}`;
    let localIndex = 0;
    const semanticService = { analyze: jest.fn(async (input) => {
      if (input.analysisMode === 'local_chunk' && localIndex++ === 1) {
        const error = new Error('chunk timeout'); error.code = 'AI_ATTEMPT_TIMEOUT'; throw error;
      }
      return semanticResult(input);
    }) };
    const result = await coordinator.analyze({ transcript, transcriptHash: 'source', legend: defaultLegend(),
      spans: [], pageManifest: [], assignment: {} }, { semanticService,
      settings: { enabled: true, singleRequestThresholdTokens: 1, chunkInputTokens: 3100,
        overlapTokens: 10, chunkMaxOutputTokens: 1000, maxConcurrency: 2, maxChunks: 8, totalBudgetMs: 5000 },
      config: { maxOutputTokens: 2000 } });
    expect(result.status).toBe('partial');
    expect(result.corrections).toHaveLength(1);
    expect(result.coverage).toMatchObject({ coverageComplete: false, failedChunks: 1,
      structuralPassStatus: 'completed', categoryCoverageComplete: {
        CONTENT: false, ORGANIZATION: false, VOCABULARY: false, GRAMMAR: false, MECHANICS: false
      } });
    expect(result.diagnostics.chunking.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AI_ATTEMPT_TIMEOUT' })
    ]));
  });

  test('marks structural categories incomplete while retaining complete local-language findings', async () => {
    const transcript = `${'a'.repeat(1580)}badword ${'b'.repeat(2400)}`;
    const semanticService = { analyze: jest.fn(async (input) => {
      if (input.analysisMode === 'document_structure') {
        const error = new Error('structural timeout'); error.code = 'AI_ATTEMPT_TIMEOUT'; throw error;
      }
      return semanticResult(input);
    }) };
    const result = await coordinator.analyze({ transcript, transcriptHash: 'source', legend: defaultLegend(),
      spans: [], pageManifest: [], assignment: {} }, { semanticService,
      settings: { enabled: true, singleRequestThresholdTokens: 1, chunkInputTokens: 3100,
        overlapTokens: 10, chunkMaxOutputTokens: 1000, maxConcurrency: 2, maxChunks: 8, totalBudgetMs: 5000 },
      config: { maxOutputTokens: 2000 } });
    expect(result).toMatchObject({ status: 'partial', coverage: { coverageComplete: false,
      failedChunks: 0, structuralPassStatus: 'failed', categoryCoverageComplete: {
        CONTENT: false, ORGANIZATION: false, VOCABULARY: true, GRAMMAR: true, MECHANICS: true
      } } });
    expect(result.corrections).toHaveLength(1);
  });

  test('reports failed with no corrections when every local and structural request fails', async () => {
    const transcript = 'Long source text. '.repeat(300);
    const semanticService = { analyze: jest.fn(async () => {
      const error = new Error('provider unavailable'); error.code = 'AI_PROVIDER_UNAVAILABLE'; throw error;
    }) };
    const result = await coordinator.analyze({ transcript, transcriptHash: 'source', legend: defaultLegend(),
      spans: [], pageManifest: [], assignment: {} }, { semanticService,
      settings: { enabled: true, singleRequestThresholdTokens: 1, chunkInputTokens: 3100,
        overlapTokens: 10, chunkMaxOutputTokens: 1000, maxConcurrency: 2, maxChunks: 8, totalBudgetMs: 5000 },
      config: { maxOutputTokens: 2000 } });
    expect(result).toMatchObject({ status: 'failed', corrections: [],
      coverage: { complete: false, successfulChunks: 0 } });
  });
});
