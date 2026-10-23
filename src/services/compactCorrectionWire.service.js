'use strict';

// Provider-only representation. Public canonical corrections keep their existing
// fields; review evidence is never inferred from the request alone.
const VERSION = 'astra-compact-review-v1';
const fields = ['symbol', 'correctionKind', 'quotedText', 'occurrence', 'suggestedText', 'confidence', 'severity'];
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
function schema(hash, categories, catalog) {
  const symbols = [...new Set(Object.values(catalog).flat())];
  return { ...object({ reviewContract: { type: 'string', const: VERSION },
    transcriptHash: { type: 'string', const: String(hash) },
    categories: object(Object.fromEntries(categories.map(category => [category, object({
      reviewed: { type: 'boolean', const: true },
      reviewedSymbols: { type: 'array', minItems: catalog[category].length, maxItems: catalog[category].length,
        items: { type: 'string', enum: catalog[category] } },
      corrections: { type: 'array', items: { $ref: '#/$defs/finding' } }
    })]))) }), $defs: { finding: object({
      symbol: { type: 'string', enum: symbols },
      correctionKind: { type: 'string', enum: ['localized', 'global'] },
      quotedText: { type: 'string', minLength: 1, maxLength: 500 },
      occurrence: { type: 'integer', minimum: 0 },
      suggestedText: { type: 'string', maxLength: 300 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] }
    }) } };
}
function expand(parsed, legend) {
  const invalid = () => { throw Object.assign(new Error('Invalid compact correction response.'),
    { code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'compact_wire_schema' }); };
  if (parsed.reviewContract !== VERSION || Object.keys(parsed).some(k => !['reviewContract', 'transcriptHash', 'categories'].includes(k))) invalid();
  if (!parsed.categories || typeof parsed.categories !== 'object' || Array.isArray(parsed.categories)) invalid();
  const symbols = new Map(legend.flatMap(group => group.symbols.map(item => [item.symbol, item])));
  const categories = {};
  for (const [category, review] of Object.entries(parsed.categories)) {
    if (!review || typeof review !== 'object' || Array.isArray(review)
      || Object.keys(review).length !== 3 || Object.keys(review).some(k => !['reviewed', 'reviewedSymbols', 'corrections'].includes(k))
      || review.reviewed !== true || !Array.isArray(review.reviewedSymbols) || !Array.isArray(review.corrections)) invalid();
    const corrections = review.corrections.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length
        || Object.keys(item).some(k => !fields.includes(k)) || fields.some(k => !(k in item))
        || !symbols.has(item.symbol) || !['localized', 'global'].includes(item.correctionKind)
        || typeof item.quotedText !== 'string' || !item.quotedText.length || item.quotedText.length > 500
        || !Number.isInteger(item.occurrence) || item.occurrence < 0
        || typeof item.suggestedText !== 'string' || item.suggestedText.length > 300
        || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
        || !['low', 'medium', 'high'].includes(item.severity)) invalid();
      const definition = symbols.get(item.symbol), label = definition.label || item.symbol;
      const detail = item.suggestedText || definition.description || 'Review this passage.';
      return { ...item, message: `${label}: ${detail}`.slice(0, 240), stylePreference: false };
    });
    categories[category] = { ...review, corrections,
      noFindingReason: corrections.length ? '' : 'No findings after reviewing every supplied symbol.' };
  }
  return { transcriptHash: parsed.transcriptHash, categories };
}
module.exports = { VERSION, schema, expand };
