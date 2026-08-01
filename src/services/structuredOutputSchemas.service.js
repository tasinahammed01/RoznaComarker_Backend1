'use strict';

const policy = require('./aiCorrectionPolicy.service');

const CORRECTION_CATEGORIES = Object.freeze(['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS']);
const CORRECTION_KINDS = Object.freeze(['localized', 'global']);
const CORRECTION_SEVERITIES = Object.freeze(['low', 'medium', 'high']);
const CORRECTION_FIELDS = Object.freeze(['category', 'symbol', 'correctionKind', 'quotedText', 'occurrence',
  'message', 'suggestedText', 'confidence', 'severity', 'stylePreference']);

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
      category: { type: 'string', enum: CORRECTION_CATEGORIES },
      reviewed: { type: 'boolean', const: true },
      noFindingReason: string(320)
    }) },
    corrections: { type: 'array', maxItems: policy.MAX_AI_CORRECTIONS, items: closedObject({
      category: { type: 'string', enum: CORRECTION_CATEGORIES },
      symbol: string(32, { minLength: 1 }),
      correctionKind: { type: 'string', enum: CORRECTION_KINDS },
      quotedText: string(500, { minLength: 1 }),
      occurrence: { type: 'integer', minimum: 0 },
      message: string(240, { minLength: 1 }),
      suggestedText: string(300),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      severity: { type: 'string', enum: CORRECTION_SEVERITIES },
      stylePreference: { type: 'boolean', const: false }
    }) }
  });
}

const MAX_RUBRIC_EVIDENCE_IDS = 512;
const NO_TRANSCRIPT_EVIDENCE_SENTINEL = '__NO_TRANSCRIPT_EVIDENCE_AVAILABLE__';
const uniqueIds = (values) => {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim()).filter(Boolean);
  if (normalized.includes(NO_TRANSCRIPT_EVIDENCE_SENTINEL)) {
    throw new Error('Rubric evidence catalog contains a reserved identifier.');
  }
  return Object.freeze([...new Set(normalized)].slice(0, MAX_RUBRIC_EVIDENCE_IDS));
};

function categoryAssessment(transcriptEvidenceIds, correctionIds) {
  const transcriptIds = uniqueIds(transcriptEvidenceIds);
  const categoryCorrectionIds = uniqueIds(correctionIds);
  const evidence = closedObject({ evidenceId: { type: 'string',
    enum: transcriptIds.length ? transcriptIds : [NO_TRANSCRIPT_EVIDENCE_SENTINEL] },
    explanation: string(320, { minLength: 1 }) });
  const improvement = closedObject({
    evidenceType: { type: 'string', enum: ['correction', 'transcript'] },
    correctionId: { type: ['string', 'null'], enum: [null, ...categoryCorrectionIds] },
    evidenceId: { type: ['string', 'null'], enum: [null, ...transcriptIds] },
    explanation: string(320, { minLength: 1 }),
    suggestion: string(240, { minLength: 1 })
  });
  return closedObject({
    score: { type: 'number', minimum: 0, maximum: 20 }, maxScore: { type: 'number', const: 20 },
    comment: string(320, { minLength: 1 }),
    strengthEvidence: { type: 'array', maxItems: transcriptIds.length ? 20 : 0, items: evidence },
    improvementEvidence: { type: 'array', maxItems: (transcriptIds.length || categoryCorrectionIds.length) ? 20 : 0,
      items: improvement }
  });
}

function semanticRubricAssessmentSchema(sourceHash, { transcriptEvidenceIds = [], correctionIds = {} } = {}) {
  return closedObject({ sourceHash: { type: 'string', const: String(sourceHash) }, categories: closedObject({
    CONTENT: categoryAssessment(transcriptEvidenceIds, correctionIds.CONTENT),
    ORGANIZATION: categoryAssessment(transcriptEvidenceIds, correctionIds.ORGANIZATION),
    VOCABULARY: categoryAssessment(transcriptEvidenceIds, correctionIds.VOCABULARY)
  }) });
}

const DETAILED_FEEDBACK_SCHEMA = closedObject({
  grammar: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  structure: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  content: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) }),
  overall: closedObject({ score: { type: 'number', minimum: 0, maximum: 5 }, text: string(1200, { minLength: 1 }) })
});

module.exports = { RUBRIC_SCHEMA, DETAILED_FEEDBACK_SCHEMA, CORRECTION_CATEGORIES, CORRECTION_KINDS,
  CORRECTION_SEVERITIES, CORRECTION_FIELDS, MAX_RUBRIC_EVIDENCE_IDS,
  NO_TRANSCRIPT_EVIDENCE_SENTINEL, uniqueIds,
  semanticCorrectionsSchema, semanticRubricAssessmentSchema };
