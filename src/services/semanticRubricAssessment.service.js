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

function relevantCorrections(corrections = []) {
  return (Array.isArray(corrections) ? corrections : []).filter((item) => SEMANTIC_CATEGORIES.includes(item?.category))
    .map((item) => ({ id: String(item.id || ''), category: item.category, symbol: item.symbol,
      quotedText: clean(item.quotedText, 220), message: clean(item.message, 220), suggestedText: clean(item.suggestedText, 220) }));
}

function compactPageManifest(pages = []) {
  return (Array.isArray(pages) ? pages : []).map((page) => ({ fileId: String(page?.fileId || ''),
    page: Number(page?.pageNumber || 1), startChar: Number(page?.startChar || 0), endChar: Number(page?.endChar || 0) }));
}

function buildRequest(input) {
  const assignment = compactAssignment(input.assignment || {});
  const contextStatus = assignment.instructions ? 'instructions' : assignment.title ? 'title_only' : 'none';
  const response = { sourceHash: input.sourceHash, categories: Object.fromEntries(SEMANTIC_CATEGORIES.map((category) => [category, {
    score: 0, maxScore: 20, comment: 'Concise category judgment', strengthEvidence: [
      { quotedText: 'exact transcript quote', explanation: 'why this is positive evidence' }
    ], improvementEvidence: [
      { correctionId: 'existing correction id', quotedText: 'exact transcript quote', explanation: 'what is weak', suggestion: 'specific improvement' }
    ]
  }])) };
  const prompt = [
    `schema=${SCHEMA_VERSION};prompt=${PROMPT_VERSION}`,
    `sourceHash=${input.sourceHash}`,
    `contextStatus=${contextStatus}`,
    `assignment=${JSON.stringify(assignment)}`,
    `statistics=${JSON.stringify(input.statistics || {})}`,
    `pageManifest=${JSON.stringify(compactPageManifest(input.pageManifest || []))}`,
    `validatedCorrections=${JSON.stringify(relevantCorrections(input.corrections || []))}`,
    `response=${JSON.stringify(response)}`,
    'Assess only CONTENT, ORGANIZATION, and VOCABULARY. Return strict JSON only. Repeat sourceHash exactly. Do not score Grammar, Mechanics, Presentation, or overall. Do not invent issue counts. Every quote must be copied exactly from the transcript. Improvement evidence may reference only supplied correction IDs from the same category. If detailed instructions are unavailable but a title exists, Content must state it was evaluated against the assignment title because detailed instructions were unavailable. If neither title nor instructions exist, make Content provisional and explain that task achievement cannot be confidently finalized.',
    `transcript=${input.transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict evidence-grounded writing rubric assessor. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const length = JSON.stringify(messages).length;
  return { messages, promptCharacters: length, promptInputTokenEstimate: Math.ceil(length / 4), contextStatus };
}

function semanticRubricError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseJson(content) {
  const text = String(content || '').trim();
  if (/^```/u.test(text) || /```/u.test(text)) throw semanticRubricError('SEMANTIC_RUBRIC_MARKDOWN', 'Semantic rubric assessment returned Markdown');
  try { return JSON.parse(text); }
  catch { throw semanticRubricError('SEMANTIC_RUBRIC_JSON_INVALID', 'Semantic rubric assessment returned invalid JSON'); }
}

function assertQuote(transcript, quote) {
  const value = String(quote || '').trim();
  if (!value || !transcript.includes(value)) throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED', 'Semantic rubric evidence quote is not in the transcript');
  return value;
}

function validateAssessment(parsed, { sourceHash, transcript, corrections = [], contextStatus = 'none' }) {
  if (!parsed || typeof parsed !== 'object' || parsed.sourceHash !== sourceHash)
    throw semanticRubricError('SEMANTIC_RUBRIC_SOURCE_MISMATCH', 'Semantic rubric assessment source hash mismatch');
  const categories = parsed.categories || {};
  const returned = Object.keys(categories);
  if (!SEMANTIC_CATEGORIES.every((category) => returned.includes(category)) || returned.some((category) => !SEMANTIC_CATEGORIES.includes(category)))
    throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric assessment returned invalid categories');
  const correctionMap = new Map((corrections || []).map((item) => [String(item.id), item]));
  const validated = {};
  const seenEvidence = new Set();
  for (const category of SEMANTIC_CATEGORIES) {
    const item = categories[category] || {};
    const maxScore = Number(item.maxScore);
    const score = Number(item.score);
    if (!Number.isFinite(score) || maxScore !== 20)
      throw semanticRubricError('SEMANTIC_RUBRIC_SCORE_INVALID', 'Semantic rubric score is invalid');
    const clampedScore = Math.max(0, Math.min(20, score));
    let comment = clean(item.comment);
    if (!comment) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric comment is missing');
    if (category === 'CONTENT' && contextStatus === 'title_only' && !/title because detailed instructions were unavailable/i.test(comment))
      comment = `${comment} Evaluated against the assignment title because detailed instructions were unavailable.`;
    if (category === 'CONTENT' && contextStatus === 'none' && !/provisional/i.test(comment))
      comment = `${comment} Content task achievement is provisional because no assignment title or detailed instructions were available.`;
    const strengthEvidence = [];
    for (const ev of Array.isArray(item.strengthEvidence) ? item.strengthEvidence : []) {
      const quotedText = assertQuote(transcript, ev?.quotedText);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      if (!explanation) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric strength explanation is missing');
      const key = `${category}:strength:${quotedText}:${explanation}`;
      if (!seenEvidence.has(key)) { seenEvidence.add(key); strengthEvidence.push({ quotedText, explanation }); }
    }
    const improvementEvidence = [];
    for (const ev of Array.isArray(item.improvementEvidence) ? item.improvementEvidence : []) {
      const correctionId = String(ev?.correctionId || '').trim();
      const correction = correctionMap.get(correctionId);
      if (!correction || correction.category !== category)
        throw semanticRubricError('SEMANTIC_RUBRIC_CORRECTION_INVALID', 'Semantic rubric referenced an invalid correction ID');
      const quotedText = assertQuote(transcript, ev?.quotedText || correction.quotedText);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      const suggestion = clean(ev?.suggestion, MAX_SUGGESTION);
      if (!explanation || !suggestion) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric improvement evidence is incomplete');
      const key = `${category}:improve:${correctionId}:${quotedText}`;
      if (!seenEvidence.has(key)) { seenEvidence.add(key); improvementEvidence.push({ correctionId, quotedText, explanation, suggestion }); }
    }
    validated[category] = { score: clampedScore, maxScore: 20, comment, issueCount: (corrections || []).filter((c) => c.category === category).length,
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
  const completion = await (dependencies.runCompletion || runSemanticCompletion)({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch });
  const assessment = validateAssessment(parseJson(completion.content), { sourceHash: input.sourceHash,
    transcript: input.transcript, corrections: input.corrections, contextStatus: request.contextStatus });
  return { ...assessment, provider: completion.provider, model: completion.model, usage: completion.usage,
    metrics: { ...completion.metrics, semanticRubricAssessmentMs: Date.now() - startedAt,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { PROMPT_VERSION, SCHEMA_VERSION, SEMANTIC_CATEGORIES, buildRequest, parseJson, validateAssessment, assess };
