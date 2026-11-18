'use strict';
// OPT-IN speaking-assessment trial against the REAL assessment model (OpenRouter), on the synthetic benchmark transcripts
// (tests/fixtures/audio/speakingBenchmark.cjs). For a person to run by hand with a DEV key. It never runs in tests or in the app:
//   - it does nothing unless run directly (node scripts/speakingAssessmentTrial.js) AND SPEAKING_TRIAL=call-openrouter is set;
//   - it refuses when NODE_ENV is test or production;
//   - it uses no database, stores nothing, and never prints a key, the prompt or a provider error text.
// Prints per transcript: outcome, overall score, chosen levels, input/output tokens and the cost OpenRouter reports, then the totals.
//   SPEAKING_TRIAL=call-openrouter node scripts/speakingAssessmentTrial.js [--case <part of a case name>] [--max <n>]
// Uses OPENROUTER_API_KEY and ASSESSMENT_AI_MODEL from the environment (or backend/.env when run directly).
const SWITCH = 'call-openrouter';

function refuse(message) { console.error(`speakingAssessmentTrial: ${message}`); process.exitCode = 1; }

async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.SPEAKING_TRIAL !== SWITCH) return refuse(`refused: set SPEAKING_TRIAL=${SWITCH} to call the real model (costs money).`);
  if (['test', 'production'].includes(String(env.NODE_ENV || '').toLowerCase())) return refuse('refused: not in test or production.');
  const gateway = require('../src/services/aiGateway.service');
  const prompt = require('../src/services/audio/speakingAssessmentPrompt');
  const assessment = require('../src/services/audio/speakingAssessment.service');
  const { resolveSpeakingRubric } = require('../src/services/audio/speakingRubric');
  const { calculateCustomRubricScore } = require('../src/services/assignmentRubric.service');
  const { fluencyFor } = require('../tests/helpers/speakingAssessmentFixtures');
  const cases = require('../tests/fixtures/audio/speakingBenchmark.cjs');
  let config;
  try { config = gateway.getAssessmentAIConfig(env); } catch { return refuse('the assessment model is not configured (OPENROUTER_API_KEY / ASSESSMENT_AI_MODEL).'); }
  const pick = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
  const max = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : Infinity;
  const seen = new Set();
  const selected = cases.filter(c => (!pick || c.name.includes(pick)) && !seen.has(c.text) && seen.add(c.text)).slice(0, max);
  const rubric = (await resolveSpeakingRubric({ speaking: null })).rubric;
  const assignment = { title: 'Describe your town', instructions: 'Speak for one to three minutes about the town where you live: what it is like, what people do there, and what you would change.' };
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  console.log(`model ${config.chain[0].model}; prompt ${prompt.PROMPT_VERSION}; ${selected.length} transcript(s)`);
  for (const item of selected) {
    const words = assessment.countWords(item.text);
    if (words < assessment.minWords(env)) { console.log(`- ${item.name}: not enough speech (${words} words), no call`); continue; }
    if (assessment.nonLatinShare(item.text) > 0.3) { console.log(`- ${item.name}: mostly another script, no call`); continue; }
    const input = prompt.buildInput({ assignment, rubric, assessedText: item.text, fluency: fluencyFor(item.text, item.fluency || {}), durationSeconds: item.seconds || 60, wordCount: words });
    try {
      const result = await gateway.generate({ feature: prompt.FEATURE, config, env, messages: prompt.messagesFor(input), maxOutputTokens: 3000, temperature: 0,
        responseFormat: 'json', responseSchema: prompt.responseSchema(rubric), schemaName: prompt.FEATURE, metadata: { purpose: 'speaking_trial' },
        validate: raw => prompt.validateOutput(raw, { rubric, input }) });
      const usage = result.usage || {};
      totals.calls++; totals.inputTokens += usage.prompt_tokens || 0; totals.outputTokens += usage.completion_tokens || 0; totals.costUsd += typeof usage.cost === 'number' ? usage.cost : 0;
      const value = result.value;
      const score = value.assessable ? calculateCustomRubricScore(rubric, value.criteria).overallScore : null;
      console.log(`- ${item.name}: ${value.assessable ? `score ${score}` : `not assessable (${value.reason})`}; levels ${value.assessable ? value.criteria.map(c => c.levelTitle).join('/') : '-'}; `
        + `corrections ${value.assessable ? value.corrections.length : 0} (+${value.droppedCorrections || 0} dropped); tokens ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out; `
        + `cost ${typeof usage.cost === 'number' ? `$${usage.cost.toFixed(5)}` : 'not reported'}`);
    } catch (error) {
      totals.calls++;
      console.log(`- ${item.name}: FAILED ${String(error?.finalFailureCode || error?.code || 'ERROR').replace(/[^A-Z0-9_]/gi, '')}`);
    }
  }
  console.log(`total: ${totals.calls} call(s), ${totals.inputTokens} input and ${totals.outputTokens} output tokens, $${totals.costUsd.toFixed(5)} reported`);
  if (totals.calls) console.log(`average per assessed transcript: $${(totals.costUsd / totals.calls).toFixed(5)}`);
}

if (require.main === module) {
  if (process.env.SPEAKING_TRIAL === SWITCH) require('dotenv').config();
  main().catch(error => refuse(`failed: ${String(error?.name || 'Error')}`));
}
module.exports = { main, SWITCH };
