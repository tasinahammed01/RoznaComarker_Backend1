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
    'Assess only the explicitly named CONTENT, ORGANIZATION, and VOCABULARY properties. Do not reorder, rename, alias, or add categories. Return strict JSON only with no Markdown or explanatory prose. Repeat sourceHash exactly. Every score and maxScore must be a JSON number, never a string, fraction, percentage, label, or explanatory value. CONTENT.score, ORGANIZATION.score, and VOCABULARY.score must each be between 0 and 20 inclusive, and each maxScore must be exactly 20. Do not score Grammar, Mechanics, Presentation, or overall; the backend calculates those values. Do not invent issue counts. Every quote must be copied exactly from the transcript. Improvement evidence may reference only supplied correction IDs from the same category. If detailed instructions are unavailable but a title exists, Content must state it was evaluated against the assignment title because detailed instructions were unavailable. If neither title nor instructions exist, make Content provisional and explain that task achievement cannot be confidently finalized.',
    `transcript=${input.transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict evidence-grounded writing rubric assessor. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const length = JSON.stringify(messages).length;
  return { messages, promptCharacters: length, promptInputTokenEstimate: Math.ceil(length / 4), contextStatus };
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
      const correctionId = String(ev?.correctionId || '').trim();
      const correction = correctionMap.get(correctionId);
      if (!correction || correction.category !== category)
        throw semanticRubricError('SEMANTIC_RUBRIC_CORRECTION_INVALID',
          'Semantic rubric referenced an invalid correction ID', 'evidence_validation',
          `categories.${category}.improvementEvidence.correctionId`);
      const quotedText = assertQuote(transcript, ev?.quotedText || correction.quotedText,
        `categories.${category}.improvementEvidence.quotedText`);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      const suggestion = clean(ev?.suggestion, MAX_SUGGESTION);
      if (!explanation || !suggestion) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
        'Semantic rubric improvement evidence is incomplete', 'schema_validation',
        `categories.${category}.improvementEvidence`);
      const key = `${category}:improve:${correctionId}:${quotedText}`;
      if (!seenEvidence.has(key)) { seenEvidence.add(key); improvementEvidence.push({ correctionId, quotedText, explanation, suggestion }); }
    }
    validated[category] = { score, maxScore: 20, comment, issueCount: (corrections || []).filter((c) => c.category === category).length,
      strengthEvidence, improvementEvidence };
  }
  return { sourceHash, categories: validated, status: contextStatus === 'none' ? 'partial' : 'completed' };
}

const REPAIRABLE_VALIDATION_CODES = new Set([
  'SEMANTIC_RUBRIC_SCORE_INVALID',
  'SEMANTIC_RUBRIC_SCHEMA_INVALID'
]);

function buildRepairMessages(originalMessages, validationIssues = []) {
  const issues = (Array.isArray(validationIssues) ? validationIssues : []).map((issue) => ({
    path: String(issue?.path || ''),
    code: String(issue?.code || ''),
    ...(issue?.expectedType ? { expectedType: issue.expectedType } : {}),
    ...(Number.isFinite(issue?.expectedMinimum) ? { expectedMinimum: issue.expectedMinimum } : {}),
    ...(Number.isFinite(issue?.expectedMaximum) ? { expectedMaximum: issue.expectedMaximum } : {})
  }));
  return [
    ...originalMessages,
    {
      role: 'user',
      content: `The prior JSON failed authoritative validation: ${JSON.stringify(issues)}. Return one complete corrected JSON object for the original rubric context. Preserve the exact named CONTENT, ORGANIZATION, and VOCABULARY structure and sourceHash. Scores/maxScore must be JSON numbers; each score must be 0 through 20 and maxScore exactly 20. Return no Markdown, total, aliases, or explanatory prose outside the JSON.`
    }
  ];
}

function attachCompletionMetadata(error, completion, startedAt) {
  error.provider = completion.provider;
  error.model = completion.model;
  error.httpStatus = completion.httpStatus;
  error.finishReason = completion.finishReason;
  error.candidateCount = completion.candidateCount;
  error.hasContent = completion.hasContent;
  error.hasText = completion.hasText;
  error.contentType = completion.contentType;
  error.responseTextLength = completion.responseTextLength;
  error.requestId = completion.requestId;
  error.durationMs = Date.now() - startedAt;
  error.usage = completion.usage || null;
  error.markdownFenceDetected = error.markdownFenceDetected === true
    || /^```json\b/iu.test(String(completion.content || '').trim());
  return error;
}

async function assess(input, dependencies = {}) {
  const config = dependencies.config || getSemanticAIConfig();
  if (!getSemanticAIConfigStatus(config, dependencies.env || process.env).configured) {
    throw semanticRubricError('AI_PROVIDER_NOT_CONFIGURED', 'Semantic AI provider configuration is incomplete.');
  }
  const request = buildRequest(input);
  const startedAt = Date.now();
  const runCompletion = dependencies.runCompletion || runSemanticCompletion;
  const completion = await runCompletion({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch });
  let assessment;
  let finalCompletion = completion;
  let repairAttempted = false;
  try {
    assessment = validateAssessment(parseJson(completion.content), { sourceHash: input.sourceHash,
      transcript: input.transcript, corrections: input.corrections, contextStatus: request.contextStatus });
  } catch (error) {
    attachCompletionMetadata(error, completion, startedAt);
    if (!REPAIRABLE_VALIDATION_CODES.has(error?.code)) throw error;
    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = Number(config.totalBudgetMs) - elapsedMs;
    if (remainingBudgetMs < Number(config.minAttemptBudgetMs)) throw error;
    repairAttempted = true;
    const repairConfig = {
      ...config,
      maxRetries: 0,
      totalBudgetMs: remainingBudgetMs,
      attemptTimeoutMs: Math.min(Number(config.attemptTimeoutMs), remainingBudgetMs)
    };
    try {
      finalCompletion = await runCompletion({
        messages: buildRepairMessages(request.messages, error.validationIssues),
        config: repairConfig,
        env: dependencies.env || process.env,
        fetchImpl: dependencies.fetchImpl || global.fetch
      });
      assessment = validateAssessment(parseJson(finalCompletion.content), {
        sourceHash: input.sourceHash,
        transcript: input.transcript,
        corrections: input.corrections,
        contextStatus: request.contextStatus
      });
    } catch (repairError) {
      repairError.repairAttempted = true;
      if (finalCompletion !== completion) attachCompletionMetadata(repairError, finalCompletion, startedAt);
      throw repairError;
    }
  }
  const attempts = [
    ...(Array.isArray(completion.metrics?.attempts) ? completion.metrics.attempts : []),
    ...(repairAttempted && Array.isArray(finalCompletion.metrics?.attempts)
      ? finalCompletion.metrics.attempts.map((attempt) => ({ ...attempt, validationRepair: true })) : [])
  ];
  return { ...assessment, provider: finalCompletion.provider, model: finalCompletion.model, usage: finalCompletion.usage,
    metrics: { ...finalCompletion.metrics, attempts, validationRepairAttempted: repairAttempted,
      semanticRubricAssessmentMs: Date.now() - startedAt,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { PROMPT_VERSION, SCHEMA_VERSION, SEMANTIC_CATEGORIES, buildRequest, buildRepairMessages,
  parseJson, validateAssessment, assess };
