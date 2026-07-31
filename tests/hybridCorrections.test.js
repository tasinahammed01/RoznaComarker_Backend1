jest.mock('../src/models/CorrectionLegend', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) }))
}));

const semantic = require('../src/services/semanticWritingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const writing = require('../src/services/writingCorrections.service');
const policy = require('../src/services/aiCorrectionPolicy.service');

const finding = (overrides = {}) => ({
  category: 'CONTENT', symbol: 'DEV', quotedText: 'claim', occurrence: 0,
  message: 'Develop this claim with relevant evidence.', suggestedText: 'claim with evidence',
  confidence: 0.95, severity: 'medium', stylePreference: false, ...overrides
});

describe('safe hybrid correction policy', () => {
  const legend = semantic.compactSemanticLegend(writing.defaultLegend());

  test('semantic prompt uses the real hash and a valid correctionKind example', () => {
    const request = semantic.buildSemanticRequest({ transcript: 'Exact essay.', transcriptHash: 'hash-123' });
    const prompt = request.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('"transcriptHash":"hash-123"');
    expect(prompt).toContain('"correctionKind":"localized"');
    expect(prompt).not.toContain('localized|global');
    expect(prompt).not.toContain('<exact supplied hash>');
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

  test('sends compact LanguageTool evidence while retaining all-category instructions', () => {
    const request = semantic.buildSemanticRequest({
      transcript: 'students is here.', transcriptHash: 'hash',
      languageToolCorrections: [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students is',
        startChar: 0, endChar: 11, suggestedText: 'students are',
        message: 'A deliberately long private explanation that must not be included.' }]
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain('"quotedText":"students is"');
    expect(prompt).toContain('"suggestedText":"students are"');
    expect(prompt).not.toContain('deliberately long private explanation');
    for (const category of Object.keys(policy.CATEGORY_POLICY)) expect(prompt).toContain(category);
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

  test('keeps LanguageTool for an exact cross-engine duplicate and counts it once', () => {
    const lt = normalize(base, 'LANGUAGETOOL');
    const ai = normalize({ ...base, message: 'Plural agreement.' }, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [lt], aiCorrections: [ai] });
    expect(merged.corrections).toHaveLength(1);
    expect(merged.corrections[0].source).toBe('LANGUAGETOOL');
    expect(merged.diagnostics.exactDuplicates).toBe(1);
    expect(canonical.statistics(merged.corrections)).toMatchObject({ grammar: 1, total: 1 });
  });

  test('deduplicates equivalent overlapping corrections but preserves distinct issues on one span', () => {
    const lt = normalize(base, 'LANGUAGETOOL');
    const overlap = canonical.normalizeCorrection({ ...base, quotedText: 'students is here', endChar: 16,
      suggestedText: 'students are', message: 'Plural agreement.' }, 'students is here.', [], legend, 'AI');
    const article = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'ART', quotedText: 'students is',
      startChar: 0, endChar: 11, message: 'Article issue.', suggestedText: 'the students are', confidence: 0.95 },
    'students is here.', [], legend, 'AI');
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: [lt], aiCorrections: [overlap, article] });
    expect(merged.corrections).toHaveLength(2);
    expect(merged.corrections.map((item) => item.symbol)).toEqual(['AGR', 'ART']);
    expect(merged.diagnostics.overlapDuplicates).toBe(1);
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
});
