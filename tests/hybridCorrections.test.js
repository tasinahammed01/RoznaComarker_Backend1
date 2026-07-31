jest.mock('../src/models/CorrectionLegend', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) }))
}));

const semantic = require('../src/services/semanticWritingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const writing = require('../src/services/writingCorrections.service');
const policy = require('../src/services/aiCorrectionPolicy.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');

const finding = (overrides = {}) => ({
  category: 'CONTENT', symbol: 'DEV', quotedText: 'claim', occurrence: 0,
  message: 'Develop this claim with relevant evidence.', suggestedText: 'claim with evidence',
  confidence: 0.95, severity: 'medium', stylePreference: false, ...overrides
});
const reviewsFor = (corrections = []) => Object.keys(policy.CATEGORY_POLICY).map((category) => {
  const findingCount = corrections.filter((item) => item.category === category).length;
  return { category, reviewed: true, findingCount,
    noFindingReason: findingCount ? '' : 'No additional grounded finding after complete review.' };
});

describe('safe hybrid correction policy', () => {
  const legend = semantic.compactSemanticLegend(writing.defaultLegend());

  test('semantic prompt uses the real hash and a valid correctionKind example', () => {
    const request = semantic.buildSemanticRequest({ transcript: 'Exact essay.', transcriptHash: 'hash-123' });
    const prompt = request.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('"transcriptHash":"hash-123"');
    expect(prompt).toContain('"correctionKind":"localized"');
    expect(prompt).toContain('"correctionKind":"global"');
    expect(prompt).not.toContain('localized|global');
    expect(prompt).not.toContain('<exact supplied hash>');
  });

  test('requires one consistent review for every canonical category while allowing zero Content findings', () => {
    const empty = { transcriptHash: 'hash', corrections: [] };
    expect(semantic.parseJson(JSON.stringify({ ...empty, categoryReviews: reviewsFor([]) }), 'hash'))
      .toMatchObject({ corrections: [] });
    expect(() => semantic.parseJson(JSON.stringify(empty), 'hash')).toThrow(expect.objectContaining({
      validationStage: 'category_reviews'
    }));
    const duplicate = reviewsFor([]); duplicate[4] = { ...duplicate[0] };
    expect(() => semantic.parseJson(JSON.stringify({ ...empty, categoryReviews: duplicate }), 'hash'))
      .toThrow(expect.objectContaining({ validationStage: 'category_reviews' }));
    const mismatchFinding = finding();
    expect(() => semantic.parseJson(JSON.stringify({ transcriptHash: 'hash', corrections: [mismatchFinding],
      categoryReviews: reviewsFor([]) }), 'hash')).toThrow(expect.objectContaining({
      validationStage: 'category_review_count'
    }));
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
    const merged = canonical.mergeCanonicalCorrections({ languageToolCorrections: lt, aiCorrections: validated.corrections });
    expect(ltDiagnostics).toMatchObject({ rawMatches: 3, accepted: 3, dropped: 0,
      droppedGrammarRuleIds: [], byFinalClassification: { 'GRAMMAR/AGR': 1, 'GRAMMAR/VF': 1, 'GRAMMAR/FRAG': 1 } });
    expect(validated.diagnostics).toMatchObject({ rawCorrectionCount: 5, acceptedCorrectionCount: 5,
      rejectedCorrectionCount: 0, returnedByCategory: { CONTENT: 1, ORGANIZATION: 1, GRAMMAR: 3 } });
    expect(merged.diagnostics).toMatchObject({ exactDuplicates: 3, overlapDuplicates: 0, conflicts: 0 });
    expect(canonical.statistics(merged.corrections)).toEqual({ content: 1, organization: 1,
      grammar: 3, vocabulary: 0, mechanics: 0, total: 5 });
  });
});
