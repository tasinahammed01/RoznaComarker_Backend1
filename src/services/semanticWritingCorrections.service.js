'use strict';

const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');
const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');
const canonical = require('./correctionCanonical.service');
const policy = require('./aiCorrectionPolicy.service');
const { promptDefinitions } = require('./writingCategoryDefinitions.service');
const { semanticCorrectionsSchema, CORRECTION_CATEGORIES, CORRECTION_KINDS,
  CORRECTION_SEVERITIES, CORRECTION_FIELDS } = require('./structuredOutputSchemas.service');
const logger = require('../utils/logger');

const SEMANTIC_PROMPT_VERSION = 'ai-only-correction-detection-v7-examiner-coverage';
const SEMANTIC_SCHEMA_VERSION = 'semantic-corrections-v11-provider-compatible-symbol-coverage';
const CATEGORY_REVIEW_POLICY_VERSION = 'ai-only-categories-v5-28-symbol-coverage';
const DEFAULT_NO_FINDING_REASON = 'No validated canonical findings were returned after the category review.';
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

const categorySymbolCatalog = (legend) => Object.fromEntries((legend || []).map((group) => [group.category,
  (group.symbols || []).map((item) => item.symbol)]));

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
  const prompt = [
    `schema=${SEMANTIC_SCHEMA_VERSION};prompt=${SEMANTIC_PROMPT_VERSION}`,
    `transcriptHash=${transcriptHash}`,
    `pages=${JSON.stringify(pages)}`,
    `assignment=${JSON.stringify(context)}`,
    `legend=${JSON.stringify(legend)}`,
    'Your task is localized error detection, not general essay evaluation. Analyze the entire canonical transcript independently and sentence by sentence, from the first page through the final page. No external grammar checker is available. Do not stop after finding several examples or many findings in one category. Complete all five category passes before returning.',
    'Return the provider-native category-structured object defined by the JSON Schema. Review every required category exactly once and set reviewed=true. Do not return findingCount; the server calculates it. If a category has no corrections, give a meaningful non-empty noFindingReason. For a category with corrections, return noFindingReason="". Zero findings are permitted only after that category has been fully inspected across the complete transcript. Do not return zero merely because the essay is understandable, and do not invent findings merely to avoid zero.',
    'For every category, perform a separate complete-transcript review of every supplied legend symbol and return the complete symbol list in reviewedSymbols. reviewedSymbols reports review coverage only: it does not mean an error was found, does not affect scoring or statistics, and must never cause a correction to be created. Use each authoritative legend label and description supplied above.',
    'For each candidate, identify the primary nature of the problem and use the narrowest correct symbol in exactly one primary category. A passage may support multiple genuinely different findings, but duplicates are prohibited. Do not classify the same problem as both Grammar and Vocabulary. Every correction symbol must belong to its containing category object.',
    'Perform five explicit full-transcript passes and return every material defensible finding within the supplied safe limits, not merely representative examples.',
    'Pass 1 CONTENT: REL, DEV, TA, CL, SD. Complete this pass independently even if many Grammar findings already exist. REL=relevance to task; DEV=underdeveloped relevant claim or idea; TA=specific task requirement not adequately addressed when assignment context supports it; CL=underlying idea unclear beyond grammar alone; SD=important claim lacks supporting detail, example, or explanation. Ground every finding in a specific phrase, sentence, or bounded passage. Do not force Content findings.',
    'Pass 2 ORGANIZATION: COH, CO, PU, TS, CONC. Complete this pass independently even if many Grammar findings already exist. COH=weak logical progression/coherence; CO=missing or misused transition/cohesive device; PU=poor paragraph unity; TS=weak, missing, or unclear topic sentence anchored to its paragraph; CONC=weak, incomplete, repetitive, or unsynthesized conclusion anchored to the actual ending. Inspect sequencing, introduction/conclusion structure, and repetitive passages that harm flow. Do not force Organization findings.',
    'Pass 3 GRAMMAR: T, VF, AGR, FRAG, RO, WO, ART, PREP. For Grammar, inspect every finite verb and verb phrase in every sentence. Check subject-verb and singular/plural agreement, modal + base verb, auxiliary + verb form, tense consistency, missing copula or auxiliary, infinitive/gerund construction, articles, prepositions, fragments, run-ons, and word order. Pattern guidance includes plural subject + singular verb, modal + participle, or auxiliary + wrong verb form; never treat these patterns as hard-coded corrections.',
    'Pass 4 VOCABULARY: WC, WF, REP, FORM, COL. Check incorrect word choice, wrong lexical form, count/non-count misuse, collocation, register, harmful repetition, and semantically inappropriate lexical usage. Grammar is syntax, agreement, tense, auxiliary/verb construction, articles, prepositions, fragments, run-ons, and word order. Vocabulary is lexical choice/form and usage where syntax is not the primary problem. Do not use Grammar as a fallback category for lexical problems. Lexical morphology such as mass/plural noun form belongs to WF; do not use WF for a syntactic verb-form error.',
    'Pass 5 MECHANICS: SP, P, CAP, SPC, FMT. Punctuation and capitalization always belong here.',
    'IMPORTANT: This transcript comes from OCR of handwritten images. Distinguish between student writing errors and likely OCR artifacts. If a token appears suspicious (low confidence, structurally odd layout), avoid confidently penalizing it unless context strongly confirms the student wrote it.',
    'Use only these boundaries: CONTENT REL=relevance, DEV=underdeveloped relevant idea, TA=task achievement only when assignment context supports it, CL=unclear underlying idea (not grammar), SD=important unsupported claim.',
    'ORGANIZATION COH=understandable ideas with poor logical progression, CO=cohesive device/transition, PU=paragraph unity, TS=topic sentence, CONC=genuinely weak/missing conclusion across the full canonical submission anchored to exact final text.',
    'GRAMMAR T=tense, VF=verb form, AGR=subject-verb agreement, FRAG=fragment, RO=run-on, WO=word order, ART=article, PREP=preposition.',
    'VOCABULARY WC=word choice, WF=word form, REP=harmful repetition, FORM=register/formality, COL=collocation. MECHANICS SP=spelling, P=punctuation, CAP=capitalization, SPC=spacing, FMT=provable formatting.',
    'Balance attention equally across all five passes. Category examples are boundaries, not quotas: CONTENT may ground an unsupported claim; ORGANIZATION may ground a weak transition or ending; GRAMMAR may ground agreement or verb form; VOCABULARY may ground imprecise choice, word form, repetition, register, or collocation; MECHANICS may ground spelling, punctuation, capitalization, spacing, or formatting. Never match examples mechanically.',
    'Poor grammar alone is not CONTENT/CL. Do not infer COH when the underlying ideas are not understandable. Do not fill categories or limits.',
    'Only genuine, defensible errors supported by the supplied legend. Quote minimum exact canonical OCR evidence; occurrence is zero-based; message<=240. No rewrites, duplicates, praise, styles, invented text, or OCR guesses.',
    'Never treat a zero-category explanation as proof of quality. Do not claim a clear conclusion unless the authoritative ending supports it. Do not claim Mechanics is clean when spelling or punctuation findings are returned.',
    promptDefinitions(),
    'localized means a specific passage has an identifiable replacement and suggestedText is required.',
    'For localized quotedText, copy the shortest exact erroneous text verbatim from the canonical transcript. Preserve its OCR spelling, case, punctuation, and normalized whitespace. Never put corrected or paraphrased text in quotedText; put that only in suggestedText.',
    'occurrence is the zero-based occurrence of that exact quotedText. If "students use" appears twice and the second is wrong, use occurrence=1. Wrong: quotedText="students uses" when the transcript says "students use".',
    'global is only CONTENT/ORGANIZATION holistic, absence, or structure weakness. It must anchor an exact existing relevant passage (including the ending for a missing conclusion), never invent missing text, and suggestedText may be empty. Examples include a vague thesis, inadequately developed main claim, or missing conclusion.',
    'Use legend pairs and be concise. Independently justify every finding from transcript context.',
    `transcript=${transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict academic writing correction examiner. Your task is localized error detection, not general essay evaluation. Inspect the complete student transcript sentence by sentence from the first page through the final page. Identify every clear, defensible writing error supported by the supplied correction legend. Do not stop after finding several examples. Do not assume a category is clean without checking every sentence. Do not invent errors merely to populate categories. Return exactly one JSON object matching the supplied schema.' },
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

function parseJson(value, expectedHash, attemptMeta = {}, expectedCategories = CORRECTION_CATEGORIES,
  expectedSymbols = null, coverageSource = 'initial') {
  const text = String(value || '').trim().replace(/^```json\s*/iu, '').replace(/```$/u, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw semanticError('SEMANTIC_RESPONSE_INVALID', 'json_parse', 'Semantic analysis returned invalid JSON'); }
  if (!expectedHash || parsed?.transcriptHash !== expectedHash)
    throw semanticError('SEMANTIC_SOURCE_MISMATCH', 'source_hash', 'Semantic analysis did not confirm the complete transcript hash');
  const symbolReviewCoverage = validateSemanticContract(parsed, expectedCategories, expectedSymbols, attemptMeta, coverageSource);
  const corrections = [];
  const categoryReviews = [];
  for (const category of expectedCategories) {
    const review = parsed.categories[category];
    categoryReviews.push({ category, reviewed: true, reviewedSymbols: [...review.reviewedSymbols], noFindingReason: review.noFindingReason });
    corrections.push(...review.corrections.map((item) => ({ ...item, category })));
  }
  if (corrections.length > policy.MAX_AI_CORRECTIONS)
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'correction_limit', 'Semantic analysis returned too many corrections');
  const categoryReviewNormalizations = validateCategoryReviews(categoryReviews, corrections, attemptMeta, expectedCategories);
  return { transcriptHash: parsed.transcriptHash, corrections, categoryReviews,
    symbolReviewCoverage,
    compatibilityDiagnostics: { legacyFindingCountIgnored: false, categoryReviewNormalizations } };
}

function contractError({ jsonPath, expected, actual, category = null, symbol = null,
  candidateIndex = null, requiredPropertyMissing = false, unexpectedPropertyPresent = false }) {
  return semanticError('SEMANTIC_SCHEMA_INVALID', 'semantic_schema', 'Semantic correction response violates the canonical contract', {
    jsonPath, expected, actualType: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual,
    category, symbol, candidateIndex, requiredPropertyMissing, unexpectedPropertyPresent
  });
}

function validateSemanticContract(parsed, expectedCategories = CORRECTION_CATEGORIES, expectedSymbols = null,
  attemptMeta = {}, coverageSource = 'initial') {
  const rootFields = ['transcriptHash', 'categories'];
  for (const key of Object.keys(parsed)) if (!rootFields.includes(key)) throw contractError({
    jsonPath: `$.${key}`, expected: 'no unexpected properties', actual: parsed[key], unexpectedPropertyPresent: true });
  if (!parsed.categories || typeof parsed.categories !== 'object' || Array.isArray(parsed.categories)) throw contractError({ jsonPath: '$.categories',
    expected: 'closed category object', actual: parsed.categories, requiredPropertyMissing: !('categories' in parsed) });
  for (const key of Object.keys(parsed.categories)) if (!expectedCategories.includes(key)) throw contractError({
    jsonPath: `$.categories.${key}`, expected: 'no unexpected category', actual: parsed.categories[key], unexpectedPropertyPresent: true });
  for (const category of expectedCategories) {
    const review = parsed.categories[category]; const base = `$.categories.${category}`;
    if (!review || typeof review !== 'object' || Array.isArray(review)) throw contractError({ jsonPath: base, expected: 'object', actual: review });
    for (const field of ['reviewed', 'reviewedSymbols', 'noFindingReason', 'corrections']) if (!(field in review)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'required property', actual: undefined, category, requiredPropertyMissing: true });
    for (const field of Object.keys(review)) if (!['reviewed', 'reviewedSymbols', 'noFindingReason', 'corrections'].includes(field)) throw contractError({ jsonPath: `${base}.${field}`,
      expected: 'no unexpected properties', actual: review[field], category, unexpectedPropertyPresent: true });
    if (review.reviewed !== true || !Array.isArray(review.corrections) || !Array.isArray(review.reviewedSymbols)) throw contractError({ jsonPath: base,
      expected: 'reviewed=true, reviewedSymbols array, and corrections array', actual: review, category });
    if (typeof review.noFindingReason !== 'string') throw contractError({ jsonPath: `${base}.noFindingReason`,
      expected: 'string; non-empty only when the server-calculated count is zero', actual: review.noFindingReason, category });
    for (let index = 0; index < review.corrections.length; index += 1) {
    const item = review.corrections[index]; const itemBase = `${base}.corrections[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw contractError({ jsonPath: base, expected: 'object', actual: item, candidateIndex: index });
    const providerFields = CORRECTION_FIELDS.filter((field) => field !== 'category');
    for (const field of providerFields) if (!(field in item)) throw contractError({ jsonPath: `${itemBase}.${field}`,
      expected: 'required property', actual: undefined, category, symbol: item.symbol || null,
      candidateIndex: index, requiredPropertyMissing: true });
    for (const field of Object.keys(item)) if (!providerFields.includes(field)) throw contractError({ jsonPath: `${itemBase}.${field}`,
      expected: 'no unexpected properties', actual: item[field], category, symbol: item.symbol || null,
      candidateIndex: index, unexpectedPropertyPresent: true });
    if (!CORRECTION_KINDS.includes(item.correctionKind)) throw contractError({ jsonPath: `${itemBase}.correctionKind`, expected: CORRECTION_KINDS.join('|'), actual: item.correctionKind, category, symbol: item.symbol, candidateIndex: index });
    if (!CORRECTION_SEVERITIES.includes(item.severity)) throw contractError({ jsonPath: `${itemBase}.severity`, expected: CORRECTION_SEVERITIES.join('|'), actual: item.severity, category, symbol: item.symbol, candidateIndex: index });
    if (item.stylePreference !== false) throw contractError({ jsonPath: `${itemBase}.stylePreference`, expected: 'boolean false', actual: item.stylePreference, category, symbol: item.symbol, candidateIndex: index });
    }
  }
  return symbolCoverageDiagnostics(parsed.categories, expectedCategories, expectedSymbols, attemptMeta, coverageSource);
}

