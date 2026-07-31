'use strict';

const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');
const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');
const canonical = require('./correctionCanonical.service');
const policy = require('./aiCorrectionPolicy.service');
const { promptDefinitions } = require('./writingCategoryDefinitions.service');
const { semanticCorrectionsSchema } = require('./structuredOutputSchemas.service');

const SEMANTIC_PROMPT_VERSION = 'semantic-learner-english-second-pass-v6';
const SEMANTIC_SCHEMA_VERSION = 'semantic-corrections-v4';
const CATEGORY_REVIEW_POLICY_VERSION = 'all-categories-reviewed-v1';
const SEMANTIC_CATEGORIES = new Set(Object.keys(policy.CATEGORY_POLICY));
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
    category: group.key,
    symbols: (group.symbols || []).map((item) => ({ symbol: item.symbol, label: item.label, rule: item.description }))
  }));
}

function compactLanguageToolExclusions(corrections = []) {
  return corrections.map((item) => ({ category: item?.category, symbol: item?.symbol,
    startChar: Number(item?.startChar), endChar: Number(item?.endChar),
    quotedText: clean(item?.quotedText, 160),
    suggestedText: clean(item?.suggestedText, 160) }))
    .filter((item) => item.category && item.symbol && Number.isFinite(item.startChar)
      && Number.isFinite(item.endChar) && item.endChar > item.startChar);
}

function compactPageManifest(pages = []) {
  return pages.map((page) => ({ fileId: String(page?.fileId || ''), page: Number(page?.pageNumber || 1),
    startChar: Number(page?.startChar || 0), endChar: Number(page?.endChar || 0) }));
}

