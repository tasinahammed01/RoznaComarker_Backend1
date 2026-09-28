const DIMENSIONS = Object.freeze({
  CONTENT: 'CONTENT',
  EXAMPLES: 'EXAMPLES',
  LANGUAGE: 'LANGUAGE',
  VOCABULARY: 'VOCABULARY',
  ORGANIZATION: 'ORGANIZATION',
  OPINION: 'OPINION'
});

const LANGUAGE_CATEGORIES = Object.freeze(['GRAMMAR', 'MECHANICS', 'VOCABULARY']);
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function criterionDimensions(criterion = {}) {
  const primary = normalized(`${criterion.title || criterion.name || ''} ${criterion.description || ''}`);
  const fallback = normalized((criterion.levels || []).map((level) => level?.description || '').join(' '));
  const text = `${primary} ${fallback}`.trim();
  const dimensions = new Set();
  if (/grammar|mechanic|punctuation|spelling|sentence accuracy|language accuracy|clarity|language use|style/u.test(text))
    dimensions.add(DIMENSIONS.LANGUAGE);
  if (/vocab|word choice|diction/u.test(text)) dimensions.add(DIMENSIONS.VOCABULARY);
  if (/organi|structure|coher|flow|transition/u.test(text)) dimensions.add(DIMENSIONS.ORGANIZATION);
  if (/example|supporting detail|supporting evidence|illustrat/u.test(text)) {
    dimensions.add(DIMENSIONS.EXAMPLES); dimensions.add(DIMENSIONS.CONTENT);
  }
  if (/content|relevance|task achievement|idea|development/u.test(text)) dimensions.add(DIMENSIONS.CONTENT);
  if (/opinion|responsib|argument|position|claim|stance/u.test(text)) {
    dimensions.add(DIMENSIONS.OPINION); dimensions.add(DIMENSIONS.CONTENT);
  }
  return dimensions;
}

function correctionCategory(correction) {
  return String(correction?.canonicalCategory || correction?.category || '').toUpperCase();
}

function buildCorrectionEvidenceIndex(corrections = [], transcript = '') {
  const byCategory = new Map();
  const highImpactByCategory = new Map();
  for (const correction of corrections || []) {
    const category = correctionCategory(correction);
    if (!category) continue;
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
    if (['high', 'critical'].includes(normalized(correction?.severity)))
      highImpactByCategory.set(category, (highImpactByCategory.get(category) || 0) + 1);
  }
  const wordCount = (String(transcript || '').match(WORD_RE) || []).length;
  const count = (categories) => categories.reduce((sum, category) => sum + (byCategory.get(category) || 0), 0);
  const highImpactCount = (categories) => categories.reduce((sum, category) => sum + (highImpactByCategory.get(category) || 0), 0);
  const densityPer100 = (categories) => wordCount ? count(categories) * 100 / wordCount : 0;
  return Object.freeze({ byCategory, highImpactByCategory, wordCount, count, highImpactCount, densityPer100 });
}

function evidenceText(evidence) {
  return normalized(evidence?.quotedText || evidence?.text || '');
}