function symbolCoverageDiagnostics(categories, expectedCategories, expectedSymbols, attemptMeta = {}, coverageSource = 'initial') {
  const catalog = expectedSymbols || categorySymbolCatalog(compactSemanticLegend(defaultLegend()));
  const coverage = {};
  for (const category of expectedCategories) {
    const expected = [...(catalog[category] || [])];
    const received = categories[category].reviewedSymbols.map((item) => String(item || '').trim());
    const counts = received.reduce((out, symbol) => { out[symbol] = (out[symbol] || 0) + 1; return out; }, {});
    const expectedSet = new Set(expected); const receivedSet = new Set(received);
    const missingSymbols = expected.filter((symbol) => !receivedSet.has(symbol));
    const duplicateSymbols = Object.keys(counts).filter((symbol) => counts[symbol] > 1);
    const unexpectedSymbols = [...receivedSet].filter((symbol) => !expectedSet.has(symbol));
    const complete = received.length === expected.length && !missingSymbols.length
      && !duplicateSymbols.length && !unexpectedSymbols.length;
    coverage[category] = { expected: expected.length, received: receivedSet.size, complete, sources: [coverageSource] };
    if (!complete) {
      const error = semanticError('SEMANTIC_SYMBOL_REVIEW_INCOMPLETE', 'symbol_review_coverage',
        'Semantic symbol review coverage is incomplete', { category, expectedSymbolCount: expected.length,
          receivedSymbolCount: received.length, missingSymbols, duplicateSymbols, unexpectedSymbols,
          provider: attemptMeta.provider || null, model: attemptMeta.model || null,
          attemptNumber: Number.isInteger(attemptMeta.attemptNumber) ? attemptMeta.attemptNumber : null });
      error.diagnostics = { symbolReviewCoverage: coverage, allCategoriesReviewed: false,
        totalExpectedSymbols: expectedCategories.reduce((sum, key) => sum + (catalog[key] || []).length, 0),
        totalReceivedUniqueSymbols: Object.values(coverage).reduce((sum, item) => sum + item.received, 0),
        incompleteReviewCategories: [category] };
      throw error;
    }
  }
  return coverage;
}

