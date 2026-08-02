jest.mock('../src/models/CorrectionLegend', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) }))
}));

const semantic = require('../src/services/semanticWritingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const writing = require('../src/services/writingCorrections.service');
const policy = require('../src/services/aiCorrectionPolicy.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const expertFixture = require('./fixtures/twoPageLearnerEssaySanitized');
const { CATEGORY_SYMBOLS } = require('../src/services/structuredOutputSchemas.service');

const finding = (overrides = {}) => ({
  category: 'CONTENT', symbol: 'DEV', correctionKind: 'localized', quotedText: 'claim', occurrence: 0,
  message: 'Develop this claim with relevant evidence.', suggestedText: 'claim with evidence',
  confidence: 0.95, severity: 'medium', stylePreference: false, ...overrides
});
const reviewsFor = (corrections = []) => Object.keys(policy.CATEGORY_POLICY).map((category) => {
  const findingCount = corrections.filter((item) => item.category === category).length;
  return { category, reviewed: true,
    noFindingReason: findingCount ? '' : 'No additional grounded finding after complete review.' };
});
const structuredFor = (corrections = [], overrides = {}) => ({
  transcriptHash: overrides.transcriptHash || 'hash',
  categories: Object.fromEntries(Object.keys(policy.CATEGORY_POLICY).map((category) => {
    const items = corrections.filter((item) => item.category === category)
      .map(({ category: _category, ...item }) => item);
    return [category, { reviewed: true,
      reviewedSymbols: [...CATEGORY_SYMBOLS[category]],
      noFindingReason: items.length ? '' : 'No additional grounded finding after complete review.',
      corrections: items, ...(overrides[category] || {}) }];
  }))
});

describe('safe hybrid correction policy', () => {
  const legend = semantic.compactSemanticLegend(writing.defaultLegend());

  test('builds a compact prompt with schema and transcript hash', () => {
    const request = semantic.buildSemanticRequest({
      transcript: 'Exact essay.', transcriptHash: 'hash-123',
      languageToolCorrections: []
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain('transcriptHash=hash-123');
    expect(prompt).toContain('localized means a specific passage');
    expect(prompt).not.toContain('localized|global');
    expect(prompt).not.toContain('<exact supplied hash>');
  });

  test('requires one consistent review for every canonical category while allowing zero Content findings', () => {
    const empty = structuredFor([]);
    expect(semantic.parseJson(JSON.stringify(empty), 'hash'))
      .toMatchObject({ corrections: [] });
    expect(() => semantic.parseJson(JSON.stringify({ transcriptHash: 'hash' }), 'hash')).toThrow(expect.objectContaining({
      validationStage: 'semantic_schema', jsonPath: '$.categories', requiredPropertyMissing: true
    }));
    const incomplete = structuredFor([]); delete incomplete.categories.MECHANICS;
    expect(() => semantic.parseJson(JSON.stringify(incomplete), 'hash'))
      .toThrow(expect.objectContaining({ validationStage: 'semantic_schema' }));
    const mismatchFinding = finding();
    const payload = structuredFor([mismatchFinding], { CONTENT: { findingCount: 99 } });
    expect(() => semantic.parseJson(JSON.stringify(payload), 'hash')).toThrow(expect.objectContaining({
      validationStage: 'semantic_schema', jsonPath: '$.categories.CONTENT.findingCount', unexpectedPropertyPresent: true
    }));
    delete payload.categories.CONTENT.findingCount;
    const parsed = semantic.parseJson(JSON.stringify(payload), 'hash');
    expect(parsed.categoryReviews.find((review) => review.category === 'CONTENT')).toMatchObject({ findingCount: 1,
      noFindingReason: '' });
    expect(parsed.compatibilityDiagnostics).toMatchObject({
      legacyFindingCountIgnored: false,
      categoryReviewNormalizations: expect.arrayContaining([
        expect.objectContaining({ category: 'CONTENT', correctionCount: 1,
          originalReasonPresent: false, normalizationReason: 'server_count_calculated' })
      ])
    });
  });

  test('normalizes category-review reasons without discarding authoritative corrections', () => {
    const correction = finding();
    const payload = structuredFor([correction], {
      CONTENT: { noFindingReason: 'Contradictory provider reason.' }, VOCABULARY: { noFindingReason: 'N/A' }
    });
    const parsed = semantic.parseJson(JSON.stringify(payload), 'hash', {
      provider: 'openrouter', model: 'openai/gpt-4.1', attemptNumber: 1
    });

    expect(parsed.categoryReviews.find((review) => review.category === 'CONTENT')).toMatchObject({
      findingCount: 1, noFindingReason: ''
    });
    expect(parsed.categoryReviews.find((review) => review.category === 'ORGANIZATION').noFindingReason)
      .toBe(semantic.DEFAULT_NO_FINDING_REASON);
    expect(parsed.categoryReviews.find((review) => review.category === 'VOCABULARY').noFindingReason)
      .toBe(semantic.DEFAULT_NO_FINDING_REASON);
    expect(parsed.compatibilityDiagnostics.categoryReviewNormalizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'CONTENT', correctionCount: 1, originalReasonPresent: true,
        normalizationReason: 'nonzero_reason_cleared', provider: 'openrouter', model: 'openai/gpt-4.1', attemptNumber: 1 }),
      expect.objectContaining({ category: 'VOCABULARY', correctionCount: 0, originalReasonPresent: true,
        normalizationReason: 'zero_reason_defaulted' })
    ]));
  });

  test('accepts complete unordered 28-symbol coverage without creating corrections', () => {
    const payload = structuredFor([]);
    for (const review of Object.values(payload.categories)) review.reviewedSymbols.reverse();
    const parsed = semantic.parseJson(JSON.stringify(payload), 'hash');
    expect(parsed.corrections).toEqual([]);
    expect(Object.values(parsed.symbolReviewCoverage).every((item) => item.complete)).toBe(true);
    expect(Object.values(parsed.symbolReviewCoverage).reduce((sum, item) => sum + item.received, 0)).toBe(28);
    expect(canonical.statistics(parsed.corrections)).toEqual({ content: 0, organization: 0, grammar: 0,
      vocabulary: 0, mechanics: 0, total: 0 });
  });

  test('rejects an empty no-finding reason for a backend-calculated zero category', () => {
    const payload = structuredFor([]); payload.categories.CONTENT.noFindingReason = '';
    expect(() => semantic.parseJson(JSON.stringify(payload), 'hash')).toThrow(expect.objectContaining({
      code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'category_review_reason', category: 'CONTENT'
    }));
  });

  test.each([
    ['missing', (symbols) => symbols.slice(1), ['REL'], [], []],
    ['duplicate', (symbols) => [...symbols.slice(0, -1), symbols[0]], ['SD'], ['REL'], []],
    ['unknown', (symbols) => [...symbols.slice(0, -1), 'UNKNOWN'], ['SD'], [], ['UNKNOWN']],
    ['cross-category', (symbols) => [...symbols.slice(0, -1), 'AGR'], ['SD'], [], ['AGR']]
  ])('rejects %s symbol-review coverage with sanitized metadata', (_label, mutate, missing, duplicate, unexpected) => {
    const payload = structuredFor([]);
    payload.categories.CONTENT.reviewedSymbols = mutate(payload.categories.CONTENT.reviewedSymbols);
    expect(() => semantic.parseJson(JSON.stringify(payload), 'hash', {
      provider: 'openrouter', model: 'openai/gpt-4.1', attemptNumber: 1
    })).toThrow(expect.objectContaining({ code: 'SEMANTIC_SYMBOL_REVIEW_INCOMPLETE',
      validationStage: 'symbol_review_coverage', category: 'CONTENT', expectedSymbolCount: 5,
      missingSymbols: missing, duplicateSymbols: duplicate, unexpectedSymbols: unexpected,
      provider: 'openrouter', model: 'openai/gpt-4.1', attemptNumber: 1 }));
  });

  test('targeted repair requires complete selected-category symbols and rejects unrelated categories', () => {
    const selected = ['CONTENT', 'VOCABULARY'];
    const payload = structuredFor([]);
    payload.categories = { CONTENT: payload.categories.CONTENT, VOCABULARY: payload.categories.VOCABULARY };
    expect(semantic.parseJson(JSON.stringify(payload), 'hash', {}, selected, CATEGORY_SYMBOLS, 'targeted-repair'))
      .toMatchObject({ corrections: [], symbolReviewCoverage: {
        CONTENT: { complete: true, sources: ['targeted-repair'] },
        VOCABULARY: { complete: true, sources: ['targeted-repair'] }
      } });
    payload.categories.GRAMMAR = structuredFor([]).categories.GRAMMAR;
    expect(() => semantic.parseJson(JSON.stringify(payload), 'hash', {}, selected, CATEGORY_SYMBOLS, 'targeted-repair'))
      .toThrow(expect.objectContaining({ validationStage: 'semantic_schema', unexpectedPropertyPresent: true }));
  });

  test('symbol coverage diagnostics contain no transcript or provider response content', () => {
    const parsed = semantic.parseJson(JSON.stringify(structuredFor([])), 'hash');
    const serialized = JSON.stringify(parsed.symbolReviewCoverage);
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('response');
    expect(serialized).not.toContain('quotedText');
  });

  test('reports a sanitized JSON path for null and missing canonical fields', () => {
    const nullReason = structuredFor([], { CONTENT: { noFindingReason: null } });
    expect(() => semantic.parseJson(JSON.stringify(nullReason), 'hash')).toThrow(expect.objectContaining({ validationStage: 'semantic_schema',
      jsonPath: '$.categories.CONTENT.noFindingReason', expected: expect.stringContaining('string'), actualType: 'null' }));
    const missing = finding(); delete missing.suggestedText;
    expect(() => semantic.parseJson(JSON.stringify(structuredFor([missing])), 'hash')).toThrow(expect.objectContaining({ validationStage: 'semantic_schema',
      jsonPath: '$.categories.CONTENT.corrections[0].suggestedText', requiredPropertyMissing: true, candidateIndex: 0 }));
  });

  test('accepts grounded localized and global Content findings and rejects global Grammar', () => {
    const transcript = 'The main claim is vague and needs evidence.';
    const localized = semantic.validateCorrections([finding({ quotedText: 'needs evidence',
      suggestedText: 'needs specific evidence from the source' })], { transcript, legend });
    expect(localized.corrections).toHaveLength(1);
    const global = semantic.validateCorrections([finding({ correctionKind: 'global', quotedText: 'The main claim is vague',
      suggestedText: '' })], { transcript, legend });
    expect(global.corrections[0]).toMatchObject({ category: 'CONTENT', correctionKind: 'global', suggestedText: '' });
    expect(() => semantic.validateCorrections([finding({ category: 'GRAMMAR', symbol: 'AGR',
      correctionKind: 'global', quotedText: 'main claim', suggestedText: '' })], { transcript, legend }))
      .toThrow(expect.objectContaining({ validationStage: 'canonical_validation' }));
  });

  test('reports safe Content rejection diagnostics for confidence and grounding', () => {
    const result = semantic.validateCorrections([
      finding({ quotedText: 'claim', confidence: 0.70 }),
      finding({ quotedText: 'missing quote', confidence: 0.95 }),
      finding({ quotedText: 'claim', confidence: 0.95 })
    ], { transcript: 'claim', legend });
    expect(result.diagnostics).toMatchObject({ returnedByCategory: { CONTENT: 3 },
      acceptedByCategory: { CONTENT: 1 }, rejectedByCategory: { CONTENT: 2 },
      rejectionReasonsByCategory: { CONTENT: { LOW_CONFIDENCE: 1, QUOTE_NOT_FOUND: 1 } } });
    expect(result.diagnostics.rejectionDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'CONTENT', rejectionCode: 'LOW_CONFIDENCE',
        validationStage: 'confidence_validation', candidateIndex: 0, quotedTextHash: expect.any(String) }),
      expect.objectContaining({ category: 'CONTENT', rejectionCode: 'QUOTE_NOT_FOUND',
        validationStage: 'quote_match_validation', candidateIndex: 1, quotedTextHash: expect.any(String) })
    ]));
    expect(JSON.stringify(result.diagnostics.rejectionDiagnostics)).not.toContain('missing quote');
  });

  test('accepts individually grounded learner-English second-pass corrections across the taxonomy', () => {
    const transcript = [
      'It have many advantages.',
      'They may planned to use social media.',
      'Yesterday students study online.',
      'She bought book.',
      'They discussed about the problem.',
      'Because the lesson was difficult.',
      'Students were tired they continued working.',
      'This approach is success.',
      'The result was very big for learning.',
      'Learning helps learning because learning matters.',
      'This idea somehow changes everything.',
      'First the essay discusses study habits. Finally it introduces an unrelated claim.'
    ].join(' ');
    const expected = [
      finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', suggestedText: 'It has' }),
      finding({ category: 'GRAMMAR', symbol: 'VF', quotedText: 'may planned', suggestedText: 'may plan' }),
      finding({ category: 'GRAMMAR', symbol: 'T', quotedText: 'Yesterday students study', suggestedText: 'Yesterday students studied' }),
      finding({ category: 'GRAMMAR', symbol: 'ART', quotedText: 'bought book', suggestedText: 'bought a book' }),
      finding({ category: 'GRAMMAR', symbol: 'PREP', quotedText: 'discussed about', suggestedText: 'discussed' }),
      finding({ category: 'GRAMMAR', symbol: 'FRAG', quotedText: 'Because the lesson was difficult.', suggestedText: 'The lesson was difficult.' }),
      finding({ category: 'GRAMMAR', symbol: 'RO', quotedText: 'Students were tired they continued working.', suggestedText: 'Students were tired, but they continued working.' }),
      finding({ category: 'VOCABULARY', symbol: 'WF', quotedText: 'is success', suggestedText: 'is successful' }),
      finding({ category: 'VOCABULARY', symbol: 'WC', quotedText: 'very big for learning', suggestedText: 'highly beneficial for learning' }),
      finding({ category: 'VOCABULARY', symbol: 'REP', quotedText: 'Learning helps learning because learning matters.', suggestedText: 'Education helps students because it matters.' }),
      finding({ category: 'CONTENT', symbol: 'CL', correctionKind: 'global', quotedText: 'This idea somehow changes everything.', suggestedText: '' }),
      finding({ category: 'ORGANIZATION', symbol: 'COH', correctionKind: 'global', quotedText: 'Finally it introduces an unrelated claim.', suggestedText: '' }),
      finding({ category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global', quotedText: 'Finally it introduces an unrelated claim.', suggestedText: '' })
    ];
    const result = semantic.validateCorrections(expected, { transcript, legend });
    expect(result.corrections).toHaveLength(expected.length);
    for (const item of expected) expect(result.corrections).toEqual(expect.arrayContaining([expect.objectContaining({
      category: item.category, symbol: item.symbol, quotedText: item.quotedText,
      suggestedText: item.suggestedText, ...(item.correctionKind ? { correctionKind: item.correctionKind } : {})
    })]));
  });

  test('uses category-specific capacity without lowering confidence thresholds', () => {
    const transcript = Array.from({ length: 13 }, (_, index) => `students${index} learns`).join(' ');
    const findings = Array.from({ length: 13 }, (_, index) => finding({ category: 'GRAMMAR', symbol: 'AGR',
      quotedText: `students${index} learns`, suggestedText: `students${index} learn`, confidence: 0.90 }));
    const result = semantic.validateCorrections(findings, { transcript, legend });
    expect(result.corrections).toHaveLength(13);
    expect(result.diagnostics.rejectionReasons.CATEGORY_LIMIT).toBeUndefined();
    expect(result.diagnostics.thresholds).toMatchObject({ CONTENT: 0.75, ORGANIZATION: 0.75,
      VOCABULARY: 0.80, GRAMMAR: 0.85, MECHANICS: 0.90 });
  });

  test('AI accepts grounded findings in all five canonical categories', () => {
    const transcript = 'claim transition students is teh word';
    const raw = [
      finding(),
      finding({ category: 'ORGANIZATION', symbol: 'CO', quotedText: 'transition', message: 'Connect this idea.' }),
      finding({ category: 'VOCABULARY', symbol: 'WC', quotedText: 'word', message: 'Use a more precise word.', suggestedText: 'term' }),
      finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is', message: 'The plural subject requires agreement.', suggestedText: 'students are' }),
      finding({ category: 'MECHANICS', symbol: 'SP', quotedText: 'teh', message: 'Correct the spelling.', suggestedText: 'the' })
    ];
    const result = semantic.validateCorrections(raw, { transcript, legend });
    expect(new Set(result.corrections.map((item) => item.category))).toEqual(new Set(Object.keys(policy.CATEGORY_POLICY)));
    expect(result.diagnostics).toMatchObject({ rawCorrectionCount: 5, acceptedCorrectionCount: 5, rejectedCorrectionCount: 0 });
  });

  test('uses category thresholds and rejects hallucinations and style preferences', () => {
    const transcript = 'students is clear';
    const result = semantic.validateCorrections([
      finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is', confidence: 0.84 }),
      finding({ quotedText: 'clear', stylePreference: true }),
      finding({ quotedText: 'invented evidence' }),
      finding({ category: 'STYLE', symbol: 'DEV' }),
      finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is', confidence: 0.90,
        message: 'The plural subject requires agreement.', suggestedText: 'students are' })
    ], { transcript, legend });
    expect(result.corrections).toHaveLength(1);
    expect(result.diagnostics.rejectionReasons).toEqual({
      LOW_CONFIDENCE: 1, STYLE_PREFERENCE: 1, QUOTE_NOT_FOUND: 1, INVALID_SCHEMA: 1
    });
  });

  test('fails a provider attempt when a non-empty response has no acceptable finding', () => {
    expect(() => semantic.validateCorrections([
      finding({ quotedText: 'not in transcript' })
    ], { transcript: 'grounded text', legend })).toThrow(expect.objectContaining({
      code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'canonical_validation'
    }));
  });

  test('requires deterministic disambiguation for repeated quotations', () => {
    expect(() => semantic.validateCorrections([
      finding({ quotedText: 'repeat', occurrence: 3 })
    ], { transcript: 'repeat and repeat', legend })).toThrow(expect.objectContaining({
      code: 'SEMANTIC_SCHEMA_INVALID'
    }));
    const accepted = semantic.validateCorrections([
      finding({ quotedText: 'repeat', occurrence: 1 })
    ], { transcript: 'repeat and repeat', legend });
    expect(accepted.corrections[0]).toMatchObject({ startChar: 11, endChar: 17 });
  });

  test('rejects an oversized response instead of silently slicing it', () => {
    const payload = JSON.stringify(structuredFor(
      Array.from({ length: policy.MAX_AI_CORRECTIONS + 1 }, (_, index) => finding({ occurrence: index }))));
    expect(() => semantic.parseJson(payload, 'hash')).toThrow(expect.objectContaining({
      code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'correction_limit'
    }));
  });

  test('sends AI-only prompt with all five category instructions', () => {
    const request = semantic.buildSemanticRequest({
      transcript: 'students is here.', transcriptHash: 'hash',
      languageToolCorrections: []
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain('Pass 1 CONTENT: REL, DEV, TA, CL, SD');
    expect(prompt).toContain('Pass 2 ORGANIZATION: COH, CO, PU, TS, CONC');
    expect(prompt).toContain('Pass 3 GRAMMAR: T, VF, AGR, FRAG, RO, WO, ART, PREP');
    expect(prompt).toContain('Pass 4 VOCABULARY: WC, WF, REP, FORM, COL');
    expect(prompt).toContain('Pass 5 MECHANICS: SP, P, CAP, SPC, FMT');
    expect(prompt).not.toContain('LanguageTool');
  });

  test('accepts a grounded global organization finding without fabricated replacement text', () => {
    const transcript = 'The final paragraph repeats the topic but does not close the argument.';
    const result = semantic.validateCorrections([finding({
      category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global',
      quotedText: transcript, suggestedText: '', message: 'Add a conclusion that synthesizes the argument.'
    })], { transcript, legend });
    expect(result.corrections[0]).toMatchObject({
      category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global', suggestedText: ''
    });
  });

  test('rejects a double comparative mislabeled as vocabulary', () => {
    expect(() => semantic.validateCorrections([finding({
      category: 'VOCABULARY', symbol: 'WC', quotedText: 'more easier',
      suggestedText: 'easier', message: 'Remove the double comparative.'
    })], { transcript: 'This is more easier.', legend })).toThrow(expect.objectContaining({
      code: 'SEMANTIC_SCHEMA_INVALID'
    }));
  });

  test('runs one bounded missing-category audit and merges grounded findings into canonical diagnostics', async () => {
    const transcript = `students is unclear ${'supporting context '.repeat(30)}`.trim();
    const initial = structuredFor([finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is',
      suggestedText: 'students are', message: 'Correct subject-verb agreement.' })], { transcriptHash: 'audit-hash' });
    const auditCategories = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'MECHANICS'];
    const audit = { transcriptHash: 'audit-hash', categories: Object.fromEntries(auditCategories.map((category) => [category, {
      reviewed: true,
      reviewedSymbols: [...CATEGORY_SYMBOLS[category]],
      noFindingReason: category === 'CONTENT' ? '' : 'No grounded finding after the targeted review.',
      corrections: category === 'CONTENT' ? [(({ category: _category, ...item }) => item)(finding({
        category: 'CONTENT', symbol: 'DEV', correctionKind: 'global', quotedText: 'supporting context', suggestedText: '',
        message: 'Develop this point with specific support.'
      }))] : []
    }])) };
    const payloads = [initial, audit];
    const runCompletion = jest.fn(async (options) => {
      const content = JSON.stringify(payloads.shift());
      return { content, value: options.validate(content, { provider: 'openrouter', model: 'openai/gpt-4.1', attemptIndex: 0 }),
        provider: 'openrouter', model: 'openai/gpt-4.1', usage: {}, metrics: { attemptCount: 1 } };
    });
    const result = await semantic.analyze({ transcript, transcriptHash: 'audit-hash' }, {
      runCompletion, env: { OPENROUTER_API_KEY: 'test-only' }, config: {
        provider: 'openrouter', model: 'openai/gpt-4.1', fallback: []
      }
    });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(result.corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'GRAMMAR', symbol: 'AGR' }),
      expect.objectContaining({ category: 'CONTENT', symbol: 'DEV' })
    ]));
    expect(result.diagnostics).toMatchObject({ rawCorrectionCount: 2, acceptedCorrectionCount: 2,
      categoryAudit: { requested: true, categories: auditCategories },
      allCategoriesReviewed: true, totalExpectedSymbols: 28, totalReceivedUniqueSymbols: 28,
      incompleteReviewCategories: [],
      returnedByCategory: { CONTENT: 1, GRAMMAR: 1 }, acceptedByCategory: { CONTENT: 1, GRAMMAR: 1 } });
    expect(result.diagnostics.symbolReviewCoverage.CONTENT.sources).toEqual(['initial', 'targeted-repair']);
  });
});

