'use strict';

const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');
const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');
const canonical = require('./correctionCanonical.service');
const policy = require('./aiCorrectionPolicy.service');
const { promptDefinitions } = require('./writingCategoryDefinitions.service');
const { semanticCorrectionsSchema, CORRECTION_CATEGORIES, CORRECTION_KINDS,
  CORRECTION_SEVERITIES, CORRECTION_FIELDS } = require('./structuredOutputSchemas.service');

const SEMANTIC_PROMPT_VERSION = 'ai-only-correction-detection-v4';
const SEMANTIC_SCHEMA_VERSION = 'semantic-corrections-v8';
const CATEGORY_REVIEW_POLICY_VERSION = 'ai-only-categories-v2';
const SEMANTIC_CATEGORIES = new Set(CORRECTION_CATEGORIES);
const OMIT_CONTEXT_KEYS = new Set(['_id', '__v', 'createdAt', 'updatedAt', 'student', 'teacher', 'class', 'files', 'fileUrls', 'images']);

const clean = (value, maximum = 4000) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
const stableCompact = (value) => value == null ? null : Array.isArray(value) ? value.map(stableCompact)
  : typeof value === 'object' ? Object.keys(value).sort().reduce((out, key) => {
    if (!OMIT_CONTEXT_KEYS.has(key) && value[key] !== undefined) out[key] = stableCompact(value[key]); return out;
  }, {}) : typeof value === 'string' ? clean(value) : value;

function compactAssignment(assignment = {}) {
  return stableCompact({ title: assignment?.title || '',
    instructions: assignment?.instructions || assignment?.description || '',
    rubric: assignment?.rubric || assignment?.rubrics || null });
}

function compactSemanticLegend(legend = defaultLegend()) {
  return (legend.groups || []).filter((group) => SEMANTIC_CATEGORIES.has(group?.key)).map((group) => ({
    category: group.key, label: group.label, color: group.color,
    symbols: (group.symbols || []).map((item) => ({ symbol: item.symbol, label: item.label,
      description: item.description, rule: item.description, defaultDeduction: item.defaultDeduction }))
  }));
}

function compactLanguageToolExclusions(corrections = []) {
  // No longer used in AI-only pipeline - kept for backward compatibility
  return [];
}

function compactPageManifest(pages = []) {
  return pages.map((page) => ({ fileId: String(page?.fileId || ''), page: Number(page?.pageNumber || 1),
    startChar: Number(page?.startChar || 0), endChar: Number(page?.endChar || 0) }));
}

