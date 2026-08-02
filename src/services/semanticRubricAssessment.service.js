'use strict';

const crypto = require('crypto');
const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');
const { promptDefinitions } = require('./writingCategoryDefinitions.service');
const { semanticRubricAssessmentSchema, MAX_RUBRIC_EVIDENCE_IDS } = require('./structuredOutputSchemas.service');

const PROMPT_VERSION = 'semantic-rubric-assessment-v5';
const SCHEMA_VERSION = 'semantic-rubric-assessment-json-v4';
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

function transcriptEvidenceCatalog(transcript = '') {
  const text = String(transcript || '');
  const spans = [];
  const boundary = /[^\n.!?]+(?:[.!?]+|(?=\n)|$)/gu;
  let match;
  while ((match = boundary.exec(text))) {
    const leading = match[0].match(/^\s*/u)?.[0].length || 0;
    const trailing = match[0].match(/\s*$/u)?.[0].length || 0;
    let start = match.index + leading;
    const end = match.index + match[0].length - trailing;
    while (start < end) {
      let chunkEnd = Math.min(end, start + 260);
      if (chunkEnd < end) {
        const whitespace = text.lastIndexOf(' ', chunkEnd);
        if (whitespace > start + 40) chunkEnd = whitespace;
      }
      const quotedText = text.slice(start, chunkEnd);
      const digest = crypto.createHash('sha256').update(`${start}:${chunkEnd}:${quotedText}`).digest('hex').slice(0, 12);
      spans.push(Object.freeze({ evidenceId: `ev-${String(spans.length).padStart(4, '0')}-${digest}`,
        quotedText, startChar: start, endChar: chunkEnd, finalQuarter: chunkEnd > Math.floor(text.length * 0.75) }));
      start = chunkEnd;
      while (start < end && /\s/u.test(text[start])) start += 1;
    }
  }
  if (!spans.length && text.trim()) {
    const startChar = text.search(/\S/u); const endChar = text.trimEnd().length;
    const quotedText = text.slice(startChar, endChar);
    const digest = crypto.createHash('sha256').update(`${startChar}:${endChar}:${quotedText}`).digest('hex').slice(0, 12);
    spans.push(Object.freeze({ evidenceId: `ev-0000-${digest}`, quotedText, startChar, endChar,
      finalQuarter: startChar >= Math.floor(text.length * 0.75) }));
  }
  return Object.freeze(spans.slice(0, MAX_RUBRIC_EVIDENCE_IDS));
}

const CONCLUSION_CLAIM = /\b(?:conclusion|concluding paragraph|final paragraph)\b/iu;
const MISSING_CONCLUSION_CLAIM = /\b(?:lacks?(?:\s+a)?\s+(?:clear\s+)?conclusion|conclusion\s+is\s+(?:missing|absent)|no\s+conclusion)\b/iu;
const GENERAL_ORGANIZATION_CLAIM = /\b(?:coherence|cohesion|transition|paragraph(?:ing|s)?|progression|flow|sequence|organization)\b/iu;

function conclusionClaimKind(item = {}) {
  const comment = clean(item.comment);
  const evidenceClaims = [...(Array.isArray(item.strengthEvidence) ? item.strengthEvidence : []),
    ...(Array.isArray(item.improvementEvidence) ? item.improvementEvidence : [])]
    .map((evidence) => clean(evidence?.explanation)).filter((value) => CONCLUSION_CLAIM.test(value));
  const specificComment = CONCLUSION_CLAIM.test(comment) && !GENERAL_ORGANIZATION_CLAIM.test(comment) ? comment : '';
  const claims = [specificComment, ...evidenceClaims].filter(Boolean);
  if (!claims.length) return null;
  return claims.some((claim) => MISSING_CONCLUSION_CLAIM.test(claim)) ? 'missing' : 'specific';
}

function normalizeStatisticsComment({ category, comment, issueCount, score }) {
  const numericClaim = comment.match(/\b(\d+)\s+(?:(?:validated|canonical|detected|localized)\s+)?(?:\w+\s+)?(?:corrections?|errors?|issues?)\b/iu);
  const zeroFrequencyClaim = issueCount === 0
    && /\b(?:frequent|many|several|numerous)\s+(?:\w+\s+)?(?:corrections?|errors?|issues?)\b/iu.test(comment);
  if ((!numericClaim || Number(numericClaim[1]) === issueCount) && !zeroFrequencyClaim) {
    return { comment, diagnostic: null };
  }
  const label = category.charAt(0) + category.slice(1).toLowerCase();
  const normalized = issueCount === 0
    ? `This category was assessed holistically${score < 20 ? ' from the submitted writing' : ''}. No validated canonical ${label.toLowerCase()} corrections were recorded.`
    : `This category was assessed using ${issueCount} validated canonical ${label.toLowerCase()} correction${issueCount === 1 ? '' : 's'}.`;
  return { comment: normalized, diagnostic: Object.freeze({ category, commentNormalized: true,
    commentNormalizationReason: issueCount === 0 ? 'ZERO_CANONICAL_COUNT_CONTRADICTION'
      : 'NONZERO_CANONICAL_COUNT_CONTRADICTION', canonicalCount: issueCount }) };
}