function meaningfulNoFindingReason(value) {
  const reason = String(value || '').replace(/\s+/gu, ' ').trim();
  if (reason.length < 8) return '';
  if (/^(?:n\/?a|none|no reason|unknown|not applicable|no findings?)\.?$/iu.test(reason)) return '';
  return reason;
}

function validateCategoryReviews(reviews, corrections, attemptMeta = {}, categories = CORRECTION_CATEGORIES) {
  if (!Array.isArray(reviews) || reviews.length !== categories.length)
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Every correction category must be reviewed');
  const seen = new Set();
  const diagnostics = [];
  for (const review of reviews) {
    const category = review?.category;
    if (!categories.includes(category) || seen.has(category) || review.reviewed !== true)
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Category reviews must be unique and complete');
    seen.add(category);
    const actual = corrections.filter((item) => item?.category === category).length;
    const originalReason = String(review.noFindingReason || '').trim();
    const meaningfulReason = meaningfulNoFindingReason(originalReason);
    if (actual === 0 && !originalReason) {
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_review_reason',
        'A zero-correction category requires provider diagnostic text', { category });
    }
    review.findingCount = actual;
    // Provider explanations remain diagnostic-only. Persist one neutral backend-owned
    // value so category review prose cannot be mistaken for validated evidence.
    review.noFindingReason = actual > 0 ? '' : DEFAULT_NO_FINDING_REASON;
    diagnostics.push({
      category,
      correctionCount: actual,
      originalReasonPresent: Boolean(originalReason),
      normalizationReason: actual > 0
        ? (originalReason ? 'nonzero_reason_cleared' : 'server_count_calculated')
        : (meaningfulReason ? 'zero_reason_retained' : 'zero_reason_defaulted'),
      provider: attemptMeta.provider || null,
      model: attemptMeta.model || null,
      attemptNumber: Number.isInteger(attemptMeta.attemptNumber)
        ? attemptMeta.attemptNumber
        : (Number.isInteger(attemptMeta.attemptIndex) ? attemptMeta.attemptIndex + 1 : null)
    });
  }
  return diagnostics;
}