function buildSemanticRequest({ transcript, assignment = {}, legend: resolvedLegend = defaultLegend(), transcriptHash, pageManifest = [] }) {
  if (!transcriptHash) throw new Error('Semantic analysis requires a transcript hash');
  const legend = compactSemanticLegend(resolvedLegend);
  const context = compactAssignment(assignment);
  const pages = compactPageManifest(pageManifest);
  const responseShape = { transcriptHash, categoryReviews: SEMANTIC_CATEGORIES.has('CONTENT') ? ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map((category) => ({
    category, reviewed: true, noFindingReason: '<meaningful reason only when this category has no findings>'
  })) : [], corrections: [
    { category: 'GRAMMAR', symbol: 'AGR', correctionKind: 'localized', quotedText: '<exact quote>', occurrence: 0,
      message: '<explanation>', suggestedText: '<replacement>', confidence: 0.86, severity: 'medium', stylePreference: false },
    { category: 'MECHANICS', symbol: 'SP', correctionKind: 'localized', quotedText: '<exact quote>', occurrence: 0,
      message: '<explanation>', suggestedText: '<replacement>', confidence: 0.91, severity: 'medium', stylePreference: false }
  ] };
  const prompt = [
    `schema=${SEMANTIC_SCHEMA_VERSION};prompt=${SEMANTIC_PROMPT_VERSION}`,
    `transcriptHash=${transcriptHash}`,
    `pages=${JSON.stringify(pages)}`,
    `assignment=${JSON.stringify(context)}`,
    `legend=${JSON.stringify(legend)}`,
    `response=${JSON.stringify(responseShape)}`,
    'You are an AI-only writing correction detector. Analyze the entire canonical transcript independently. No external grammar checker is available.',
    'Review every category exactly once in categoryReviews and set reviewed=true. Do not return findingCount; the server calculates it. If a category has no corrections, give a meaningful non-empty noFindingReason. For a category with corrections, return noFindingReason="". Zero findings remains valid and must never be forced.',
    'Perform five explicit full-transcript passes and return every material defensible finding within the supplied safe limits, not merely representative examples.',
    'Pass 1 CONTENT: REL, DEV, TA, CL, SD. Review relevance, task achievement, claim clarity/development, support specificity, and repetitive development.',
    'Pass 2 ORGANIZATION: COH, CO, PU, TS, CONC. Review progression, transitions, paragraph unity, topic sentences, and actual introduction/conclusion structure.',
    'Pass 3 GRAMMAR: T, VF, AGR, FRAG, RO, WO, ART, PREP. Subject-verb agreement and syntactic verb forms always belong here.',
    'Pass 4 VOCABULARY: WC, WF, REP, FORM, COL. Lexical morphology such as mass/plural noun form belongs to WF; confused lexical choice such as there/their belongs to WC. Do not use WF for a syntactic verb-form error.',
    'Pass 5 MECHANICS: SP, P, CAP, SPC, FMT. Punctuation and capitalization always belong here.',
    'IMPORTANT: This transcript comes from OCR of handwritten images. Distinguish between student writing errors and likely OCR artifacts. If a token appears suspicious (low confidence, structurally odd layout), avoid confidently penalizing it unless context strongly confirms the student wrote it.',
    'Use only these boundaries: CONTENT REL=relevance, DEV=underdeveloped relevant idea, TA=task achievement only when assignment context supports it, CL=unclear underlying idea (not grammar), SD=important unsupported claim.',
    'ORGANIZATION COH=understandable ideas with poor logical progression, CO=cohesive device/transition, PU=paragraph unity, TS=topic sentence, CONC=genuinely weak/missing conclusion across the full canonical submission anchored to exact final text.',
    'GRAMMAR T=tense, VF=verb form, AGR=subject-verb agreement, FRAG=fragment, RO=run-on, WO=word order, ART=article, PREP=preposition.',
    'VOCABULARY WC=word choice, WF=word form, REP=harmful repetition, FORM=register/formality, COL=collocation. MECHANICS SP=spelling, P=punctuation, CAP=capitalization, SPC=spacing, FMT=provable formatting.',
    'Balance attention equally across all five passes. Category examples are boundaries, not quotas: CONTENT may ground an unsupported claim; ORGANIZATION may ground a weak transition or ending; GRAMMAR may ground agreement or verb form; VOCABULARY may ground imprecise choice, word form, repetition, register, or collocation; MECHANICS may ground spelling, punctuation, capitalization, spacing, or formatting. Never match examples mechanically.',
    'Poor grammar alone is not CONTENT/CL. Do not infer COH when the underlying ideas are not understandable. Do not fill categories or limits.',
    'Only genuine errors. Quote minimum exact evidence; occurrence is zero-based; message<=240. No rewrites, duplicates, praise, styles, or OCR guesses.',
    promptDefinitions(),
    'localized means a specific passage has an identifiable replacement and suggestedText is required.',
    'For localized quotedText, copy the shortest exact erroneous text verbatim from the canonical transcript. Preserve its OCR spelling, case, punctuation, and normalized whitespace. Never put corrected or paraphrased text in quotedText; put that only in suggestedText.',
    'occurrence is the zero-based occurrence of that exact quotedText. If "students use" appears twice and the second is wrong, use occurrence=1. Wrong: quotedText="students uses" when the transcript says "students use".',
    'global is only CONTENT/ORGANIZATION holistic, absence, or structure weakness. It must anchor an exact existing relevant passage (including the ending for a missing conclusion), never invent missing text, and suggestedText may be empty. Examples include a vague thesis, inadequately developed main claim, or missing conclusion.',
    'Use legend pairs and be concise. Independently justify every finding from transcript context.',
    `transcript=${transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'Analyze writing evidence independently. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const serializedLength = JSON.stringify(messages).length;
  return { messages, legend, pages, context, promptCharacters: serializedLength,
    promptInputTokenEstimate: Math.ceil(serializedLength / 4) };
}

function buildLegacySemanticRequestForBenchmark({ transcript, assignment = {}, languageToolCorrections = [], transcriptHash, pageManifest = [] }) {
  const semanticLegend = defaultLegend().groups.filter((group) => SEMANTIC_CATEGORIES.has(group.key));
  const prompt = `Analyze the entire exact student essay, including the final page. Transcript hash: ${transcriptHash}. Page manifest: ${JSON.stringify(pageManifest)}. Return JSON only as {"transcriptHash":"${transcriptHash}","corrections":[{"category":"CONTENT","symbol":"DEV","quotedText":"exact text copied from transcript","message":"specific concise explanation","suggestedText":"specific improvement","confidence":0.9,"occurrence":0}]}. Use only this legend: ${JSON.stringify(semanticLegend)}. Do not invent quotations, edit OCR, add praise, fill categories, or duplicate these LanguageTool targets: ${JSON.stringify(languageToolCorrections.map((item) => ({ symbol: item.symbol, quotedText: item.quotedText })))}. Distinguish grammar from content; subject-verb agreement is never Content. Detect a genuinely missing/weak conclusion with CONC, excessive repetition with REP, and unnatural collocations with COL. Do not return equivalent issues for every sentence or paragraph. For repeated quotations include the zero-based occurrence. Assignment context: ${JSON.stringify(assignment)}. Complete transcript:\n${transcript}`;
  const messages = [{ role: 'system', content: 'You are a precise academic writing analyst. Output strict JSON only.' }, { role: 'user', content: prompt }];
  const serializedLength = JSON.stringify(messages).length;
  return { messages, promptCharacters: serializedLength, promptInputTokenEstimate: Math.ceil(serializedLength / 4) };
}

function parseJson(value, expectedHash) {
  const text = String(value || '').trim().replace(/^```json\s*/iu, '').replace(/```$/u, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw semanticError('SEMANTIC_RESPONSE_INVALID', 'json_parse', 'Semantic analysis returned invalid JSON'); }
  if (!expectedHash || parsed?.transcriptHash !== expectedHash)
    throw semanticError('SEMANTIC_SOURCE_MISMATCH', 'source_hash', 'Semantic analysis did not confirm the complete transcript hash');
  if (!Array.isArray(parsed?.corrections))
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'schema_validation', 'Semantic analysis corrections must be an array');
  if (parsed.corrections.length > policy.MAX_AI_CORRECTIONS)
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'correction_limit', 'Semantic analysis returned too many corrections');
  validateSemanticContract(parsed);
  validateCategoryReviews(parsed.categoryReviews, parsed.corrections);
  parsed.compatibilityDiagnostics = {
    legacyFindingCountIgnored: parsed.categoryReviews.some((review) => Object.prototype.hasOwnProperty.call(review, 'findingCount'))
  };
  return parsed;
}

function contractError({ jsonPath, expected, actual, category = null, symbol = null,
  candidateIndex = null, requiredPropertyMissing = false, unexpectedPropertyPresent = false }) {
  return semanticError('SEMANTIC_SCHEMA_INVALID', 'semantic_schema', 'Semantic correction response violates the canonical contract', {
    jsonPath, expected, actualType: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual,
    category, symbol, candidateIndex, requiredPropertyMissing, unexpectedPropertyPresent
  });
}

function validateSemanticContract(parsed) {
  const rootFields = ['transcriptHash', 'categoryReviews', 'corrections'];
  for (const key of Object.keys(parsed)) if (!rootFields.includes(key)) throw contractError({
    jsonPath: `$.${key}`, expected: 'no unexpected properties', actual: parsed[key], unexpectedPropertyPresent: true });
  if (!Array.isArray(parsed.categoryReviews)) throw contractError({ jsonPath: '$.categoryReviews',
    expected: 'array with exactly five category reviews', actual: parsed.categoryReviews,
    requiredPropertyMissing: !('categoryReviews' in parsed) });
  const requiredReviewFields = ['category', 'reviewed', 'noFindingReason'];
  const reviewFields = [...requiredReviewFields, 'findingCount']; // tolerated and ignored for legacy model output
  for (let index = 0; index < parsed.categoryReviews.length; index += 1) {
    const review = parsed.categoryReviews[index]; const base = `$.categoryReviews[${index}]`;
    if (!review || typeof review !== 'object' || Array.isArray(review)) throw contractError({ jsonPath: base, expected: 'object', actual: review });
    for (const field of requiredReviewFields) if (!(field in review)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'required property', actual: undefined, category: review.category || null, requiredPropertyMissing: true });
    for (const field of Object.keys(review)) if (!reviewFields.includes(field)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'no unexpected properties', actual: review[field], category: review.category || null, unexpectedPropertyPresent: true });
    if (typeof review.noFindingReason !== 'string') throw contractError({ jsonPath: `${base}.noFindingReason`,
      expected: 'string; non-empty only when the server-calculated count is zero', actual: review.noFindingReason, category: review.category || null });
  }
  for (let index = 0; index < parsed.corrections.length; index += 1) {
    const item = parsed.corrections[index]; const base = `$.corrections[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw contractError({ jsonPath: base, expected: 'object', actual: item, candidateIndex: index });
    for (const field of CORRECTION_FIELDS) if (!(field in item)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'required property', actual: undefined, category: item.category || null, symbol: item.symbol || null,
      candidateIndex: index, requiredPropertyMissing: true });
    for (const field of Object.keys(item)) if (!CORRECTION_FIELDS.includes(field)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'no unexpected properties', actual: item[field], category: item.category || null, symbol: item.symbol || null,
      candidateIndex: index, unexpectedPropertyPresent: true });
    if (!CORRECTION_CATEGORIES.includes(item.category)) throw contractError({ jsonPath: `${base}.category`, expected: CORRECTION_CATEGORIES.join('|'), actual: item.category, candidateIndex: index });
    if (!CORRECTION_KINDS.includes(item.correctionKind)) throw contractError({ jsonPath: `${base}.correctionKind`, expected: CORRECTION_KINDS.join('|'), actual: item.correctionKind, category: item.category, symbol: item.symbol, candidateIndex: index });
    if (!CORRECTION_SEVERITIES.includes(item.severity)) throw contractError({ jsonPath: `${base}.severity`, expected: CORRECTION_SEVERITIES.join('|'), actual: item.severity, category: item.category, symbol: item.symbol, candidateIndex: index });
    if (item.stylePreference !== false) throw contractError({ jsonPath: `${base}.stylePreference`, expected: 'boolean false', actual: item.stylePreference, category: item.category, symbol: item.symbol, candidateIndex: index });
  }
  return true;
}

