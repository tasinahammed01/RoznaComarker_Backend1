'use strict';

require('dotenv').config();
const fs = require('fs');
const aiGeneration = require('../src/services/aiGeneration.service');
const { buildMessages, validateAiResponse } = require('../src/services/adaptivePractice.service');

const MODELS = (process.env.QUALIFICATION_MODELS || process.env.ADAPTIVE_PRACTICE_MODEL || 'openai/gpt-oss-120b').split(',').map((value) => value.trim()).filter(Boolean);
const ITERATIONS = Math.max(1, Number(process.env.QUALIFICATION_ITERATIONS || 2));
const prices = {
  'openai/gpt-oss-120b': [0.036, 0.18],
  'openai/gpt-4.1-mini': [0.40, 1.60],
  'google/gemini-2.5-flash': [0.30, 2.50],
  'google/gemini-2.5-flash-lite': [0.10, 0.40],
  'anthropic/claude-haiku-4.5': [1.00, 5.00]
};
const skillCatalog = [
  ['CONTENT', 'Task Achievement'], ['ORGANIZATION', 'Coherence & Flow'], ['VOCABULARY', 'Lexical Resource'],
  ['GRAMMAR', 'Grammar'], ['MECHANICS', 'Mechanics']
].map(([id, category]) => ({ id, category, percentage: 45, status: 'priority' }));
const short = 'Students learns quickly when teachers gives clear examples.';
const page1 = 'Artificial intelligence supports learners with timely examples and personalized explanations. Students still need clear goals, accurate evidence, and feedback from their teachers.';
const page2 = 'Responsible classroom use also requires privacy safeguards, careful review, and explanations of how automated suggestions should be evaluated before students accept them.';
const imperfect = 'Artificia1 intelligence supp0rts lerners. Students need cleer goals, evidnce & teacher feed back. Responsib1e use reqires privacy safe guards.';
const cases = [
  { name: 'one-short', count: 1, transcript: short },
  { name: 'one-two-page', count: 1, transcript: `${page1}\n\n${page2}` },
  { name: 'one-imperfect-ocr', count: 1, transcript: imperfect },
  { name: 'three-two-page', count: 3, transcript: `${page1}\n\n${page2}` },
  { name: 'five-two-page', count: 5, transcript: `${page1}\n\n${page2}` }
];

function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null; }
function jsonSchemaValid(raw, expected) {
  try {
    const parsed = JSON.parse(raw); return Boolean(parsed && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.activities) && parsed.activities.length === expected);
  } catch { return false; }
}
function quality(activities) {
  if (!activities?.length) return null;
  return {
    averageTaskCharacters: Math.round(activities.reduce((sum, item) => sum + item.task.length, 0) / activities.length),
    averageModelAnswerCharacters: Math.round(activities.reduce((sum, item) => sum + item.modelAnswer.length, 0) / activities.length),
    averageChecklistItems: Number((activities.reduce((sum, item) => sum + item.checklist.length, 0) / activities.length).toFixed(2))
  };
}

async function run(model, fixture, iteration) {
  const source = { weakSkills: skillCatalog.slice(0, fixture.count), transcript: fixture.transcript, assignment: { title: 'Responsible AI in education', instructions: 'Explain benefits and risks using clear evidence.' } };
  const messages = buildMessages(source); let usage = null; let retries = 0; let retryDelayMs = 0; const started = Date.now(); let raw = '';
  try {
    raw = await aiGeneration.generateChatCompletion(messages, { model, temperature: 0.2, max_tokens: 4000, response_format: { type: 'json_object' },
      onRetry: ({ delayMs }) => { retries += 1; retryDelayMs += Number(delayMs || 0); }, onResponse: (metadata) => { usage = metadata?.usage || null; } });
    const schemaPass = jsonSchemaValid(raw, fixture.count); const activities = validateAiResponse(raw, source.weakSkills, source.transcript);
    return { model, case: fixture.name, iteration, pass: true, schemaPass, groundedPass: true, latencyMs: Date.now() - started,
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, retries, retryDelayMs, quality: quality(activities) };
  } catch (error) {
    return { model, case: fixture.name, iteration, pass: false, schemaPass: jsonSchemaValid(raw, fixture.count), groundedPass: error?.code !== 'UNGROUNDED_EVIDENCE',
      failureCode: error?.code || 'PROVIDER_ERROR', failureReason: error?.message || 'Provider request failed', latencyMs: Date.now() - started,
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, retries, retryDelayMs, responseCharacters: raw.length };
  }
}

function summarize(model, rows) {
  const latencies = rows.map((row) => row.latencyMs); const input = rows.reduce((sum, row) => sum + Number(row.inputTokens || 0), 0); const output = rows.reduce((sum, row) => sum + Number(row.outputTokens || 0), 0);
  const [inputPrice, outputPrice] = prices[model] || [0, 0];
  return { model, requests: rows.length, validationPassRate: rows.filter((row) => row.pass).length / rows.length,
    jsonSchemaPassRate: rows.filter((row) => row.schemaPass).length / rows.length, groundedEvidencePassRate: rows.filter((row) => row.groundedPass).length / rows.length,
    minimumMs: Math.min(...latencies), medianMs: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maximumMs: Math.max(...latencies),
    inputTokens: input, outputTokens: output, estimatedCostUsd: Number(((input * inputPrice + output * outputPrice) / 1e6).toFixed(6)),
    retryRate: rows.filter((row) => row.retries > 0).length / rows.length,
    failures: rows.filter((row) => !row.pass).map((row) => ({ case: row.case, iteration: row.iteration, code: row.failureCode, reason: row.failureReason, responseCharacters: row.responseCharacters })),
    quality: rows.filter((row) => row.quality).map((row) => ({ case: row.case, ...row.quality })) };
}

(async () => {
  const rows = [];
  for (const model of MODELS) for (const fixture of cases) for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    const row = await run(model, fixture, iteration); rows.push(row); process.stderr.write(`${model} ${fixture.name} ${iteration}: ${row.pass ? 'PASS' : row.failureCode} ${row.latencyMs}ms\n`);
  }
  const report = JSON.stringify({ generatedAt: new Date().toISOString(), iterations: ITERATIONS, cases: cases.map(({ name, count }) => ({ name, activities: count })), summaries: MODELS.map((model) => summarize(model, rows.filter((row) => row.model === model))), rows }, null, 2);
  if (process.env.QUALIFICATION_OUTPUT) fs.writeFileSync(process.env.QUALIFICATION_OUTPUT, `${report}\n`, 'utf8');
  process.stdout.write(`${report}\n`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