function semanticError(code, stage, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.validationStage = stage;
  Object.assign(error, details);
  return error;
}

function suspiciousCoverageCategories(validated, transcript) {
  if (String(transcript || '').length < 400) return [];
  const counts = validated?.diagnostics?.acceptedByCategory || {};
  const zero = CORRECTION_CATEGORIES.filter((category) => Number(counts[category] || 0) === 0);
  return zero;
}

function buildCategoryAuditRequest(input, request, categories) {
  const legend = request.legend.filter((group) => categories.includes(group.category));
  const prompt = [
    `schema=${SEMANTIC_SCHEMA_VERSION};prompt=${SEMANTIC_PROMPT_VERSION};audit=${CATEGORY_REVIEW_POLICY_VERSION}`,
    `transcriptHash=${input.transcriptHash}`, `categories=${JSON.stringify(categories)}`,
    `pages=${JSON.stringify(request.pages)}`, `assignment=${JSON.stringify(request.context)}`,
    `legend=${JSON.stringify(legend)}`,
    'The previous pass produced unexpectedly sparse coverage. Re-read the COMPLETE canonical transcript independently for only the requested categories. Do not rely on the previous pass conclusion.',
    'For every requested category, inspect every relevant sentence or passage and every supplied legend symbol, then return every clear defensible localized finding. Return the complete symbol list in reviewedSymbols. This declares review coverage only and must not create findings, deductions, or issue counts.',
    categories.includes('GRAMMAR') ? 'GRAMMAR audit: inspect every sentence, every finite verb, and every verb phrase for agreement, tense, modal/auxiliary construction, missing copula, infinitive/gerund form, articles, prepositions, fragments, run-ons, and word order.' : '',
    categories.includes('VOCABULARY') ? 'VOCABULARY audit: inspect word choice, lexical word form, collocation, count/non-count use, harmful repetition, and register. Do not use Grammar as a fallback for lexical problems.' : '',
    categories.includes('CONTENT') ? 'CONTENT boundaries: REL=relevance, DEV=idea development, TA=task achievement supported by assignment context, CL=clarity of the underlying idea beyond grammar, SD=supporting details.' : '',
    categories.includes('ORGANIZATION') ? 'ORGANIZATION boundaries: COH=logical progression/coherence, CO=transition or cohesive device, PU=paragraph unity, TS=topic sentence, CONC=conclusion grounded in the actual ending.' : '',
    'Zero is allowed only after complete review of the requested category across the full transcript. Do not return zero merely because the essay is understandable. Never invent findings, praise, or absent text. Use exact minimal canonical OCR quotations and the supplied symbols only.',
    'Localized findings require a replacement. Global findings are allowed only for Content or Organization and must anchor an exact existing passage.',
    `transcript=${input.transcript}`
  ].join('\n');
  return [{ role: 'system', content: 'Audit only the requested writing categories. Output one strict JSON object.' },
    { role: 'user', content: prompt }];
}

