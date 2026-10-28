'use strict';

// Provider-only representation. Public canonical corrections keep their existing
// fields; review evidence is never inferred from the request alone.
const VERSION = 'compact-review-v2-symbol-map';
const EXPLANATION_VERSION = 'compact-review-v3-explanations';
const DEEPSEEK_VERSION = EXPLANATION_VERSION; // Existing DeepSeek wire identity remains valid.
const fields = ['symbol', 'correctionKind', 'quotedText', 'occurrence', 'suggestedText', 'confidence', 'severity'];
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
function schema(hash, categories, catalog, version = VERSION) {
  if (![VERSION, EXPLANATION_VERSION].includes(version)) throw new Error('Unsupported correction wire version.');
  const symbols = [...new Set(Object.values(catalog).flat())];
  return { ...object({ reviewContract: { type: 'string', const: version },
    transcriptHash: { type: 'string', const: String(hash) },
    categories: object(Object.fromEntries(categories.map(category => [category, object({
      reviewed: { type: 'boolean', const: true },
      reviewedSymbols: object(Object.fromEntries(catalog[category].map(symbol => [symbol, { $ref: '#/$defs/r' }]))),
      corrections: { type: 'array', items: { $ref: '#/$defs/finding' } }
    })]))) }), $defs: { finding: object({
      symbol: { type: 'string', enum: symbols },
      ...(version === EXPLANATION_VERSION ? { message: { type: 'string', minLength: 1, maxLength: 240 } } : {}),
      correctionKind: { type: 'string', enum: ['localized', 'global'] },
      quotedText: { type: 'string', minLength: 1, maxLength: 500 },
      occurrence: { type: 'integer', minimum: 0 },
      suggestedText: { type: 'string', maxLength: 300 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] }
    }), r: { type: 'boolean', const: true } } };
}
function expand(parsed, legend) {
  const invalid = () => { throw Object.assign(new Error('Invalid compact correction response.'),
    { code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'compact_wire_schema' }); };
  if (![VERSION, EXPLANATION_VERSION].includes(parsed.reviewContract) || Object.keys(parsed).some(k => !['reviewContract', 'transcriptHash', 'categories'].includes(k))) invalid();
  const explanations = parsed.reviewContract === EXPLANATION_VERSION;
  const expectedFields = explanations ? [...fields, 'message'] : fields;
  if (!parsed.categories || typeof parsed.categories !== 'object' || Array.isArray(parsed.categories)) invalid();
  const symbols = new Map(legend.flatMap(group => group.symbols.map(item => [item.symbol, item])));
  const categories = {};
  for (const [category, review] of Object.entries(parsed.categories)) {
    if (!review || typeof review !== 'object' || Array.isArray(review)
      || Object.keys(review).length !== 3 || Object.keys(review).some(k => !['reviewed', 'reviewedSymbols', 'corrections'].includes(k))
      || review.reviewed !== true || !review.reviewedSymbols || typeof review.reviewedSymbols !== 'object'
      || Array.isArray(review.reviewedSymbols) || !Array.isArray(review.corrections)) invalid();
    const group = legend.find(item => item.category === category);
    const expected = group?.symbols.map(item => item.symbol) || [];
    const reviewed = Object.keys(review.reviewedSymbols);
    if (!group || reviewed.length !== expected.length || expected.some(symbol => review.reviewedSymbols[symbol] !== true)
      || reviewed.some(symbol => !expected.includes(symbol))) invalid();
    const corrections = review.corrections.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== expectedFields.length
        || Object.keys(item).some(k => !expectedFields.includes(k)) || expectedFields.some(k => !(k in item))
        || (explanations && (typeof item.message !== 'string' || !item.message.trim() || item.message.length > 240))
        || !symbols.has(item.symbol) || !['localized', 'global'].includes(item.correctionKind)
        || typeof item.quotedText !== 'string' || !item.quotedText.length || item.quotedText.length > 500
        || !Number.isInteger(item.occurrence) || item.occurrence < 0
        || typeof item.suggestedText !== 'string' || item.suggestedText.length > 300
        || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
        || !['low', 'medium', 'high'].includes(item.severity)) invalid();
      const definition = symbols.get(item.symbol), label = definition.label || item.symbol;
      const detail = item.suggestedText || definition.description || 'Review this passage.';
      return { ...item, message: explanations ? item.message : `${label}: ${detail}`.slice(0, 240), stylePreference: false };
    });
    categories[category] = { ...review, reviewedSymbols: reviewed, corrections,
      noFindingReason: corrections.length ? '' : 'No findings after reviewing every supplied symbol.' };
  }
  return { transcriptHash: parsed.transcriptHash, categories };
}
module.exports = { VERSION, EXPLANATION_VERSION, DEEPSEEK_VERSION, schema, expand };
