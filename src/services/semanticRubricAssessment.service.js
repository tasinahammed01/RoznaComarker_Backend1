'use strict';

const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');

const PROMPT_VERSION = 'semantic-rubric-assessment-v1';
const SCHEMA_VERSION = 'semantic-rubric-assessment-json-v1';
const SEMANTIC_CATEGORIES = ['CONTENT', 'ORGANIZATION', 'VOCABULARY'];
const MAX_COMMENT = 320;
const MAX_EXPLANATION = 320;
const MAX_SUGGESTION = 240;

const clean = (value, max = MAX_COMMENT) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function compactAssignment(assignment = {}) {
  return {
    title: clean(assignment?.title, 240),
    instructions: clean(assignment?.instructions || assignment?.description, 1800),
    rubric: assignment?.rubric || assignment?.rubrics || null
  };
}

function correctionCatalog(corrections = []) {
  return Object.freeze((Array.isArray(corrections) ? corrections : [])
    .filter((item) => item?.id && SEMANTIC_CATEGORIES.includes(item?.category))
    .map((item) => Object.freeze({
      correctionId: String(item.id),
      category: item.category,
      symbol: item.symbol,
      quotedText: clean(item.quotedText, 220),
      suggestedText: clean(item.suggestedText, 220),
      page: Number.isFinite(Number(item.page)) ? Number(item.page) : null,
      fileId: item.fileId ? String(item.fileId) : null
    })));
}

function allowedCorrectionIdsByCategory(catalog = []) {
  return Object.freeze(Object.fromEntries(SEMANTIC_CATEGORIES.map((category) => [
    category,
    Object.freeze(catalog.filter((item) => item.category === category).map((item) => item.correctionId))
  ])));
}

function compactPageManifest(pages = []) {
  return (Array.isArray(pages) ? pages : []).map((page) => ({ fileId: String(page?.fileId || ''),
    page: Number(page?.pageNumber || 1), startChar: Number(page?.startChar || 0), endChar: Number(page?.endChar || 0) }));
}

function buildRequest(input) {
  const assignment = compactAssignment(input.assignment || {});
  const contextStatus = assignment.instructions ? 'instructions' : assignment.title ? 'title_only' : 'none';
  const catalog = correctionCatalog(input.corrections);
  const allowedCorrectionIds = allowedCorrectionIdsByCategory(catalog);
  const response = { sourceHash: input.sourceHash, categories: Object.fromEntries(SEMANTIC_CATEGORIES.map((category) => [category, {
    score: 0, maxScore: 20, comment: 'Concise category judgment', strengthEvidence: [
      { quotedText: 'exact transcript quote', explanation: 'why this is positive evidence' }
    ], improvementEvidence: [
      { evidenceType: 'correction', correctionId: 'exact ID copied from correctionCatalog for this category',
        quotedText: 'exact transcript quote', explanation: 'what is weak', suggestion: 'specific improvement' },
      { evidenceType: 'transcript', correctionId: null, quotedText: 'exact transcript quote',
        explanation: 'transcript-grounded weakness when this category has no applicable correction', suggestion: 'specific improvement' }
    ]
  }])) };
  const prompt = [
    `schema=${SCHEMA_VERSION};prompt=${PROMPT_VERSION}`,
    `sourceHash=${input.sourceHash}`,
    `contextStatus=${contextStatus}`,
    `assignment=${JSON.stringify(assignment)}`,
    `statistics=${JSON.stringify(input.statistics || {})}`,
    `pageManifest=${JSON.stringify(compactPageManifest(input.pageManifest || []))}`,
    `correctionCatalog=${JSON.stringify(catalog)}`,
    `allowedCorrectionIdsByCategory=${JSON.stringify(allowedCorrectionIds)}`,
    `response=${JSON.stringify(response)}`,
    'Assess only the explicitly named CONTENT, ORGANIZATION, and VOCABULARY properties. Do not reorder, rename, alias, or add categories. Return strict JSON only with no Markdown or explanatory prose. Repeat sourceHash exactly. Every score and maxScore must be a JSON number, never a string, fraction, percentage, label, or explanatory value. CONTENT.score, ORGANIZATION.score, and VOCABULARY.score must each be between 0 and 20 inclusive, and each maxScore must be exactly 20. Do not score Grammar, Mechanics, Presentation, or overall; the backend calculates those values. Do not invent issue counts. Every quote must be copied exactly from the transcript. For correction evidence, copy correctionId exactly from correctionCatalog and only from the same category; never generate, shorten, translate, infer, or substitute an array index or display marker number. For a category whose allowedCorrectionIdsByCategory list is empty, do not return correction evidence. Use transcript evidence with evidenceType="transcript", correctionId=null, an exact transcript quote, explanation, and suggestion. Strength evidence is always grounded by an exact transcript quote. Forbidden example: evidenceType="correction" with correctionId="1" or any ID absent from that category catalog. If detailed instructions are unavailable but a title exists, Content must state it was evaluated against the assignment title because detailed instructions were unavailable. If neither title nor instructions exist, make Content provisional and explain that task achievement cannot be confidently finalized.',
    `transcript=${input.transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict evidence-grounded writing rubric assessor. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const length = JSON.stringify(messages).length;
  return { messages, promptCharacters: length, promptInputTokenEstimate: Math.ceil(length / 4), contextStatus,
    correctionCatalog: catalog, allowedCorrectionIds };
}

function semanticRubricError(code, message, validationStage = 'schema_validation', path = null, details = null) {
  const error = new Error(message);
  error.code = code;
  error.validationStage = validationStage;
  error.validationIssues = path ? [{ path, code, ...(details || {}) }] : [];
  return error;
}

function parseJson(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/^```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/iu);
  const jsonText = fenced ? fenced[1].trim() : text;
  if (/```/u.test(jsonText) || (!fenced && /^```/u.test(text))) {
    const error = semanticRubricError('SEMANTIC_RUBRIC_MARKDOWN',
      'Semantic rubric assessment returned unsupported Markdown', 'markdown_fence');
    error.markdownFenceDetected = true;
    throw error;
  }
  try { return JSON.parse(jsonText); }
  catch {
    throw semanticRubricError('SEMANTIC_RUBRIC_JSON_INVALID', 'Semantic rubric assessment returned invalid JSON',
      'json_parse');
  }
}