describe('deterministic canonical hybrid merge', () => {
  const legend = writing.defaultLegend();
  const normalize = (raw, source) => canonical.normalizeCorrection(raw, 'students is here.', [], legend, source);
  const base = { category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is',
    startChar: 0, endChar: 11, message: 'Agreement.', suggestedText: 'students are', confidence: 0.99 };

  test('AI-only merge handles exact duplicates and counts them once', () => {
    const ai1 = normalize(base, 'AI');
    const ai2 = normalize({ ...base, message: 'Plural agreement.' }, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [], aiCorrections: [ai1, ai2] });
    expect(merged.corrections).toHaveLength(1);
    expect(merged.corrections[0].source).toBe('AI');
    expect(merged.diagnostics.exactDuplicates).toBe(1);
    expect(canonical.statistics(merged.corrections)).toMatchObject({ grammar: 1, total: 1 });
  });

  test('preserves distinct corrections on different spans', () => {
    const agr = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is',
      startChar: 0, endChar: 11, message: 'Agreement.', suggestedText: 'students are', confidence: 0.99 },
    'students is here.', [], legend, 'AI');
    const art = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'ART', quotedText: 'here',
      startChar: 12, endChar: 16, message: 'Article issue.', suggestedText: 'here', confidence: 0.95 },
    'students is here.', [], legend, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [], aiCorrections: [agr, art] });
    expect(merged.corrections).toHaveLength(2);
    expect(merged.corrections.map((item) => item.symbol)).toEqual(['AGR', 'ART']);
    expect(merged.diagnostics.overlapDuplicates).toBe(0);
  });

  test('AI-only merge prefers higher confidence for same location corrections', () => {
    const text = 'every student cames to class';
    const ai1 = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'student cames',
      startChar: 6, endChar: 19, suggestedText: 'student comes', message: 'Use the singular verb form.', confidence: 0.96 },
    text, [], legend, 'AI');
    const ai2 = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'student cames',
      startChar: 6, endChar: 19, suggestedText: 'student comes', message: 'Agreement issue.', confidence: 0.98 },
    text, [], legend, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [], aiCorrections: [ai1, ai2] });
    expect(merged.corrections).toHaveLength(1);
    expect(merged.corrections[0]).toMatchObject({ source: 'AI', category: 'GRAMMAR', symbol: 'AGR', suggestedText: 'student comes', confidence: 0.98 });
    expect(merged.diagnostics.exactDuplicates).toBe(1);
    expect(merged.diagnostics.contextualOverrides).toBe(0);
    expect(merged.diagnostics.rejectedIds).toHaveLength(1);
  });

  test('semantic prompt requires independent five-category AI-only review', () => {
    const text = 'there are a big problem every student cames Taking a taxis is than taken private cars cars gives without pay more money';
    const built = semantic.buildSemanticRequest({ transcript: text, transcriptHash: 'a'.repeat(64), languageToolCorrections: [] });
    const prompt = built.messages[1].content;
    expect(prompt).toContain('five explicit full-transcript passes');
    expect(prompt).toContain('Analyze the entire canonical transcript independently');
    expect(prompt).toContain('No external grammar checker is available');
    expect(prompt).toContain('Pass 3 GRAMMAR');
    expect(prompt).toContain('Pass 5 MECHANICS');
    expect(prompt).not.toContain('LanguageTool exclusions');
    expect(prompt).not.toContain('LanguageTool auxiliary');
  });

  test('repeated errors at different locations remain separate and statistics equal final records', () => {
    const text = 'students is here; students is ready';
    const { startChar, endChar, ...withoutOffsets } = base;
    const first = canonical.normalizeCorrection({ ...withoutOffsets, occurrence: 0 }, text, [], legend, 'AI');
    const second = canonical.normalizeCorrection({ ...withoutOffsets, occurrence: 1 }, text, [], legend, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ aiCorrections: [second, first] });
    expect(merged.corrections).toHaveLength(2);
    expect(canonical.statistics(merged.corrections)).toEqual({
      content: 0, organization: 0, grammar: 2, vocabulary: 0, mechanics: 0, total: 2
    });
  });

  test('retains a distinct Content correction and derives statistics only from the merged list', () => {
    const text = 'The claim needs specific support.';
    const ai = canonical.normalizeCorrection(finding({ quotedText: 'claim', startChar: 4, endChar: 9 }),
      text, [], legend, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ aiCorrections: [ai] });
    expect(merged.corrections).toHaveLength(1);
    expect(canonical.statistics(merged.corrections)).toMatchObject({ content: 1, total: 1 });
  });

  test('rubric deductions never fabricate corrections and coverage mismatch is diagnostic only', () => {
    const statistics = canonical.statistics([]);
    expect(statistics.content).toBe(0);
    expect(pipeline.hasHolisticCoverageMismatch({ CONTENT: { score: 13, maxScore: 20 } }, statistics)).toBe(true);
    expect(statistics).toEqual({ content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0 });
    expect(pipeline.holisticCoverageMismatchCategories({ CONTENT: { score: 13, maxScore: 20 },
      ORGANIZATION: { score: 11, maxScore: 20 }, VOCABULARY: { score: 10, maxScore: 20 } }, statistics))
      .toEqual(['CONTENT', 'ORGANIZATION', 'VOCABULARY']);
  });

  test('displayed semantic attempt count matches primary and fallback retry plans', () => {
    expect(pipeline.plannedSemanticAttempts({ chain: [{}, {}, {}], primaryRetries: 1, fallbackRetries: 0 })).toBe(4);
  });

  test('produces auditable LT, AI, merge, and final statistics for a synthetic learner fixture', () => {
    const text = 'It have benefits. They may planned carefully. Because the lesson was difficult. This idea changes everything. No conclusion is provided.';
    const matches = [
      { offset: text.indexOf('It have'), length: 7, message: 'Agreement.', replacements: [{ value: 'It has' }],
        rule: { id: 'HE_VERB_AGR', category: { id: 'GRAMMAR' }, issueType: 'grammar' } },
      { offset: text.indexOf('may planned'), length: 11, message: 'Verb form.', replacements: [{ value: 'may plan' }],
        rule: { id: 'MD_BASEFORM', category: { id: 'GRAMMAR' }, issueType: 'grammar' } },
      { offset: text.indexOf('Because the lesson was difficult.'), length: 33, message: 'Fragment.',
        replacements: [{ value: 'The lesson was difficult.' }],
        rule: { id: 'SENTENCE_FRAGMENT_ERROR', category: { id: 'GRAMMAR' }, issueType: 'grammar' } }
    ];
    const ltDiagnostics = writing.languageToolDiagnostics(text, { matches }, writing.defaultLegend());
    const lt = writing.toIssuesFromLanguageTool(text, { matches }, writing.defaultLegend()).map((issue) =>
      canonical.normalizeCorrection({ category: issue.groupKey, symbol: issue.symbol, quotedText: issue.wrongText,
        message: issue.message, suggestedText: issue.suggestion, startChar: issue.start, endChar: issue.end,
        confidence: 1 }, text, [], writing.defaultLegend(), 'LANGUAGETOOL'));
    const rawAi = [
      finding({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', suggestedText: 'It has' }),
      finding({ category: 'GRAMMAR', symbol: 'VF', quotedText: 'may planned', suggestedText: 'may plan' }),
      finding({ category: 'GRAMMAR', symbol: 'FRAG', quotedText: 'Because the lesson was difficult.', suggestedText: 'The lesson was difficult.' }),
      finding({ category: 'CONTENT', symbol: 'CL', correctionKind: 'global', quotedText: 'This idea changes everything.', suggestedText: '' }),
      finding({ category: 'ORGANIZATION', symbol: 'CONC', correctionKind: 'global', quotedText: 'No conclusion is provided.', suggestedText: '' })
    ];
    const validated = semantic.validateCorrections(rawAi, { transcript: text,
      legend: semantic.compactSemanticLegend(writing.defaultLegend()) });
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [], aiCorrections: validated.corrections });
    expect(validated.diagnostics).toMatchObject({ rawCorrectionCount: 5, acceptedCorrectionCount: 5,
      rejectedCorrectionCount: 0, returnedByCategory: { CONTENT: 1, ORGANIZATION: 1, GRAMMAR: 3 } });
    expect(merged.diagnostics).toMatchObject({ exactDuplicates: 0, overlapDuplicates: 0, conflicts: 0 });
    expect(canonical.statistics(merged.corrections)).toEqual({ content: 1, organization: 1,
      grammar: 3, vocabulary: 0, mechanics: 0, total: 5 });
  });
});

describe('sanitized two-page expert coverage fixture', () => {
  test('obvious grounded category coverage is retained without asserting an exact model total', () => {
    const validated = semantic.validateCorrections(expertFixture.corrections, {
      transcript: expertFixture.transcript,
      legend: semantic.compactSemanticLegend(writing.defaultLegend())
    });
    const retained = new Set(validated.corrections.map((item) => item.category));
    for (const category of expertFixture.expectedMinimumCategories) expect(retained.has(category)).toBe(true);
    expect(validated.diagnostics.rejectedCorrectionCount).toBe(0);
  });

  test('non-empty but meaningless provider reasons are replaced with deterministic neutral wording', () => {
    const reviews = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map((category) => ({
      category, reviewed: true, findingCount: 0, noFindingReason: category === 'VOCABULARY' ? 'N/A' : 'No grounded finding.'
    }));
    const diagnostics = semantic.validateCategoryReviews(reviews, []);
    expect(reviews.find((review) => review.category === 'VOCABULARY').noFindingReason)
      .toBe(semantic.DEFAULT_NO_FINDING_REASON);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'VOCABULARY', correctionCount: 0,
        normalizationReason: 'zero_reason_defaulted' })
    ]));
  });
});
