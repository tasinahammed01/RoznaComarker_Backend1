'use strict';

const schemas = require('../src/services/structuredOutputSchemas.service');
const policy = require('../src/services/aiCorrectionPolicy.service');

function findEmptyEnums(value, path = '$') {
  if (!value || typeof value !== 'object') return [];
  const found = Array.isArray(value.enum) && value.enum.length === 0 ? [path] : [];
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') found.push(...findEmptyEnums(child, `${path}.${key}`));
  }
  return found;
}

describe('assessment structured output schemas', () => {
  test('semantic corrections bind the actual source hash, use the canonical enum, and allow zero findings', () => {
    const schema = schemas.semanticCorrectionsSchema('actual-hash');
    expect(schema.properties.transcriptHash).toEqual({ type: 'string', const: 'actual-hash' });
    expect(Object.keys(schema.properties.categories.properties)).toEqual(schemas.CORRECTION_CATEGORIES);
    expect(schema.properties.categories.required).toEqual(schemas.CORRECTION_CATEGORIES);
    const content = schema.properties.categories.properties.CONTENT;
    expect(content.required).toEqual(['reviewed', 'reviewedSymbols', 'noFindingReason', 'corrections']);
    expect(content.properties.reviewedSymbols).toMatchObject({ minItems: 5, maxItems: 5, uniqueItems: true,
      items: { enum: schemas.CATEGORY_SYMBOLS.CONTENT } });
    expect(content.properties.findingCount).toBeUndefined();
    expect(content.properties.corrections.items.properties.category).toBeUndefined();
    expect(content.properties.corrections.items.properties.symbol.enum).toEqual(schemas.CATEGORY_SYMBOLS.CONTENT);
    expect(content.properties.corrections.items.properties.correctionKind.enum).toEqual(['localized', 'global']);
    expect(schema.properties.categories.properties.GRAMMAR.properties.corrections.items.properties.correctionKind.enum)
      .toEqual(['localized']);
    expect(content.properties.corrections.items.properties.severity.enum).toEqual(['low', 'medium', 'high']);
    expect(content.properties.corrections.items.properties.stylePreference).toEqual({ type: 'boolean', const: false });
    expect(JSON.stringify(schema)).not.toContain('localized|global');
    expect(JSON.stringify(schema)).not.toContain('<exact supplied hash>');
  });

  test('semantic correction symbol enums use the resolved authoritative legend catalog', () => {
    const schema = schemas.semanticCorrectionsSchema('hash', ['CONTENT'], { CONTENT: ['DEV', 'REL'] });
    expect(schema.properties.categories.properties.CONTENT.properties.corrections.items.properties.symbol.enum)
      .toEqual(['DEV', 'REL']);
  });

  test.each(Object.entries(schemas.CATEGORY_SYMBOLS))('%s requires its complete exact reviewed-symbol catalog', (category, symbols) => {
    const schema = schemas.semanticCorrectionsSchema('hash');
    const reviewed = schema.properties.categories.properties[category].properties.reviewedSymbols;
    expect(reviewed).toMatchObject({ minItems: symbols.length, maxItems: symbols.length, uniqueItems: true,
      items: { type: 'string', enum: symbols } });
  });

  test('rubric provider schema uses backend-owned evidence identifiers', () => {
    const schema = schemas.semanticRubricAssessmentSchema('hash', {
      transcriptEvidenceIds: ['ev-2', 'ev-1', 'ev-2'],
      correctionIds: { CONTENT: ['c2', 'c1', 'c2'], ORGANIZATION: ['o1'], VOCABULARY: [] }
    });
    const category = schema.properties.categories.properties.CONTENT;
    expect(category.properties.strengthEvidence.items.required).toContain('evidenceId');
    expect(category.properties.improvementEvidence.items.required).toContain('evidenceId');
    expect(JSON.stringify(category)).not.toContain('quotedText');
    expect(category.properties.strengthEvidence.items.properties.evidenceId.enum).toEqual(['ev-2', 'ev-1']);
    expect(category.properties.improvementEvidence.items.properties.correctionId.enum).toEqual([null, 'c2', 'c1']);
    expect(schema.properties.categories.properties.ORGANIZATION.properties.improvementEvidence.items
      .properties.correctionId.enum).toEqual([null, 'o1']);
    expect(schema.properties.categories.properties.VOCABULARY.properties.improvementEvidence.items
      .properties.correctionId.enum).toEqual([null]);
  });

  test('empty and request-isolated rubric catalogs cannot accept arbitrary IDs', () => {
    const empty = schemas.semanticRubricAssessmentSchema('hash');
    expect(empty.properties.categories.properties.CONTENT.properties.strengthEvidence.maxItems).toBe(0);
    expect(empty.properties.categories.properties.CONTENT.properties.improvementEvidence.maxItems).toBe(0);
    expect(empty.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).toEqual([schemas.NO_TRANSCRIPT_EVIDENCE_SENTINEL]);
    const first = schemas.semanticRubricAssessmentSchema('hash', { transcriptEvidenceIds: ['submission-a'] });
    const second = schemas.semanticRubricAssessmentSchema('hash', { transcriptEvidenceIds: ['submission-b'] });
    expect(first.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).not.toContain('submission-b');
    expect(second.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).not.toContain('submission-a');
  });

  test.each([
    ['complete catalogs', { transcriptEvidenceIds: ['ev-1'], correctionIds: {
      CONTENT: ['c1'], ORGANIZATION: ['o1'], VOCABULARY: ['v1'] } }],
    ['transcript only', { transcriptEvidenceIds: ['ev-1'], correctionIds: {} }],
    ['corrections only', { transcriptEvidenceIds: [], correctionIds: {
      CONTENT: ['c1'], ORGANIZATION: ['o1'], VOCABULARY: ['v1'] } }],
    ['empty catalogs', {}]
  ])('never emits an empty enum with %s', (_label, catalogs) => {
    const schema = schemas.semanticRubricAssessmentSchema('hash', catalogs);
    expect(findEmptyEnums(schema)).toEqual([]);
    for (const category of ['CONTENT', 'ORGANIZATION', 'VOCABULARY']) {
      const item = schema.properties.categories.properties[category];
      if (!(catalogs.transcriptEvidenceIds || []).length) {
        expect(item.properties.strengthEvidence.maxItems).toBe(0);
        expect(item.properties.strengthEvidence.items.properties.evidenceId.enum)
          .toEqual([schemas.NO_TRANSCRIPT_EVIDENCE_SENTINEL]);
      }
      if (!(catalogs.transcriptEvidenceIds || []).length && !(catalogs.correctionIds?.[category] || []).length) {
        expect(item.properties.improvementEvidence.maxItems).toBe(0);
      }
    }
  });

  test('rejects reserved sentinel collisions and keeps deterministic exact IDs', () => {
    expect(() => schemas.semanticRubricAssessmentSchema('hash', {
      transcriptEvidenceIds: [schemas.NO_TRANSCRIPT_EVIDENCE_SENTINEL]
    })).toThrow(/reserved identifier/iu);
    const schema = schemas.semanticRubricAssessmentSchema('hash', {
      transcriptEvidenceIds: ['ev-2', 'ev-1', 'ev-2']
    });
    expect(schema.properties.categories.properties.CONTENT.properties.strengthEvidence.items
      .properties.evidenceId.enum).toEqual(['ev-2', 'ev-1']);
  });

  test('all bounded canonical schemas are closed at their root', () => {
    for (const schema of [schemas.RUBRIC_SCHEMA, schemas.DETAILED_FEEDBACK_SCHEMA,
      schemas.semanticCorrectionsSchema('hash'), schemas.semanticRubricAssessmentSchema('hash')]) {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });
});