function buildRequest(input) {
  const assignment = compactAssignment(input.assignment || {});
  const contextStatus = assignment.instructions ? 'instructions' : assignment.title ? 'title_only' : 'none';
  const catalog = correctionCatalog(input.corrections);
  const evidenceCatalog = transcriptEvidenceCatalog(input.transcript);
  const allowedCorrectionIds = allowedCorrectionIdsByCategory(catalog);
  const response = { sourceHash: input.sourceHash, categories: Object.fromEntries(SEMANTIC_CATEGORIES.map((category) => {
    const hasTranscriptEvidence = evidenceCatalog.length > 0;
    const hasCorrectionEvidence = allowedCorrectionIds[category].length > 0;
    return [category, {
      score: hasTranscriptEvidence || hasCorrectionEvidence ? 0 : 20,
      maxScore: 20,
      comment: 'Concise category judgment',
      strengthEvidence: hasTranscriptEvidence
        ? [{ evidenceId: 'exact ID copied from evidenceCatalog', explanation: 'why this is positive evidence' }] : [],
      improvementEvidence: hasCorrectionEvidence
        ? [{ evidenceType: 'correction', correctionId: 'exact ID copied from correctionCatalog for this category',
          evidenceId: null, explanation: 'what is weak', suggestion: 'specific improvement' }]
        : hasTranscriptEvidence ? [{ evidenceType: 'transcript', correctionId: null,
          evidenceId: 'exact ID copied from evidenceCatalog', explanation: 'transcript-grounded holistic weakness',
          suggestion: 'specific improvement' }] : []
    }];
  })) };
  const prompt = [
    `schema=${SCHEMA_VERSION};prompt=${PROMPT_VERSION}`,
    `sourceHash=${input.sourceHash}`,
    `contextStatus=${contextStatus}`,
    `transcriptComplete=${input.transcriptComplete === true}`,
    `assignment=${JSON.stringify(assignment)}`,
    `statistics=${JSON.stringify(input.statistics || {})}`,
    `pageManifest=${JSON.stringify(compactPageManifest(input.pageManifest || []))}`,
    `evidenceCatalog=${JSON.stringify(evidenceCatalog)}`,
    `correctionCatalog=${JSON.stringify(catalog)}`,
    `allowedCorrectionIdsByCategory=${JSON.stringify(allowedCorrectionIds)}`,
    `response=${JSON.stringify(response)}`,
    `categoryDefinitions=${promptDefinitions()}`,
    'Assess only CONTENT, ORGANIZATION, and VOCABULARY. Do not reorder, rename, alias, or add categories. Return strict JSON only. Repeat sourceHash exactly. Scores must be numbers from 0 to 20 and maxScore exactly 20. Do not score Grammar, Mechanics, Presentation, or overall. Do not invent issue counts. Never return quotedText or occurrence. For transcript evidence, copy only an evidenceId from evidenceCatalog; the backend owns and resolves its exact text and offset. For correction evidence, copy only a correctionId from the same category correctionCatalog and set evidenceId=null. With no allowed correction ID, use transcript evidence with correctionId=null. If the evidence catalog and allowed correction list are both empty, return empty evidence arrays and do not make an unsupported deduction. Make a missing, weak, or successful conclusion claim only when it is a distinct conclusion-specific observation supported by final-quarter transcript evidence or an allowed CONC correction. Do not turn a general Organization observation about coherence, paragraphing, transitions, or progression into a conclusion claim merely by mentioning conclusion quality in the broader comment. Never claim a conclusion is missing when transcriptComplete=false. Never treat an introduction or middle passage as a conclusion. If the ending is incomplete, do not call it complete. Never claim page or paragraph order beyond canonical order. A zero correction count may still receive a holistic deduction, but the comment must say holistic and must not say issues were detected. If detailed instructions are unavailable, follow existing title-only/provisional rules.'
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a strict evidence-grounded writing rubric assessor. Output one JSON object only.' },
    { role: 'user', content: prompt }
  ];
  const length = JSON.stringify(messages).length;
  return { messages, promptCharacters: length, promptInputTokenEstimate: Math.ceil(length / 4), contextStatus,
    correctionCatalog: catalog, allowedCorrectionIds, evidenceCatalog };
}