function assertQuote(transcript, quote, path) {
  const value = String(quote || '').trim();
  if (!value || !transcript.includes(value)) {
    throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED',
      'Semantic rubric evidence quote is not in the transcript', 'evidence_validation', path);
  }
  return value;
}

function validateAssessment(parsed, { sourceHash, transcript, corrections = [], contextStatus = 'none' }) {
  if (!parsed || typeof parsed !== 'object' || parsed.sourceHash !== sourceHash)
    throw semanticRubricError('SEMANTIC_RUBRIC_SOURCE_MISMATCH', 'Semantic rubric assessment source hash mismatch',
      'source_hash', 'sourceHash');
  const categories = parsed.categories || {};
  const returned = Object.keys(categories);
  if (!SEMANTIC_CATEGORIES.every((category) => returned.includes(category)) || returned.some((category) => !SEMANTIC_CATEGORIES.includes(category)))
    throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric assessment returned invalid categories',
      'schema_validation', 'categories');
  const correctionMap = new Map((corrections || []).map((item) => [String(item.id), item]));
  const validated = {};
  const seenEvidence = new Set();
  for (const category of SEMANTIC_CATEGORIES) {
    const item = categories[category] || {};
    const maxScore = item.maxScore;
    const score = item.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 20
      || typeof maxScore !== 'number' || maxScore !== 20) {
      throw semanticRubricError('SEMANTIC_RUBRIC_SCORE_INVALID', 'Semantic rubric score is invalid',
        'score_validation', `categories.${category}.score`, {
          category,
          expectedType: 'number',
          actualType: score === null ? 'null' : typeof score,
          expectedMinimum: 0,
          expectedMaximum: 20,
          finite: typeof score === 'number' ? Number.isFinite(score) : false,
          ...(typeof score === 'number' && Number.isFinite(score) ? { actualNumericValue: score } : {})
        });
    }
    let comment = clean(item.comment);
    if (!comment) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric comment is missing',
      'schema_validation', `categories.${category}.comment`);
    if (category === 'CONTENT' && contextStatus === 'title_only' && !/title because detailed instructions were unavailable/i.test(comment))
      comment = `${comment} Evaluated against the assignment title because detailed instructions were unavailable.`;
    if (category === 'CONTENT' && contextStatus === 'none' && !/provisional/i.test(comment))
      comment = `${comment} Content task achievement is provisional because no assignment title or detailed instructions were available.`;
    const strengthEvidence = [];
    for (const ev of Array.isArray(item.strengthEvidence) ? item.strengthEvidence : []) {
      const quotedText = assertQuote(transcript, ev?.quotedText, `categories.${category}.strengthEvidence.quotedText`);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      if (!explanation) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
        'Semantic rubric strength explanation is missing', 'schema_validation',
        `categories.${category}.strengthEvidence.explanation`);
      const key = `${category}:strength:${quotedText}:${explanation}`;
      if (!seenEvidence.has(key)) { seenEvidence.add(key); strengthEvidence.push({ quotedText, explanation }); }
    }
    const improvementEvidence = [];
    for (const ev of Array.isArray(item.improvementEvidence) ? item.improvementEvidence : []) {
      const rawCorrectionId = ev?.correctionId;
      const correctionId = typeof rawCorrectionId === 'string' ? rawCorrectionId.trim() : '';
      const evidenceType = ev?.evidenceType || (correctionId ? 'correction' : null);
      let correction = null;
      if (evidenceType === 'correction') {
        if (!correctionId) throw semanticRubricError('SEMANTIC_RUBRIC_CORRECTION_INVALID',
          'Semantic rubric correction evidence is missing a correction ID', 'evidence_validation',
          `categories.${category}.improvementEvidence.correctionId`);
        correction = correctionMap.get(correctionId);
        if (!correction || correction.category !== category)
          throw semanticRubricError('SEMANTIC_RUBRIC_CORRECTION_INVALID',
            'Semantic rubric referenced an invalid correction ID', 'evidence_validation',
            `categories.${category}.improvementEvidence.correctionId`);
      } else if (evidenceType === 'transcript') {
        if (rawCorrectionId !== null && rawCorrectionId !== undefined)
          throw semanticRubricError('SEMANTIC_RUBRIC_CORRECTION_INVALID',
            'Transcript evidence must not contain a correction ID', 'evidence_validation',
            `categories.${category}.improvementEvidence.correctionId`);
      } else {
        throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
          'Semantic rubric improvement evidence type is invalid', 'schema_validation',
          `categories.${category}.improvementEvidence.evidenceType`);
      }
      const quotedText = assertQuote(transcript, ev?.quotedText || correction?.quotedText,
        `categories.${category}.improvementEvidence.quotedText`);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      const suggestion = clean(ev?.suggestion, MAX_SUGGESTION);
      if (!explanation || !suggestion) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
        'Semantic rubric improvement evidence is incomplete', 'schema_validation',
        `categories.${category}.improvementEvidence`);
      const key = `${category}:improve:${evidenceType}:${correctionId}:${quotedText}`;
      if (!seenEvidence.has(key)) {
        seenEvidence.add(key);
        improvementEvidence.push({
          evidenceType,
          correctionId: evidenceType === 'correction' ? correctionId : null,
          quotedText,
          explanation,
          suggestion
        });
      }
    }
    validated[category] = { score, maxScore: 20, comment, issueCount: (corrections || []).filter((c) => c.category === category).length,
      strengthEvidence, improvementEvidence };
  }
  return { sourceHash, categories: validated, status: contextStatus === 'none' ? 'partial' : 'completed' };
}

