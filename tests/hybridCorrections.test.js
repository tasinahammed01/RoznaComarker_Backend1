jest.mock('../src/models/CorrectionLegend', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) }))
}));

const semantic = require('../src/services/semanticWritingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const writing = require('../src/services/writingCorrections.service');
const policy = require('../src/services/aiCorrectionPolicy.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const expertFixture = require('./fixtures/twoPageLearnerEssaySanitized');

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

describe('safe hybrid correction policy', () => {
  const legend = semantic.compactSemanticLegend(writing.defaultLegend());

  test('builds a compact prompt with schema and transcript hash', () => {
    const request = semantic.buildSemanticRequest({
      transcript: 'Exact essay.', transcriptHash: 'hash-123',
      languageToolCorrections: []
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain('"transcriptHash":"hash-123"');
    expect(prompt).toContain('"correctionKind":"localized"');
    expect(prompt).not.toContain('localized|global');
    expect(prompt).not.toContain('<exact supplied hash>');
  });

  test('requires one consistent review for every canonical category while allowing zero Content findings', () => {
    const empty = { transcriptHash: 'hash', corrections: [] };
    expect(semantic.parseJson(JSON.stringify({ ...empty, categoryReviews: reviewsFor([]) }), 'hash'))
      .toMatchObject({ corrections: [] });
    expect(() => semantic.parseJson(JSON.stringify(empty), 'hash')).toThrow(expect.objectContaining({
      validationStage: 'semantic_schema', jsonPath: '$.categoryReviews', requiredPropertyMissing: true
    }));
    const duplicate = reviewsFor([]); duplicate[4] = { ...duplicate[0] };
    expect(() => semantic.parseJson(JSON.stringify({ ...empty, categoryReviews: duplicate }), 'hash'))
      .toThrow(expect.objectContaining({ validationStage: 'category_reviews' }));
    const mismatchFinding = finding();
    const legacyReviews = reviewsFor([]).map((review) => ({ ...review, findingCount: 99 }));
    const parsed = semantic.parseJson(JSON.stringify({ transcriptHash: 'hash', corrections: [mismatchFinding],
      categoryReviews: legacyReviews }), 'hash');
    expect(parsed.categoryReviews.find((review) => review.category === 'CONTENT')).toMatchObject({ findingCount: 1,
      noFindingReason: '' });
    expect(parsed.compatibilityDiagnostics).toEqual({ legacyFindingCountIgnored: true });
  });

  test('reports a sanitized JSON path for null and missing canonical fields', () => {
    const nullReason = reviewsFor([]); nullReason[0].noFindingReason = null;
    expect(() => semantic.parseJson(JSON.stringify({ transcriptHash: 'hash', categoryReviews: nullReason,
      corrections: [] }), 'hash')).toThrow(expect.objectContaining({ validationStage: 'semantic_schema',
      jsonPath: '$.categoryReviews[0].noFindingReason', expected: expect.stringContaining('string'), actualType: 'null' }));
    const missing = finding(); delete missing.suggestedText;
    expect(() => semantic.parseJson(JSON.stringify({ transcriptHash: 'hash', categoryReviews: reviewsFor([missing]),
      corrections: [missing] }), 'hash')).toThrow(expect.objectContaining({ validationStage: 'semantic_schema',
      jsonPath: '$.corrections[0].suggestedText', requiredPropertyMissing: true, candidateIndex: 0 }));
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
      rejectionReasonsByCategory: { CONTENT: { LOW_CONFIDENCE: 1, UNGROUNDED_EVIDENCE: 1 } } });
    expect(result.diagnostics.rejectionDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'CONTENT', rejectionCode: 'LOW_CONFIDENCE',
        validationStage: 'confidence_validation', candidateIndex: 0, quotedTextHash: expect.any(String) }),
      expect.objectContaining({ category: 'CONTENT', rejectionCode: 'UNGROUNDED_EVIDENCE',
        validationStage: 'grounding_validation', candidateIndex: 1, quotedTextHash: expect.any(String) })
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
      LOW_CONFIDENCE: 1, STYLE_PREFERENCE: 1, UNGROUNDED_EVIDENCE: 1, INVALID_SCHEMA: 1
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
    const payload = JSON.stringify({ transcriptHash: 'hash',
      corrections: Array.from({ length: policy.MAX_AI_CORRECTIONS + 1 }, () => finding()) });
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

  test('zero category reviews require explicit diagnostic reasons', () => {
    const reviews = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map((category) => ({
      category, reviewed: true, findingCount: 0, noFindingReason: category === 'VOCABULARY' ? '' : 'No grounded finding.'
    }));
    expect(() => semantic.validateCategoryReviews(reviews, [])).toThrow(expect.objectContaining({
      validationStage: 'category_review_reason'
    }));
  });
});