function validateCategoryReviews(reviews, corrections) {
  const categories = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'];
  if (!Array.isArray(reviews) || reviews.length !== categories.length)
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Every correction category must be reviewed');
  const seen = new Set();
  for (const review of reviews) {
    const category = review?.category;
    if (!categories.includes(category) || seen.has(category) || review.reviewed !== true)
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Category reviews must be unique and complete');
    seen.add(category);
    const actual = corrections.filter((item) => item?.category === category).length;
    const reason = String(review.noFindingReason || '').trim();
    if (actual === 0 && !reason)
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_review_reason', 'Category review reason is inconsistent with findings');
    review.findingCount = actual;
    review.noFindingReason = actual > 0 ? '' : reason;
  }
  return true;
}

function semanticError(code, stage, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.validationStage = stage;
  Object.assign(error, details);
  return error;
}

function validateCorrections(corrections, { transcript, legend, spans = [], env = process.env,
  provider = null, model = null, attemptIndex = null } = {}) {
  const allowed = new Set((legend || []).flatMap((group) => (group.symbols || [])
    .map((item) => `${group.category}:${item.symbol}`)));
  const thresholds = policy.confidenceThresholds(env);
  const accepted = [];
  const rejectionReasons = {};
  const perCategory = {};
  const allCategories = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'];
  const returnedByCategory = Object.fromEntries(allCategories.map((key) => [key, 0]));
  const rejectedByCategory = Object.fromEntries(allCategories.map((key) => [key, 0]));
  const rejectionReasonsByCategory = Object.fromEntries(allCategories.map((key) => [key, {}]));
  const rejectionDiagnostics = [];
  const reject = (reason, category, item, candidateIndex, validationStage) => {
    rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    if (rejectedByCategory[category] !== undefined) {
      rejectedByCategory[category] += 1;
      rejectionReasonsByCategory[category][reason] = (rejectionReasonsByCategory[category][reason] || 0) + 1;
    }
    const quote = typeof item?.quotedText === 'string' ? item.quotedText : '';
    rejectionDiagnostics.push({ category: category || String(item?.category || 'UNKNOWN').slice(0, 32),
      symbol: String(item?.symbol || '').slice(0, 16), rejectionCode: reason, validationStage,
      quotedTextHash: quote ? crypto.createHash('sha256').update(quote).digest('hex').slice(0, 16) : null,
      candidateIndex, provider, model, attemptIndex });
  };
  for (let candidateIndex = 0; candidateIndex < corrections.length; candidateIndex += 1) {
    const item = corrections[candidateIndex];
    const category = SEMANTIC_CATEGORIES.has(item?.category) ? item.category : null;
    if (category) returnedByCategory[category] += 1;
    if (!item || typeof item !== 'object' || !SEMANTIC_CATEGORIES.has(item.category)
      || !allowed.has(`${item.category}:${item.symbol}`) || typeof item.quotedText !== 'string' || !item.quotedText
      || item.quotedText.length > 500
      || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 240
      || typeof item.suggestedText !== 'string' || item.suggestedText.length > 300
      || item.quotedText.includes('\uFFFD')
      || !Number.isFinite(Number(item.confidence)) || Number(item.confidence) < 0 || Number(item.confidence) > 1
      || !Number.isInteger(Number(item.occurrence)) || Number(item.occurrence) < 0) {
      reject('INVALID_SCHEMA', category, item, candidateIndex, 'schema_validation'); continue;
    }
    if (item.stylePreference === true) { reject('STYLE_PREFERENCE', category, item, candidateIndex, 'category_validation'); continue; }
    const correctionKind = item.correctionKind || 'localized';
    if (!['localized', 'global'].includes(correctionKind)
      || (correctionKind === 'global' && !['CONTENT', 'ORGANIZATION'].includes(item.category))
      || (correctionKind === 'localized' && !item.suggestedText.trim())) {
      reject('UNSUPPORTED_CORRECTION_KIND', category, item, candidateIndex, 'category_validation'); continue;
    }
    if (item.category === 'VOCABULARY' && item.symbol === 'WC'
      && /\bmore\s+\p{L}+er\b/iu.test(item.quotedText)
      && !/\bmore\b/iu.test(item.suggestedText)) {
      reject('CATEGORY_MISMATCH', category, item, candidateIndex, 'category_validation'); continue;
    }
    if (item.severity != null && !policy.SEVERITIES.has(String(item.severity).toLowerCase())) {
      reject('INVALID_SEVERITY', category, item, candidateIndex, 'schema_validation'); continue;
    }
    if (Number(item.confidence) < thresholds[item.category]) { reject('LOW_CONFIDENCE', category, item, candidateIndex, 'confidence_validation'); continue; }
    if ((perCategory[item.category] || 0) >= policy.MAX_AI_CORRECTIONS_PER_CATEGORY[item.category]) {
      reject('CATEGORY_LIMIT', category, item, candidateIndex, 'limit_validation'); continue;
    }
    const range = canonical.locateQuote(transcript, item.quotedText, Number(item.occurrence));
    if (!range) { reject('UNGROUNDED_EVIDENCE', category, item, candidateIndex, 'grounding_validation'); continue; }
    const normalized = canonical.normalizeCorrection({ ...item, startChar: range.start, endChar: range.end },
      transcript, spans, { groups: legend.map((group) => ({ key: group.category, label: group.label, color: group.color,
        symbols: group.symbols })) }, 'AI');
    if (!normalized || (spans.length && !normalized.wordIds.length)) { reject('INVALID_LOCATION', category, item, candidateIndex, 'location_validation'); continue; }
    accepted.push(normalized);
    perCategory[item.category] = (perCategory[item.category] || 0) + 1;
  }
  const diagnostics = {
    responseJsonParsed: true, transcriptHashMatch: true, schemaValidated: true, groundingValidated: true,
    rawCorrectionCount: corrections.length, acceptedCorrectionCount: accepted.length,
    rejectedCorrectionCount: corrections.length - accepted.length, rejectionReasons, thresholds,
    returnedByCategory, acceptedByCategory: Object.fromEntries(Object.keys(returnedByCategory)
      .map((key) => [key, perCategory[key] || 0])), rejectedByCategory, rejectionReasonsByCategory
    , rejectionDiagnostics
  };
  if (corrections.length && !accepted.length) {
    const error = semanticError('SEMANTIC_SCHEMA_INVALID', 'canonical_validation',
      'Semantic analysis returned no acceptable grounded corrections');
    error.rejectionReasons = rejectionReasons;
    error.diagnostics = diagnostics;
    throw error;
  }
  return { corrections: accepted, diagnostics };
}