function preferStrongerAuditConfig(config) {
  const chain = Array.isArray(config?.chain) ? config.chain : [];
  if (chain.length < 2) return config;
  const primaryCompact = /(?:mini|flash|haiku)/iu.test(String(chain[0]?.model || ''));
  if (!primaryCompact) return config;
  const strongerIndex = chain.findIndex((entry, index) => index > 0
    && !/(?:mini|flash|haiku)/iu.test(String(entry?.model || '')));
  if (strongerIndex < 1) return config;
  const preferred = [chain[strongerIndex], ...chain.filter((_entry, index) => index !== strongerIndex)]
    .map((entry, fallbackIndex) => ({ ...entry, fallbackIndex }));
  return { ...config, provider: preferred[0].provider, model: preferred[0].model, chain: preferred,
    fallback: preferred[1] || null, approvedModels: preferred.map((entry) => entry.model) };
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
      || typeof item.symbol !== 'string' || !item.symbol.trim()
      || typeof item.quotedText !== 'string' || !item.quotedText
      || item.quotedText.length > 500
      || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 240
      || typeof item.suggestedText !== 'string' || item.suggestedText.length > 300
      || item.quotedText.includes('\uFFFD')
      || !Number.isFinite(Number(item.confidence)) || Number(item.confidence) < 0 || Number(item.confidence) > 1
      || !Number.isInteger(Number(item.occurrence)) || Number(item.occurrence) < 0) {
      reject('INVALID_SCHEMA', category, item, candidateIndex, 'schema_validation'); continue;
    }
    if (!allowed.has(`${item.category}:${item.symbol}`)) {
      reject('LEGEND_MISMATCH', category, item, candidateIndex, 'legend_validation'); continue;
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
    if (!range) {
      const anyOccurrence = canonical.locateQuote(transcript, item.quotedText, 0);
      reject(anyOccurrence ? 'OCCURRENCE_NOT_FOUND' : 'QUOTE_NOT_FOUND', category, item, candidateIndex,
        anyOccurrence ? 'occurrence_validation' : 'quote_match_validation'); continue;
    }
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
    chain: config.chain, fallback: config.fallback, maxOutputTokens: config.maxOutputTokens,
    temperature: Number(config.temperature), responseFormat: config.responseFormat, thinkingLevel: config.thinkingLevel,
    promptVersion: SEMANTIC_PROMPT_VERSION, schemaVersion: SEMANTIC_SCHEMA_VERSION,
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
  const runtimeCategorySymbols = categorySymbolCatalog(request.legend);
  let semanticValidationMs = 0;
  const validate = (content, attemptMeta = {}) => {
    const startedAt = Date.now();
    try {
      const parsed = parseJson(content, input.transcriptHash, attemptMeta, CORRECTION_CATEGORIES,
        runtimeCategorySymbols, 'initial');
      const validated = validateCorrections(parsed.corrections, {
        transcript: input.transcript, legend: request.legend, spans: input.spans || [], env: dependencies.env || process.env,
        provider: attemptMeta.provider || null, model: attemptMeta.model || null,
        attemptIndex: Number.isInteger(attemptMeta.attemptIndex) ? attemptMeta.attemptIndex : null
      });
      validated.categoryReviews = parsed.categoryReviews;
      validated.diagnostics.categoryReviews = parsed.categoryReviews;
      validated.diagnostics.compatibility = parsed.compatibilityDiagnostics;
      validated.diagnostics.symbolReviewCoverage = parsed.symbolReviewCoverage;
      validated.diagnostics.allCategoriesReviewed = true;
      validated.diagnostics.totalExpectedSymbols = Object.values(parsed.symbolReviewCoverage)
        .reduce((sum, item) => sum + item.expected, 0);
      validated.diagnostics.totalReceivedUniqueSymbols = Object.values(parsed.symbolReviewCoverage)
        .reduce((sum, item) => sum + item.received, 0);
      validated.diagnostics.incompleteReviewCategories = [];
      return validated;
    } finally { semanticValidationMs += Date.now() - startedAt; }
  };
  const runCompletion = dependencies.runCompletion || runSemanticCompletion;
  const completion = await runCompletion({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
    onAttempt: input.onAttempt, onRetry: input.onRetry, validate, feature: 'semantic_corrections',
    metadata: { submissionId: input.submissionId, assignmentId: input.assignmentId },
    responseSchema: semanticCorrectionsSchema(input.transcriptHash, CORRECTION_CATEGORIES, runtimeCategorySymbols), schemaName: 'semantic_corrections' });
  logger.info({ message: 'Canonical pipeline timing', submissionId: input.submissionId || null,
    assignmentId: input.assignmentId || null, stage: 'semantic_correction_primary_completed',
    provider: completion.provider || null, model: completion.model || null,
    attemptNumber: completion.metrics?.attemptCount || 1,
    durationMs: completion.metrics?.semanticProviderMs || 0,
    correctionCount: completion.value?.corrections?.length || 0,
    errorCode: null, validationCode: null });
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
  const auditCategories = suspiciousCoverageCategories(validated, input.transcript);
  let audit = null;
  if (auditCategories.length) {
    const auditStartedAt = Date.now();
    const preAuditCorrectionCount = validated.corrections.length;
    logger.info({ message: 'Canonical pipeline timing', submissionId: input.submissionId || null,
      assignmentId: input.assignmentId || null, stage: 'suspicious_audit_started',
      provider: null, model: null, attemptNumber: null, durationMs: 0,
      correctionCount: preAuditCorrectionCount, triggerReason: 'suspicious_category_coverage',
      triggerCategories: auditCategories });
    try {
      const auditValidate = (content, attemptMeta = {}) => {
        const parsed = parseJson(content, input.transcriptHash, attemptMeta, auditCategories,
          runtimeCategorySymbols, 'targeted-repair');
        const checked = validateCorrections(parsed.corrections, { transcript: input.transcript, legend: request.legend,
          spans: input.spans || [], env: dependencies.env || process.env, provider: attemptMeta.provider || null,
          model: attemptMeta.model || null, attemptIndex: Number.isInteger(attemptMeta.attemptIndex) ? attemptMeta.attemptIndex : null });
        checked.categoryReviews = parsed.categoryReviews;
        checked.symbolReviewCoverage = parsed.symbolReviewCoverage;
        return checked;
      };
      const auditCompletion = await runCompletion({ messages: buildCategoryAuditRequest(input, request, auditCategories),
        config: preferStrongerAuditConfig(config),
        env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
        validate: auditValidate, feature: 'semantic_corrections_category_audit',
        metadata: { submissionId: input.submissionId, assignmentId: input.assignmentId },
        responseSchema: semanticCorrectionsSchema(input.transcriptHash, auditCategories, runtimeCategorySymbols), schemaName: 'semantic_corrections_category_audit' });
      const auditValidated = auditCompletion.value || auditValidate(auditCompletion.content);
      const merged = canonical.mergeCanonicalCorrections({ aiCorrections: [...validated.corrections, ...auditValidated.corrections] });
      validated.corrections = merged.corrections;
      validated.diagnostics.rawCorrectionCount += auditValidated.diagnostics.rawCorrectionCount;
      validated.diagnostics.acceptedCorrectionCount = validated.corrections.length;
      validated.diagnostics.rejectedCorrectionCount += auditValidated.diagnostics.rejectedCorrectionCount;
      for (const [reason, count] of Object.entries(auditValidated.diagnostics.rejectionReasons || {})) {
        validated.diagnostics.rejectionReasons[reason] = Number(validated.diagnostics.rejectionReasons[reason] || 0) + Number(count || 0);
      }
      validated.diagnostics.rejectionDiagnostics.push(...(auditValidated.diagnostics.rejectionDiagnostics || []));
      for (const category of auditCategories) {
        const count = validated.corrections.filter((item) => item.category === category).length;
        validated.diagnostics.acceptedByCategory[category] = count;
        validated.diagnostics.returnedByCategory[category] = Number(validated.diagnostics.returnedByCategory[category] || 0)
          + Number(auditValidated.diagnostics.returnedByCategory[category] || 0);
        validated.diagnostics.rejectedByCategory[category] = Number(validated.diagnostics.rejectedByCategory[category] || 0)
          + Number(auditValidated.diagnostics.rejectedByCategory[category] || 0);
        for (const [reason, reasonCount] of Object.entries(auditValidated.diagnostics.rejectionReasonsByCategory[category] || {})) {
          validated.diagnostics.rejectionReasonsByCategory[category][reason] =
            Number(validated.diagnostics.rejectionReasonsByCategory[category][reason] || 0) + Number(reasonCount || 0);
        }
        const review = validated.categoryReviews.find((item) => item.category === category);
        if (review) {
          review.findingCount = count;
          review.noFindingReason = count ? '' : DEFAULT_NO_FINDING_REASON;
        }
        validated.diagnostics.symbolReviewCoverage[category] = {
          ...validated.diagnostics.symbolReviewCoverage[category], sources: ['initial', 'targeted-repair']
        };
      }
      audit = { requested: true, categories: auditCategories, provider: auditCompletion.provider, model: auditCompletion.model,
        attemptCount: auditCompletion.metrics?.attemptCount || 1, acceptedByCategory: auditValidated.diagnostics.acceptedByCategory,
        rejectedByCategory: auditValidated.diagnostics.rejectedByCategory, mergeDiagnostics: merged.diagnostics,
        durationMs: Date.now() - auditStartedAt,
        addedCorrectionCount: Math.max(0, validated.corrections.length - preAuditCorrectionCount) };
      logger.info({ message: 'Canonical pipeline timing', submissionId: input.submissionId || null,
        assignmentId: input.assignmentId || null, stage: 'suspicious_audit_completed',
        provider: auditCompletion.provider || null, model: auditCompletion.model || null,
        attemptNumber: auditCompletion.metrics?.attemptCount || 1, durationMs: audit.durationMs,
        correctionCount: validated.corrections.length, addedCorrectionCount: audit.addedCorrectionCount,
        validationCode: null, triggerReason: 'suspicious_category_coverage', triggerCategories: auditCategories });
    } catch (error) {
      audit = { requested: true, categories: auditCategories, failed: true,
        errorCode: error?.code || 'CATEGORY_AUDIT_FAILED', durationMs: Date.now() - auditStartedAt,
        addedCorrectionCount: 0 };
      logger.warn({ message: 'Canonical pipeline timing', submissionId: input.submissionId || null,
        assignmentId: input.assignmentId || null, stage: 'suspicious_audit_completed',
        provider: error?.provider || null, model: error?.model || null,
        attemptNumber: error?.attemptCount || null, durationMs: audit.durationMs,
        correctionCount: validated.corrections.length, addedCorrectionCount: 0,
        errorCode: audit.errorCode, validationCode: error?.validationCode || null,
        triggerReason: 'suspicious_category_coverage', triggerCategories: auditCategories });
    }
  }
  validated.diagnostics.categoryAudit = audit || { requested: false, categories: [] };
  return { corrections: validated.corrections, diagnostics: validated.diagnostics,
    provider: completion.provider, model: completion.model,
    usage: completion.usage, sourceKey: semanticSourceKey({ correctionSourceHash: input.transcriptHash, config,
      legendVersion: input.legend?.version, legendContentHash: input.legend?.contentHash }),
    metrics: { ...completion.metrics, semanticRequestBuildMs, semanticParseMs,
      semanticValidationMs, categoryAuditRequestCount: auditCategories.length ? 1 : 0,
      categoryAuditMs: audit?.durationMs || 0,
      categoryAuditAddedCorrectionCount: audit?.addedCorrectionCount || 0,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { SEMANTIC_PROMPT_VERSION, SEMANTIC_SCHEMA_VERSION, CATEGORY_REVIEW_POLICY_VERSION,
  DEFAULT_NO_FINDING_REASON,
  compactAssignment, compactSemanticLegend,
  categorySymbolCatalog, symbolCoverageDiagnostics,
  compactLanguageToolExclusions, compactPageManifest, buildSemanticRequest, buildLegacySemanticRequestForBenchmark,
  buildCategoryAuditRequest, preferStrongerAuditConfig, suspiciousCoverageCategories,
  parseJson, validateSemanticContract, validateCategoryReviews, validateCorrections, semanticSourceKey, analyze };
