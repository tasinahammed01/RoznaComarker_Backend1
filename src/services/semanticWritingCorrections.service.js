'use strict';

const crypto = require('crypto');
const { defaultLegend } = require('./writingCorrections.service');
const { getSemanticAIConfig, getSemanticAIConfigStatus, runSemanticCompletion } = require('./semanticAIClient.service');

const SEMANTIC_PROMPT_VERSION = 'semantic-compact-v2';
const SEMANTIC_SCHEMA_VERSION = 'semantic-corrections-v1';
const SEMANTIC_CATEGORIES = new Set(['CONTENT', 'ORGANIZATION', 'VOCABULARY']);
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
  return corrections.map((item) => ({ symbol: item?.symbol, startChar: Number(item?.startChar), endChar: Number(item?.endChar) }))
    .filter((item) => item.symbol && Number.isFinite(item.startChar) && Number.isFinite(item.endChar) && item.endChar > item.startChar);
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
  const responseShape = { transcriptHash: '<exact supplied hash>', corrections: [{ category: 'CONTENT', symbol: 'DEV',
    quotedText: '<exact transcript quotation>', occurrence: 0, message: '<concise evidence>', suggestedText: '<concise revision>', confidence: 0.86 }] };
  const prompt = [
    `schema=${SEMANTIC_SCHEMA_VERSION};prompt=${SEMANTIC_PROMPT_VERSION}`,
    `transcriptHash=${transcriptHash}`,
    `pages=${JSON.stringify(pages)}`,
    `assignment=${JSON.stringify(context)}`,
    `legend=${JSON.stringify(legend)}`,
    `languageToolExclusions=${JSON.stringify(exclusions)}`,
    `response=${JSON.stringify(responseShape)}`,
    'Analyze only Content, Organization, and Vocabulary. Return strict JSON only. Copy every quotedText exactly from the transcript and repeat the supplied transcriptHash exactly. Use only listed category/symbol pairs. Keep messages and suggestions concise. Use occurrence for repeated quotations. Do not invent text, correct OCR, add praise, report grammar/mechanics, duplicate exclusions, or manufacture issues. Subject-verb agreement is not Content. A strong essay may return zero corrections.',
    `transcript=${transcript}`
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are a precise evidence-based academic writing analyst. Output one compact JSON object only.' },
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
  const parsed = JSON.parse(text);
  if (!expectedHash || parsed?.transcriptHash !== expectedHash) throw new Error('Semantic analysis did not confirm the complete transcript hash');
  if (!Array.isArray(parsed?.corrections)) throw new Error('Semantic analysis corrections must be an array');
  return parsed.corrections.slice(0, 40);
}

function invalidSemanticResponse(message) {
  const error = new Error(message);
  error.code = 'SEMANTIC_RESPONSE_INVALID';
  return error;
}

function validateCorrections(corrections, { transcript, legend }) {
  const allowed = new Set((legend || []).flatMap((group) => (group.symbols || [])
    .map((item) => `${group.category}:${item.symbol}`)));
  for (const item of corrections) {
    if (!item || typeof item !== 'object' || !SEMANTIC_CATEGORIES.has(item.category)
      || !allowed.has(`${item.category}:${item.symbol}`) || typeof item.quotedText !== 'string' || !item.quotedText
      || typeof item.message !== 'string' || !item.message.trim() || typeof item.suggestedText !== 'string'
      || !Number.isFinite(Number(item.confidence)) || Number(item.confidence) < 0 || Number(item.confidence) > 1
      || !Number.isInteger(Number(item.occurrence)) || Number(item.occurrence) < 0) {
      throw invalidSemanticResponse('Semantic analysis returned an incomplete correction');
    }
    let offset = -1;
    for (let occurrence = 0; occurrence <= Number(item.occurrence); occurrence += 1) {
      offset = transcript.indexOf(item.quotedText, offset + 1);
      if (offset < 0) throw invalidSemanticResponse('Semantic analysis returned non-verbatim evidence');
    }
  }
  return corrections;
}

function semanticSourceKey({ correctionSourceHash, config = getSemanticAIConfig(), legendVersion = defaultLegend().version }) {
  return crypto.createHash('sha256').update(JSON.stringify({ correctionSourceHash, provider: config.provider, model: config.model,
    fallback: config.fallback, promptVersion: SEMANTIC_PROMPT_VERSION, schemaVersion: SEMANTIC_SCHEMA_VERSION, legendVersion })).digest('hex');
}

async function analyze(input, dependencies = {}) {
  const config = dependencies.config || getSemanticAIConfig();
  if (!getSemanticAIConfigStatus(config, dependencies.env || process.env).configured) {
    const error = new Error('Semantic AI provider configuration is incomplete.'); error.code = 'AI_PROVIDER_NOT_CONFIGURED'; throw error;
  }
  const buildStartedAt = Date.now();
  const request = buildSemanticRequest(input);
  const semanticRequestBuildMs = Date.now() - buildStartedAt;
  const completion = await (dependencies.runCompletion || runSemanticCompletion)({ messages: request.messages, config,
    env: dependencies.env || process.env, fetchImpl: dependencies.fetchImpl || global.fetch,
    onAttempt: input.onAttempt, onRetry: input.onRetry });
  const parseStartedAt = Date.now();
  const corrections = validateCorrections(parseJson(completion.content, input.transcriptHash), {
    transcript: input.transcript, legend: request.legend
  });
  const semanticParseMs = Date.now() - parseStartedAt;
  return { corrections, provider: completion.provider, model: completion.model,
    usage: completion.usage, sourceKey: semanticSourceKey({ correctionSourceHash: input.transcriptHash, config }),
    metrics: { ...completion.metrics, semanticRequestBuildMs, semanticParseMs,
      promptCharacters: request.promptCharacters, promptInputTokenEstimate: request.promptInputTokenEstimate } };
}

module.exports = { SEMANTIC_PROMPT_VERSION, SEMANTIC_SCHEMA_VERSION, compactAssignment, compactSemanticLegend,
  compactLanguageToolExclusions, compactPageManifest, buildSemanticRequest, buildLegacySemanticRequestForBenchmark,
  parseJson, validateCorrections, semanticSourceKey, analyze };
