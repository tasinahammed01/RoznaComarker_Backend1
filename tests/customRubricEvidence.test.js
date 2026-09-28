const { buildCorrectionEvidenceIndex, evidenceRelevantToCriterion, contradictionForSelection } =
  require('../src/services/customRubricEvidence.service');

describe('custom rubric evidence safeguards', () => {
  test('keeps uncertain transcript semantics ambiguous instead of proving irrelevance from missing keywords', () => {
    const criterion = { title: 'Organization and Structure', levels: [] };
    expect(evidenceRelevantToCriterion(criterion, [{ quotedText: 'short fragment', startChar: 40,
      finalQuarter: false }])).toMatchObject({ classification: 'AMBIGUOUS', relevant: true });
    expect(evidenceRelevantToCriterion(criterion, [{ quotedText: 'Cats are friendly household animals.', startChar: 40,
      finalQuarter: false }])).toMatchObject({ classification: 'AMBIGUOUS', relevant: true });
  });

  test.each(['Content Understanding and Relevance', 'Organization and Structure', 'Vocabulary / Word Choice'])
  ('rejects positively mismatched correction-only evidence for %s', title => {
    expect(evidenceRelevantToCriterion({ title }, [{ evidenceType: 'correction', category: 'MECHANICS',
      quotedText: 'speling' }])).toMatchObject({ classification: 'IRRELEVANT', reasonCode: 'CORRECTION_CATEGORY_MISMATCH' });
  });

  test('accepts organization correction evidence', () => {
    expect(evidenceRelevantToCriterion({ title: 'Organization and Structure' }, [
      { evidenceType: 'correction', category: 'ORGANIZATION' }
    ])).toMatchObject({ classification: 'RELEVANT' });
  });

  test.each([
    [{ title: 'Content Understanding and Relevance', levels: [{ description: 'Discusses effects with relevant examples.' }] },
      { quotedText: 'Students share course materials through social networks.', startChar: 120 }],
    [{ title: 'Responsibility and Opinion Expression' }, { quotedText: 'Privacy protects our safety online.', finalQuarter: true }],
    [{ title: 'Use of Examples' }, { quotedText: 'Maya shared her lecture notes with her study group.' }],
    [{ title: 'Clarity and Language Use' }, { quotedText: 'Students learn together online.' }],
    [{ title: 'Distinctive scholarly voice' }, { quotedText: 'Students learn together online.' }]
  ])('accepts grounded holistic evidence without mandatory lexical markers', (criterion, evidence) => {
    expect(evidenceRelevantToCriterion(criterion, [evidence]).classification).not.toBe('IRRELEVANT');
  });

  test('retains the reported high-density language contradiction at 641 words', () => {
    const correctionIndex = buildCorrectionEvidenceIndex([
      ...Array.from({ length: 51 }, () => ({ category: 'GRAMMAR' })),
      ...Array.from({ length: 5 }, () => ({ category: 'MECHANICS' }))
    ], Array(641).fill('word').join(' '));
    expect(contradictionForSelection({ criterion: { title: 'Clarity and Language Use' },
      level: { title: 'Good', description: 'Writing is mostly clear with minor errors.' }, correctionIndex })).not.toBeNull();
    expect(contradictionForSelection({ criterion: { title: 'Clarity and Language Use' },
      level: { title: 'Excellent', description: 'Free of grammatical errors.' }, correctionIndex })).not.toBeNull();
  });

  test('retains strong organization contradiction', () => {
    const correctionIndex = buildCorrectionEvidenceIndex(Array.from({ length: 8 }, () => ({ category: 'ORGANIZATION' })),
      Array(300).fill('word').join(' '));
    expect(contradictionForSelection({ criterion: { title: 'Organization' },
      level: { title: 'Good', description: 'Well-organized with effective transitions.' }, correctionIndex })).not.toBeNull();
  });

  test('accepts criterion-relevant organization evidence', () => {
    const criterion = { title: 'Organization and Structure', levels: [] };
    expect(evidenceRelevantToCriterion(criterion, [{ quotedText: 'However, the next reason changes the direction.',
      startChar: 40, finalQuarter: false }])).toMatchObject({ available: true, relevant: true });
  });

  test('uses correction density to distinguish contradictory and legitimate Good language selections', () => {
    const criterion = { title: 'Grammar and Language Use' };
    const level = { title: 'Good', description: 'Mostly clear with a few minor errors.' };
    const transcript = Array.from({ length: 100 }, () => 'word').join(' ');
    const dense = buildCorrectionEvidenceIndex(Array.from({ length: 12 }, (_, index) => ({
      id: `g${index}`, category: 'GRAMMAR'
    })), transcript);
    const sparse = buildCorrectionEvidenceIndex([{ id: 'g1', category: 'GRAMMAR' }], transcript);
    expect(contradictionForSelection({ criterion, level, correctionIndex: dense })).toMatchObject({ count: 12, density: 12 });
    expect(contradictionForSelection({ criterion, level, correctionIndex: sparse })).toBeNull();
  });
});