function buildSemanticRequest({ transcript, assignment = {}, languageToolCorrections = [], transcriptHash, pageManifest = [] }) {
  if (!transcriptHash) throw new Error('Semantic analysis requires a transcript hash');
  const legend = compactSemanticLegend(defaultLegend());
  const exclusions = compactLanguageToolExclusions(languageToolCorrections);
  const context = compactAssignment(assignment);
  const pages = compactPageManifest(pageManifest);
  const responseShape = { transcriptHash, categoryReviews: Object.keys(policy.CATEGORY_POLICY).map((category) => ({
    category, reviewed: true, findingCount: category === 'CONTENT' ? 2 : 0,
    noFindingReason: category === 'CONTENT' ? '' : '<meaningful reason no additional grounded finding exists>'
  })), corrections: [
    { category: 'CONTENT', symbol: 'DEV', correctionKind: 'localized', quotedText: '<exact quote>', occurrence: 0,
      message: '<explanation>', suggestedText: '<replacement>', confidence: 0.86 },
    { category: 'CONTENT', symbol: 'DEV', correctionKind: 'global', quotedText: '<exact existing anchor passage>', occurrence: 0,
      message: '<holistic weakness>', suggestedText: '', confidence: 0.86 }
  ] };
  const prompt = [
    `schema=${SEMANTIC_SCHEMA_VERSION};prompt=${SEMANTIC_PROMPT_VERSION}`,
    `transcriptHash=${transcriptHash}`,
    `pages=${JSON.stringify(pages)}`,
    `assignment=${JSON.stringify(context)}`,
    `legend=${JSON.stringify(legend)}`,
    `languageToolExclusions=${JSON.stringify(exclusions)}`,
    `response=${JSON.stringify(responseShape)}`,
    'Review every category exactly once in categoryReviews. reviewed=true. findingCount must equal raw corrections in that category. When findingCount=0 give a meaningful non-empty noFindingReason; otherwise noFindingReason must be empty. Zero findings remains valid.',
    'CONTENT: review assignment relevance, task achievement, controlling claim/thesis clarity or absence, claim development, support specificity, and repetitive development that adds no substance.',
    'ORGANIZATION: review logical paragraph order, coherence, transitions, topic sentences, and introduction/conclusion structure.',
    'VOCABULARY, GRAMMAR, MECHANICS: review fully but do not duplicate equivalent LanguageTool findings.',
    'Use only these boundaries: CONTENT REL=relevance, DEV=underdeveloped relevant idea, TA=task achievement only when assignment context supports it, CL=unclear underlying idea (not grammar), SD=important unsupported claim.',
    'ORGANIZATION COH=understandable ideas with poor logical progression, CO=cohesive device/transition, PU=paragraph unity, TS=topic sentence, CONC=genuinely weak/missing conclusion across the full canonical submission anchored to exact final text.',
    'GRAMMAR T=tense, VF=verb form, AGR=subject-verb agreement, FRAG=fragment, RO=run-on, WO=word order, ART=article, PREP=preposition.',
    'VOCABULARY WC=word choice, WF=word form, REP=harmful repetition, FORM=register/formality, COL=collocation. MECHANICS SP=spelling, P=punctuation, CAP=capitalization, SPC=spacing, FMT=provable formatting.',
    'Act as a second-pass learner-English reviewer. Examples: "It have many advantages." AGR -> "It has many advantages."; "Students sometimes spends many hours." AGR -> "Students sometimes spend many hours."; "They may planned to use social media." VF -> "They may plan to use social media."; "they cannot finished their assignments" VF -> "they cannot finish their assignments".',
    'Also detect defensible patterns like "This problem are becoming more serious" AGR, "students sees other people" AGR, "they may compares themselves" one VF/AGR correction only, "People usually posts" AGR, "they has not studied" AGR, "Students shares" AGR, "they does not realize" AGR, and "who can seeing" VF. Never match these phrases mechanically.',
    'Poor grammar alone is not CONTENT/CL. Do not infer COH when the underlying ideas are not understandable. Do not fill categories or limits.',
    'Only genuine errors. Quote minimum exact evidence; occurrence is zero-based; message<=240. No rewrites, duplicates, praise, styles, or OCR guesses.',
    promptDefinitions(),
    'localized means a specific passage has an identifiable replacement and suggestedText is required.',
    'global is only CONTENT/ORGANIZATION holistic, absence, or structure weakness. It must anchor an exact existing relevant passage (including the ending for a missing conclusion), never invent missing text, and suggestedText may be empty. Examples include a vague thesis, inadequately developed main claim, or missing conclusion.',
    'Use legend pairs; avoid equivalent LT targets. Be concise.',
    `transcript=${transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'Analyze writing evidence. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const serializedLength = JSON.stringify(messages).length;
  return { messages, legend, exclusions, pages, context, promptCharacters: serializedLength,
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
  validateCategoryReviews(parsed.categoryReviews, parsed.corrections);
  return parsed;
}

function validateCategoryReviews(reviews, corrections) {
  const categories = Object.keys(policy.CATEGORY_POLICY);
  if (!Array.isArray(reviews) || reviews.length !== categories.length)
    throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Every correction category must be reviewed');
  const seen = new Set();
  for (const review of reviews) {
    const category = review?.category;
    if (!categories.includes(category) || seen.has(category) || review.reviewed !== true)
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_reviews', 'Category reviews must be unique and complete');
    seen.add(category);
    const actual = corrections.filter((item) => item?.category === category).length;
    if (!Number.isInteger(review.findingCount) || review.findingCount !== actual)
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_review_count', 'Category review count does not match findings');
    const reason = String(review.noFindingReason || '').trim();
    if ((actual === 0 && !reason) || (actual > 0 && reason))
      throw semanticError('SEMANTIC_SCHEMA_INVALID', 'category_review_reason', 'Category review reason is inconsistent with findings');
  }
  return true;
}

function semanticError(code, stage, message) {
  const error = new Error(message);
  error.code = code;
  error.validationStage = stage;
  return error;
}

function validateCorrections(corrections, { transcript, legend, spans = [], env = process.env }) {
  const allowed = new Set((legend || []).flatMap((group) => (group.symbols || [])
    .map((item) => `${group.category}:${item.symbol}`)));
  const thresholds = policy.confidenceThresholds(env);
  const accepted = [];
  const rejectionReasons = {};
  const perCategory = {};
  const returnedByCategory = Object.fromEntries(Object.keys(policy.CATEGORY_POLICY).map((key) => [key, 0]));
  const rejectedByCategory = Object.fromEntries(Object.keys(policy.CATEGORY_POLICY).map((key) => [key, 0]));
  const rejectionReasonsByCategory = Object.fromEntries(Object.keys(policy.CATEGORY_POLICY).map((key) => [key, {}]));
  const reject = (reason, category) => {
    rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    if (rejectedByCategory[category] !== undefined) {
      rejectedByCategory[category] += 1;
      rejectionReasonsByCategory[category][reason] = (rejectionReasonsByCategory[category][reason] || 0) + 1;
    }
  };
  for (const item of corrections) {
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
      reject('INVALID_SCHEMA', category); continue;
    }
    if (item.stylePreference === true) { reject('STYLE_PREFERENCE', category); continue; }
    const correctionKind = item.correctionKind || 'localized';
    if (!['localized', 'global'].includes(correctionKind)
      || (correctionKind === 'global' && !['CONTENT', 'ORGANIZATION'].includes(item.category))
      || (correctionKind === 'localized' && !item.suggestedText.trim())) {
      reject('UNSUPPORTED_CORRECTION_KIND', category); continue;
    }
    if (item.category === 'VOCABULARY' && item.symbol === 'WC'
      && /\bmore\s+\p{L}+er\b/iu.test(item.quotedText)
      && !/\bmore\b/iu.test(item.suggestedText)) {
      reject('CATEGORY_MISMATCH', category); continue;
    }
    if (item.severity != null && !policy.SEVERITIES.has(String(item.severity).toLowerCase())) {
      reject('INVALID_SEVERITY', category); continue;
    }
    if (Number(item.confidence) < thresholds[item.category]) { reject('LOW_CONFIDENCE', category); continue; }
    if ((perCategory[item.category] || 0) >= policy.MAX_AI_CORRECTIONS_PER_CATEGORY[item.category]) {
      reject('CATEGORY_LIMIT', category); continue;
    }
    const range = canonical.locateQuote(transcript, item.quotedText, Number(item.occurrence));
    if (!range) { reject('UNGROUNDED_EVIDENCE', category); continue; }
    const normalized = canonical.normalizeCorrection({ ...item, startChar: range.start, endChar: range.end },
      transcript, spans, defaultLegend(), 'AI');
    if (!normalized || (spans.length && !normalized.wordIds.length)) { reject('INVALID_LOCATION', category); continue; }
    accepted.push(normalized);
    perCategory[item.category] = (perCategory[item.category] || 0) + 1;
  }
  const diagnostics = {
    responseJsonParsed: true, transcriptHashMatch: true, schemaValidated: true, groundingValidated: true,
    rawCorrectionCount: corrections.length, acceptedCorrectionCount: accepted.length,
    rejectedCorrectionCount: corrections.length - accepted.length, rejectionReasons, thresholds,
    returnedByCategory, acceptedByCategory: Object.fromEntries(Object.keys(returnedByCategory)
      .map((key) => [key, perCategory[key] || 0])), rejectedByCategory, rejectionReasonsByCategory
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

function semanticSourceKey({ correctionSourceHash, config = getSemanticAIConfig(), legendVersion = defaultLegend().version }) {
  return crypto.createHash('sha256').update(JSON.stringify({ correctionSourceHash, provider: config.provider, model: config.model,
    fallback: config.fallback, promptVersion: SEMANTIC_PROMPT_VERSION, schemaVersion: SEMANTIC_SCHEMA_VERSION,
    policyVersion: policy.POLICY_VERSION, categoryReviewPolicyVersion: CATEGORY_REVIEW_POLICY_VERSION,
    confidenceThresholds: policy.confidenceThresholds(), legendVersion })).digest('hex');
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
  const validate = (content) => {
    const startedAt = Date.now();
    try {
      const parsed = parseJson(content, input.transcriptHash);
      const validated = validateCorrections(parsed.corrections, {
        transcript: input.transcript, legend: request.legend, spans: input.spans || [], env: dependencies.env || process.env
      });
      validated.categoryReviews = parsed.categoryReviews;
      validated.diagnostics.categoryReviews = parsed.categoryReviews;
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
    usage: completion.usage, sourceKey: semanticSourceKey({ correctionSourceHash: input.transcriptHash, config }),
    metrics: { ...completion.metrics, semanticRequestBuildMs, semanticParseMs,
      semanticValidationMs,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { SEMANTIC_PROMPT_VERSION, SEMANTIC_SCHEMA_VERSION, CATEGORY_REVIEW_POLICY_VERSION,
  compactAssignment, compactSemanticLegend,
  compactLanguageToolExclusions, compactPageManifest, buildSemanticRequest, buildLegacySemanticRequestForBenchmark,
  parseJson, validateCategoryReviews, validateCorrections, semanticSourceKey, analyze };