async function assess(input, dependencies = {}) {
  const config = dependencies.config || getSemanticAIConfig();
  if (!getSemanticAIConfigStatus(config, dependencies.env || process.env).configured) {
    throw semanticRubricError('AI_PROVIDER_NOT_CONFIGURED', 'Semantic AI provider configuration is incomplete.');
  }
  const request = buildRequest(input);
  const startedAt = Date.now();
  const runCompletion = dependencies.runCompletion || runSemanticCompletion;
  const validate = (content) => validateAssessment(parseJson(content), {
    sourceHash: input.sourceHash, transcript: input.transcript,
    corrections: input.corrections, contextStatus: request.contextStatus
  });
  const completion = await runCompletion({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
    validate, feature: 'semantic_rubric_assessment' });
  const assessment = completion.value || validate(completion.content);
  const attempts = Array.isArray(completion.metrics?.attempts) ? completion.metrics.attempts : [];
  return { ...assessment, provider: completion.provider, model: completion.model, usage: completion.usage,
    metrics: { ...completion.metrics, attempts, validationRepairAttempted: false,
      semanticRubricAssessmentMs: Date.now() - startedAt,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { PROMPT_VERSION, SCHEMA_VERSION, SEMANTIC_CATEGORIES, correctionCatalog,
  allowedCorrectionIdsByCategory, buildRequest, parseJson, validateAssessment, assess };
