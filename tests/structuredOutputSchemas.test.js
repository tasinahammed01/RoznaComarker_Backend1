'use strict';

const schemas = require('../src/services/structuredOutputSchemas.service');
const policy = require('../src/services/aiCorrectionPolicy.service');

describe('assessment structured output schemas', () => {
  test('semantic corrections bind the actual source hash, use the canonical enum, and allow zero findings', () => {
    const schema = schemas.semanticCorrectionsSchema('actual-hash');
    expect(schema.properties.transcriptHash).toEqual({ type: 'string', const: 'actual-hash' });
    expect(schema.properties.corrections.minItems).toBeUndefined();
    expect(schema.properties.corrections.maxItems).toBe(policy.MAX_AI_CORRECTIONS);
    expect(schema.properties.categoryReviews).toMatchObject({ minItems: 5, maxItems: 5 });
    expect(schema.properties.corrections.items.properties.correctionKind.enum)
      .toEqual(['localized', 'global']);
    expect(JSON.stringify(schema)).not.toContain('localized|global');
    expect(JSON.stringify(schema)).not.toContain('<exact supplied hash>');
  });

  test('all bounded canonical schemas are closed at their root', () => {
    for (const schema of [schemas.RUBRIC_SCHEMA, schemas.DETAILED_FEEDBACK_SCHEMA,
      schemas.semanticCorrectionsSchema('hash'), schemas.semanticRubricAssessmentSchema('hash')]) {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });
});
