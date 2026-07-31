'use strict';

const policy = require('./aiCorrectionPolicy.service');

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const closedObject = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required
});

const RUBRIC_SCHEMA = closedObject({
  title: string(240, { minLength: 1 }),
  levels: { type: 'array', minItems: 3, maxItems: 5, items: closedObject({
    title: string(120, { minLength: 1 }), maxPoints: { type: 'integer', minimum: 0, maximum: 100 }
  }) },
  criteria: { type: 'array', minItems: 3, maxItems: 10, items: closedObject({
    title: string(240, { minLength: 1 }),
    cells: { type: 'array', minItems: 3, maxItems: 5, items: string(1200) }
  }) }
});

function semanticCorrectionsSchema(transcriptHash) {
  return closedObject({
    transcriptHash: { type: 'string', const: String(transcriptHash) },
    categoryReviews: { type: 'array', minItems: 5, maxItems: 5, items: closedObject({
      category: { type: 'string', enum: ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'] },
      reviewed: { type: 'boolean', const: true },
      findingCount: { type: 'integer', minimum: 0, maximum: policy.MAX_AI_CORRECTIONS_PER_CATEGORY },
      noFindingReason: string(320)
    }) },
    corrections: { type: 'array', maxItems: policy.MAX_AI_CORRECTIONS, items: closedObject({
      category: { type: 'string', enum: ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'] },
      symbol: string(32, { minLength: 1 }),
      correctionKind: { type: 'string', enum: ['localized', 'global'] },
      quotedText: string(500, { minLength: 1 }),
      occurrence: { type: 'integer', minimum: 0 },
      message: string(240, { minLength: 1 }),
      suggestedText: string(300),
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    }) }
  });
}

const evidence = closedObject({ quotedText: string(500, { minLength: 1 }),
  explanation: string(320, { minLength: 1 }) });
const improvement = closedObject({
  evidenceType: { type: 'string', enum: ['correction', 'transcript'] },
  correctionId: { type: ['string', 'null'], maxLength: 120 },
  quotedText: string(500, { minLength: 1 }), explanation: string(320, { minLength: 1 }),
  suggestion: string(240, { minLength: 1 })
});
const categoryAssessment = closedObject({
  score: { type: 'number', minimum: 0, maximum: 20 }, maxScore: { type: 'number', const: 20 },
  comment: string(320, { minLength: 1 }),
  strengthEvidence: { type: 'array', maxItems: 20, items: evidence },
  improvementEvidence: { type: 'array', maxItems: 20, items: improvement }
});

function semanticRubricAssessmentSchema(sourceHash) {
  return closedObject({ sourceHash: { type: 'string', const: String(sourceHash) }, categories: closedObject({
    CONTENT: categoryAssessment, ORGANIZATION: categoryAssessment, VOCABULARY: categoryAssessment
  }) });
}

const DETAILED_FEEDBACK_SCHEMA = closedObject({
  grammar: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  structure: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  content: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  overall: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) })
});

module.exports = { RUBRIC_SCHEMA, DETAILED_FEEDBACK_SCHEMA, semanticCorrectionsSchema,
  semanticRubricAssessmentSchema };