function semanticRubricError(code, message, validationStage = 'schema_validation', path = null, details = null) {
  const error = new Error(message);
  error.code = code;
  error.validationStage = validationStage;
  error.validationIssues = path ? [{ path, code, ...(details || {}) }] : [];
  error.jsonPath = path ? `$.${path}` : null;
  if (details) Object.assign(error, details);
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

function quoteLocations(transcript, quote) {
  const locations = [];
  for (let at = transcript.indexOf(quote); at >= 0; at = transcript.indexOf(quote, at + 1)) locations.push(at);
  return locations;
}

function assertQuote(transcript, quote, occurrence, path) {
  const value = String(quote || '').trim();
  const index = Number(occurrence);
  const locations = value ? quoteLocations(transcript, value) : [];
  if (!value || !Number.isInteger(index) || index < 0 || locations[index] == null) {
    throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED',
      'Semantic rubric evidence quote is not in the transcript', 'evidence_validation', path);
  }
  return value;
}

function validateAssessment(parsed, { sourceHash, transcript, corrections = [], contextStatus = 'none', evidenceCatalog = null,
  transcriptComplete = true }) {
  if (!parsed || typeof parsed !== 'object' || parsed.sourceHash !== sourceHash)
    throw semanticRubricError('SEMANTIC_RUBRIC_SOURCE_MISMATCH', 'Semantic rubric assessment source hash mismatch',
      'source_hash', 'sourceHash');
  const categories = parsed.categories || {};
  const returned = Object.keys(categories);
  if (!SEMANTIC_CATEGORIES.every((category) => returned.includes(category)) || returned.some((category) => !SEMANTIC_CATEGORIES.includes(category)))
    throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID', 'Semantic rubric assessment returned invalid categories',
      'schema_validation', 'categories');
  const correctionMap = new Map((corrections || []).map((item) => [String(item.id), item]));
  const transcriptCatalog = evidenceCatalog || transcriptEvidenceCatalog(transcript);
  const evidenceMap = new Map(transcriptCatalog.map((item) => [item.evidenceId, item]));
  const validated = {};
  const commentNormalizations = [];
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
      const evidence = evidenceMap.get(String(ev?.evidenceId || ''));
      if (!evidence) throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID',
        'Semantic rubric referenced an unknown transcript evidence ID', 'evidence_validation',
        `categories.${category}.strengthEvidence.evidenceId`);
      const quotedText = evidence.quotedText; const occurrence = quoteLocations(transcript, quotedText).indexOf(evidence.startChar);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      if (!explanation) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
        'Semantic rubric strength explanation is missing', 'schema_validation',
        `categories.${category}.strengthEvidence.explanation`);
      const key = `${category}:strength:${quotedText}:${occurrence}:${explanation}`;
      if (!seenEvidence.has(key)) { seenEvidence.add(key); strengthEvidence.push({ evidenceId: evidence.evidenceId,
        quotedText, occurrence, startChar: evidence.startChar, endChar: evidence.endChar,
        finalQuarter: evidence.finalQuarter, explanation }); }
    }
    const improvementEvidence = [];
    for (const ev of Array.isArray(item.improvementEvidence) ? item.improvementEvidence : []) {
      const rawCorrectionId = ev?.correctionId;
      const correctionId = typeof rawCorrectionId === 'string' ? rawCorrectionId.trim() : '';
      const evidenceType = ev?.evidenceType || (correctionId ? 'correction' : null);
      let correction = null;
      let transcriptEvidence = null;
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
        transcriptEvidence = evidenceMap.get(String(ev?.evidenceId || ''));
        if (!transcriptEvidence) throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID',
          'Semantic rubric referenced an unknown transcript evidence ID', 'evidence_validation',
          `categories.${category}.improvementEvidence.evidenceId`);
      } else {
        throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
          'Semantic rubric improvement evidence type is invalid', 'schema_validation',
          `categories.${category}.improvementEvidence.evidenceType`);
      }
      if (correction && ev?.evidenceId != null) throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_ID_INVALID',
        'Correction evidence must not contain a transcript evidence ID', 'evidence_validation',
        `categories.${category}.improvementEvidence.evidenceId`);
      const quotedText = correction ? String(correction.quotedText) : transcriptEvidence.quotedText;
      const located = correction ? quoteLocations(transcript, quotedText) : [];
      const occurrence = correction ? Math.max(0, located.indexOf(Number(correction.startChar)))
        : quoteLocations(transcript, quotedText).indexOf(transcriptEvidence.startChar);
      const startChar = correction ? (Number.isInteger(Number(correction.startChar)) ? Number(correction.startChar) : located[occurrence])
        : transcriptEvidence.startChar;
      if (!quotedText || startChar == null || startChar < 0) throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_UNGROUNDED',
        'Resolved rubric evidence is not grounded in the transcript', 'evidence_validation',
        `categories.${category}.improvementEvidence`);
      const explanation = clean(ev?.explanation, MAX_EXPLANATION);
      const suggestion = clean(ev?.suggestion, MAX_SUGGESTION);
      if (!explanation || !suggestion) throw semanticRubricError('SEMANTIC_RUBRIC_SCHEMA_INVALID',
        'Semantic rubric improvement evidence is incomplete', 'schema_validation',
        `categories.${category}.improvementEvidence`);
      const key = `${category}:improve:${evidenceType}:${correctionId}:${quotedText}:${occurrence}`;
      if (!seenEvidence.has(key)) {
        seenEvidence.add(key);
        improvementEvidence.push({
          evidenceType,
          correctionId: evidenceType === 'correction' ? correctionId : null,
          evidenceId: evidenceType === 'transcript' ? transcriptEvidence.evidenceId : null,
          quotedText, occurrence, startChar, endChar: startChar + quotedText.length,
          finalQuarter: Boolean(transcriptEvidence?.finalQuarter),
          explanation,
          suggestion
        });
      }
    }
    const issueCount = (corrections || []).filter((c) => c.category === category).length;
    const normalizedComment = normalizeStatisticsComment({ category, comment, issueCount, score });
    comment = normalizedComment.comment;
    if (normalizedComment.diagnostic) commentNormalizations.push(normalizedComment.diagnostic);
    if (score < 20 && !improvementEvidence.length)
      throw semanticRubricError('SEMANTIC_RUBRIC_EVIDENCE_REQUIRED',
        'A rubric deduction requires grounded improvement evidence',
        'consistency_validation', `categories.${category}.improvementEvidence`);
    if (score < 20 && issueCount === 0 && !/\bholistic(?:ally)?\b/iu.test(comment))
      comment = `${comment} This is a holistic observation, not a counted correction.`;
    const conclusionClaim = category === 'ORGANIZATION' ? conclusionClaimKind(item) : null;
    if (conclusionClaim) {
      const allEvidence = [...strengthEvidence, ...improvementEvidence];
      const hasFinalTranscriptEvidence = allEvidence.some((ev) => ev.evidenceId && ev.finalQuarter);
      const hasValidatedConcCorrection = improvementEvidence.some((ev) => ev.correctionId
        && correctionMap.get(ev.correctionId)?.category === 'ORGANIZATION'
        && correctionMap.get(ev.correctionId)?.symbol === 'CONC');
      if (conclusionClaim === 'missing' && transcriptComplete !== true)
        throw semanticRubricError('SEMANTIC_RUBRIC_ABSENCE_EVIDENCE_INVALID',
          'A missing-conclusion claim requires a complete authoritative transcript',
          'consistency_validation', `categories.${category}.improvementEvidence`);
      if (!hasFinalTranscriptEvidence && !hasValidatedConcCorrection)
        throw semanticRubricError('SEMANTIC_RUBRIC_CONCLUSION_EVIDENCE_INVALID',
          'A conclusion claim must be anchored to the final passage',
          'consistency_validation', `categories.${category}`);
    }
    validated[category] = { score, maxScore: 20, comment, issueCount,
      strengthEvidence, improvementEvidence };
  }
  return { sourceHash, categories: validated, status: contextStatus === 'none' ? 'partial' : 'completed',
    diagnostics: Object.freeze({ commentNormalizations: Object.freeze(commentNormalizations) }) };
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
    corrections: input.corrections, contextStatus: request.contextStatus, evidenceCatalog: request.evidenceCatalog,
    transcriptComplete: input.transcriptComplete === true
  });
  const completion = await runCompletion({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
    validate, feature: 'semantic_rubric_assessment',
    responseSchema: semanticRubricAssessmentSchema(input.sourceHash, {
      transcriptEvidenceIds: request.evidenceCatalog.map((item) => item.evidenceId),
      correctionIds: request.allowedCorrectionIds
    }),
    schemaName: 'semantic_rubric_assessment' });
  const assessment = completion.value || validate(completion.content);
  const attempts = Array.isArray(completion.metrics?.attempts) ? completion.metrics.attempts : [];
  return { ...assessment, provider: completion.provider, model: completion.model, usage: completion.usage,
    metrics: { ...completion.metrics, attempts, validationRepairAttempted: false,
      semanticRubricAssessmentMs: Date.now() - startedAt,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { PROMPT_VERSION, SCHEMA_VERSION, SEMANTIC_CATEGORIES, correctionCatalog,
  allowedCorrectionIdsByCategory, transcriptEvidenceCatalog, buildRequest, parseJson, normalizeStatisticsComment,
  validateAssessment, assess, conclusionClaimKind };