function semanticSourceKey({ correctionSourceHash, config = getSemanticAIConfig(), legendVersion = defaultLegend().version,
  legendContentHash = null, assignmentHash = null, deductionPolicyVersion = canonical.DEDUCTION_POLICY_VERSION }) {
  return crypto.createHash('sha256').update(JSON.stringify({ correctionSourceHash, provider: config.provider, model: config.model,
    fallback: config.fallback, promptVersion: SEMANTIC_PROMPT_VERSION, schemaVersion: SEMANTIC_SCHEMA_VERSION,
    policyVersion: policy.POLICY_VERSION, categoryReviewPolicyVersion: CATEGORY_REVIEW_POLICY_VERSION,
    confidenceThresholds: policy.confidenceThresholds(), legendVersion, legendContentHash, assignmentHash,
    deductionPolicyVersion })).digest('hex');
}

async function analyze(input, dependencies = {}) {
  const config = dependencies.config || getSemanticAIConfig();
  if (!getSemanticAIConfigStatus(config, dependencies.env || process.env).configured) {
    const error = new Error('Semantic AI provider configuration is incomplete.'); error.code = 'AI_PROVIDER_NOT_CONFIGURED'; throw error;
  }
  const buildStartedAt = Date.now();
  const request = buildSemanticRequest(input);
  const semanticRequestBuildMs = Date.now() - buildStartedAt;
  let semanticValidationMs = 0;
  const validate = (content, attemptMeta = {}) => {
    const startedAt = Date.now();
    try {
      const parsed = parseJson(content, input.transcriptHash);
      const validated = validateCorrections(parsed.corrections, {
        transcript: input.transcript, legend: request.legend, spans: input.spans || [], env: dependencies.env || process.env,
        provider: attemptMeta.provider || null, model: attemptMeta.model || null,
        attemptIndex: Number.isInteger(attemptMeta.attemptIndex) ? attemptMeta.attemptIndex : null
      });
      validated.categoryReviews = parsed.categoryReviews;
      validated.diagnostics.categoryReviews = parsed.categoryReviews;
      validated.diagnostics.compatibility = parsed.compatibilityDiagnostics;
      return validated;
    } finally { semanticValidationMs += Date.now() - startedAt; }
  };
  const completion = await (dependencies.runCompletion || runSemanticCompletion)({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
    onAttempt: input.onAttempt, onRetry: input.onRetry, validate, feature: 'semantic_corrections',
    responseSchema: semanticCorrectionsSchema(input.transcriptHash), schemaName: 'semantic_corrections' });
  const parseStartedAt = Date.now();
  let validated;
  try {
    validated = completion.value || validate(completion.content);
  } catch (error) {
    if (completion.finishReason === 'MAX_TOKENS' && error?.code === 'SEMANTIC_RESPONSE_INVALID') {
      error.code = 'GOOGLE_OUTPUT_TRUNCATED'; error.validationStage = 'json_parse';
    }
    error.candidateCount = completion.candidateCount;
    error.finishReason = completion.finishReason;
    error.responseTextLength = completion.responseTextLength;
    throw error;
  }
  const semanticParseMs = Date.now() - parseStartedAt;
  return { corrections: validated.corrections, diagnostics: validated.diagnostics,
    provider: completion.provider, model: completion.model,
    usage: completion.usage, sourceKey: semanticSourceKey({ correctionSourceHash: input.transcriptHash, config,
      legendVersion: input.legend?.version, legendContentHash: input.legend?.contentHash }),
    metrics: { ...completion.metrics, semanticRequestBuildMs, semanticParseMs,
      semanticValidationMs,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { SEMANTIC_PROMPT_VERSION, SEMANTIC_SCHEMA_VERSION, CATEGORY_REVIEW_POLICY_VERSION,
  compactAssignment, compactSemanticLegend,
  compactLanguageToolExclusions, compactPageManifest, buildSemanticRequest, buildLegacySemanticRequestForBenchmark,
  parseJson, validateSemanticContract, validateCategoryReviews, validateCorrections, semanticSourceKey, analyze };