function evidenceRelevantToCriterion(criterion, evidence = []) {
  const dimensions = criterionDimensions(criterion);
  const entries = Array.isArray(evidence) ? evidence : [];
  const categories = new Set(relevantCorrectionCategories(criterion));
  const classifications = entries.map((item) => {
    if (item?.evidenceType === 'correction') {
      const category = correctionCategory(item);
      return !dimensions.size || !category
        ? { classification: 'AMBIGUOUS', reasonCode: 'DIMENSION_UNAVAILABLE' }
        : categories.has(category)
          ? { classification: 'RELEVANT', reasonCode: 'CORRECTION_CATEGORY_MATCH' }
          : { classification: 'IRRELEVANT', reasonCode: 'CORRECTION_CATEGORY_MISMATCH' };
    }
    // Catalog membership/source grounding is validated by the caller. Missing
    // lexical markers (or short passages) cannot prove semantic irrelevance.
    const text = evidenceText(item);
    const positiveHint = dimensions.size && (
      dimensions.has(DIMENSIONS.LANGUAGE) || dimensions.has(DIMENSIONS.VOCABULARY)
      || (dimensions.has(DIMENSIONS.EXAMPLES) && /\b(for example|for instance|such as|including)\b/u.test(text))
      || (dimensions.has(DIMENSIONS.OPINION) && (item?.finalQuarter === true || /\b(i think|i believe|should|must)\b/u.test(text)))
      || (dimensions.has(DIMENSIONS.ORGANIZATION) && (item?.finalQuarter === true || item?.startChar === 0
        || /\b(first|second|however|therefore|finally|in conclusion)\b/u.test(text))));
    return positiveHint
      ? { classification: 'RELEVANT', reasonCode: 'TRANSCRIPT_DIMENSION_HINT' }
      : { classification: 'AMBIGUOUS', reasonCode: dimensions.size ? 'TRANSCRIPT_SEMANTICS_UNCERTAIN' : 'DIMENSION_UNAVAILABLE' };
  });
  const result = classifications.find((item) => item.classification === 'RELEVANT')
    || classifications.find((item) => item.classification === 'AMBIGUOUS')
    || classifications[0] || { classification: 'IRRELEVANT', reasonCode: 'NO_EVIDENCE' };
  return { ...result, available: dimensions.size > 0, relevant: result.classification !== 'IRRELEVANT',
    dimensions: [...dimensions], reason: result.reasonCode };
}

function contradictionForSelection({ criterion, level, correctionIndex }) {
  const dimensions = criterionDimensions(criterion);
  const description = normalized(`${level?.title || ''} ${level?.description || ''}`);
  if (dimensions.has(DIMENSIONS.LANGUAGE) || dimensions.has(DIMENSIONS.VOCABULARY)) {
    const count = correctionIndex.count(LANGUAGE_CATEGORIES);
    const density = correctionIndex.densityPer100(LANGUAGE_CATEGORIES);
    const highImpact = correctionIndex.highImpactCount(LANGUAGE_CATEGORIES);
    if (/free of (?:grammatical )?errors|error[- ]free|no (?:language |grammar |mechanics )?errors/u.test(description) && count > 0)
      return { reason: 'Selected level claims error-free language despite authoritative language corrections.', count, density };
    const limitedErrorsClaim = /(?:few|minor|occasional|isolated)[^.!;]{0,32}(?:errors|mistakes)|mostly clear|consistently accurate|almost error[- ]free|generally accurate/u.test(description);
    // Conservative boundary: at least 12 relevant issues and 6 per 100 words, or four high-impact issues at 3 per 100 words.
    if (limitedErrorsClaim && ((count >= 12 && density >= 6) || (highImpact >= 4 && density >= 3)))
      return { reason: 'Selected level describes limited language errors but authoritative error density is high.', count, density, highImpact };
  }
  if (dimensions.has(DIMENSIONS.ORGANIZATION)
    && /well[- ]organi|smooth transition|effective transition|consistently (?:logical|coherent)/u.test(description)) {
    const count = correctionIndex.count(['ORGANIZATION']);
    const density = correctionIndex.densityPer100(['ORGANIZATION']);
    if (count >= 8 && density >= 2)
      return { reason: 'Selected level claims consistently strong organization despite dense authoritative organization issues.', count, density };
  }
  return null;
}

function relevantCorrectionCategories(criterion) {
  const dimensions = criterionDimensions(criterion);
  const categories = new Set();
  if (dimensions.has(DIMENSIONS.LANGUAGE)) ['GRAMMAR', 'MECHANICS'].forEach((item) => categories.add(item));
  if (dimensions.has(DIMENSIONS.VOCABULARY) || dimensions.has(DIMENSIONS.LANGUAGE)) categories.add('VOCABULARY');
  if (dimensions.has(DIMENSIONS.ORGANIZATION)) categories.add('ORGANIZATION');
  if (dimensions.has(DIMENSIONS.CONTENT) || dimensions.has(DIMENSIONS.EXAMPLES) || dimensions.has(DIMENSIONS.OPINION)) categories.add('CONTENT');
  return [...categories];
}

module.exports = { DIMENSIONS, LANGUAGE_CATEGORIES, criterionDimensions, buildCorrectionEvidenceIndex,
  evidenceRelevantToCriterion, contradictionForSelection, relevantCorrectionCategories };
