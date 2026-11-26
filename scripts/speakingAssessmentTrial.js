'use strict';
// OPT-IN speaking-assessment trial against the REAL assessment model (OpenRouter), on the synthetic benchmark transcripts
// (tests/fixtures/audio/speakingBenchmark.cjs). For a person to run by hand with a DEV key. It never runs in tests or in the app:
//   - it does nothing unless run directly (node scripts/speakingAssessmentTrial.js) AND SPEAKING_TRIAL=call-openrouter is set;
//   - it refuses when NODE_ENV is test or production;
//   - it uses no database, stores nothing, and never prints a key, the prompt or a provider error text.
// Prints per transcript: outcome, overall score, chosen levels, input/output tokens and the cost OpenRouter reports, then the totals. A rejected
// reply also shows which check rejected it (for example SPEAKING_OUTPUT_NUMBER). --show-feedback also prints, per transcript, the fluency
// figures sent and the model's feedback: summary, strengths, improvements and each criterion's comment (the transcripts are synthetic).
//   SPEAKING_TRIAL=call-openrouter node scripts/speakingAssessmentTrial.js [--case <part of a case name>] [--max <n>] [--show-feedback]
// Uses OPENROUTER_API_KEY and ASSESSMENT_AI_MODEL from the environment (or backend/.env when run directly).
// Speaking Coach: --coach-check measures ONE practice check per synthetic transcript (default one transcript; --max <n> for more) with the
// coach's real check prompt and validation, on the default rubric's grammar criterion. It REQUIRES a cost cap and never retries a call:
//   SPEAKING_TRIAL=call-openrouter node scripts/speakingAssessmentTrial.js --coach-check --max-cost-usd <amount> [--case <name>] [--max <n>]
// It stops as soon as the cost OpenRouter reports reaches the cap (the last call can pass it by at most that call's cost).
// --coach-generate measures ONE task wording call per synthetic transcript (a grammar task and a vocabulary task, from stored-data input) the
// same way. Both flags in one run share ONE cap (the checks first, then the wording). Prints names, levels, the number of tasks worded, token
// counts and dollar amounts only; never an answer, the feedback, the task wording, the prompt or a key.
const SWITCH = 'call-openrouter';

function refuse(message) { console.error(`speakingAssessmentTrial: ${message}`); process.exitCode = 1; }

/**
 * The check that failed the last attempt, codes only (never provider text, a message or a key): the validation rule that rejected a reply (the
 * gateway's own code is then AI_OUTPUT_VALIDATION_FAILED), a key that cannot be sent, or (from the gateway's private onDiagnostic report) the
 * stage, error name and cause code of a failure before any answer.
 */
const subCode = (error, diagnostic = null) => {
  const last = error?.attempts?.at?.(-1) || {};
  const clean = value => String(value || '').replace(/[^A-Za-z0-9_]/g, '');
  if (last.validationCode) return clean(last.validationCode);
  if (last.credentialIssue) return `credential ${clean(last.credentialIssue)}`;
  if (diagnostic?.failureStage) {
    return [`stage ${clean(diagnostic.failureStage)}`, clean(diagnostic.causes?.[0]?.name), clean(diagnostic.internalCauseCode)].filter(Boolean).join(', ');
  }
  return '';
};

/** deps.fetchImpl is for tests only (a fake provider); by default the real fetch is used. */
async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  if (env.SPEAKING_TRIAL !== SWITCH) return refuse(`refused: set SPEAKING_TRIAL=${SWITCH} to call the real model (costs money).`);
  if (['test', 'production'].includes(String(env.NODE_ENV || '').toLowerCase())) return refuse('refused: not in test or production.');
  const gateway = require('../src/services/aiGateway.service');
  const prompt = require('../src/services/audio/speakingAssessmentPrompt');
  const assessment = require('../src/services/audio/speakingAssessment.service');
  const { resolveSpeakingRubric } = require('../src/services/audio/speakingRubric');
  const { calculateCustomRubricScore } = require('../src/services/assignmentRubric.service');
  const { caseRecording } = require('../tests/helpers/speakingAssessmentFixtures');
  const cases = require('../tests/fixtures/audio/speakingBenchmark.cjs');
  let config;
  try { config = gateway.getAssessmentAIConfig(env); } catch { return refuse('the assessment model is not configured (OPENROUTER_API_KEY / ASSESSMENT_AI_MODEL).'); }
  if (argv.includes('--coach-check') || argv.includes('--coach-generate')) return coachTrial(argv, env, deps, config, gateway);
  const pick = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
  const max = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : Infinity;
  const showFeedback = argv.includes('--show-feedback');
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
    const { fluency, seconds } = caseRecording(item);
    const input = prompt.buildInput({ assignment, rubric, assessedText: item.text, fluency, durationSeconds: seconds, wordCount: words });
    try {
      const result = await gateway.generate({ feature: prompt.FEATURE, config, env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), messages: prompt.messagesFor(input), maxOutputTokens: 3000, temperature: 0,
        responseFormat: 'json', responseSchema: prompt.responseSchema(rubric), schemaName: prompt.FEATURE, metadata: { purpose: 'speaking_trial' },
        validate: raw => prompt.validateOutput(raw, { rubric, input }) });
      const usage = result.usage || {};
      totals.calls++; totals.inputTokens += usage.prompt_tokens || 0; totals.outputTokens += usage.completion_tokens || 0; totals.costUsd += typeof usage.cost === 'number' ? usage.cost : 0;
      const value = result.value;
      const score = value.assessable ? calculateCustomRubricScore(rubric, value.criteria).overallScore : null;
      console.log(`- ${item.name}: ${value.assessable ? `score ${score}` : `not assessable (${value.reason})`}; levels ${value.assessable ? value.criteria.map(c => c.levelTitle).join('/') : '-'}; `
        + `corrections ${value.assessable ? value.corrections.length : 0} (+${value.droppedCorrections || 0} dropped); tokens ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out; `
        + `cost ${typeof usage.cost === 'number' ? `$${usage.cost.toFixed(5)}` : 'not reported'}`);
      if (showFeedback) {
        console.log(`    fluency sent: ${fluency.wordsPerMinute} words per minute, ${fluency.fillersPer100Words} fillers per 100 words, ${fluency.pausesOverThreshold} pauses over 1 s, `
          + `${fluency.repetitionCount} repetitions, ${fluency.spokenWords} words in ${fluency.speakingSeconds} s of speech; recording ${input.recording.durationSeconds} s`);
        if (value.assessable) {
          console.log(`    summary: ${value.summary}`);
          for (const s of value.strengths) console.log(`    strength: ${s}`);
          for (const s of value.improvements) console.log(`    improvement: ${s}`);
          for (const c of value.criteria) console.log(`    ${rubric.criteria.find(r => r.id === c.criterionId)?.title || c.criterionId} (${c.levelTitle}): ${c.comment}`);
          for (const c of value.corrections) console.log(`    correction ${c.symbol}: "${c.quotedText}" -> "${c.suggestedText}" (${c.message})`);
        }
      }
    } catch (error) {
      totals.calls++;
      const sub = subCode(error);
      console.log(`- ${item.name}: FAILED ${String(error?.finalFailureCode || error?.code || 'ERROR').replace(/[^A-Z0-9_]/gi, '')}${sub ? ` (${sub})` : ''}`);
    }
  }
  console.log(`total: ${totals.calls} call(s), ${totals.inputTokens} input and ${totals.outputTokens} output tokens, $${totals.costUsd.toFixed(5)} reported`);
  if (totals.calls) console.log(`average per assessed transcript: $${(totals.costUsd / totals.calls).toFixed(5)}`);
}

/**
 * Speaking Coach: the real cost of practice checks (--coach-check) and of task wording (--coach-generate), one call each (no retry), on
 * synthetic transcripts only. Both in one run share ONE cap: the checks first, then the wording, stopping once the reported total reaches
 * --max-cost-usd. Prints names, levels, token counts and dollar amounts only: never an answer, the feedback, the task wording or the prompt.
 */
async function coachTrial(argv, env, deps, config, gateway) {
  const capIndex = argv.indexOf('--max-cost-usd');
  const cap = capIndex >= 0 ? Number(argv[capIndex + 1]) : NaN;
  if (!(Number.isFinite(cap) && cap > 0 && cap <= 5)) {
    return refuse('refused: --coach-check and --coach-generate need --max-cost-usd <amount> (more than 0, at most 5 dollars).');
  }
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, capped: false };
  const runs = { check: { calls: 0, costUsd: 0 }, generate: { calls: 0, costUsd: 0 } };
  const noRetry = { ...config, primaryRetries: 0, fallbackRetries: 0, retriesPerModel: 0 };
  /** One call; counts it, adds the reported usage, and says whether the cap is reached. */
  const call = async (kind, name, request, describe) => {
    totals.calls++; runs[kind].calls++;
    let diagnostic = null;
    try {
      const result = await gateway.generate({ ...request, config: noRetry, env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), metadata: { purpose: 'speaking_coach_trial' },
        onDiagnostic: report => { diagnostic = report; } });
      const usage = result.usage || {};
      const cost = typeof usage.cost === 'number' ? usage.cost : 0;
      totals.inputTokens += usage.prompt_tokens || 0; totals.outputTokens += usage.completion_tokens || 0; totals.costUsd += cost; runs[kind].costUsd += cost;
      console.log(`- ${name}: ${describe(result.value)}; tokens ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out; `
        + `cost ${typeof usage.cost === 'number' ? `$${usage.cost.toFixed(5)}` : 'not reported'}`);
    } catch (error) {
      const sub = subCode(error, diagnostic);
      console.log(`- ${name}: FAILED ${String(error?.finalFailureCode || error?.code || 'ERROR').replace(/[^A-Z0-9_]/gi, '')}${sub ? ` (${sub})` : ''}`);
    }
    if (totals.costUsd >= cap) { totals.capped = true; console.log(`cost cap reached ($${totals.costUsd.toFixed(5)} of $${cap.toFixed(5)}); stopping`); }
    return totals.capped;
  };
  if (argv.includes('--coach-check')) await coachCheck(argv, env, config, cap, call);
  if (argv.includes('--coach-generate') && !totals.capped) await coachGenerate(argv, env, config, cap, call);
  console.log(`total: ${totals.calls} call(s), ${totals.inputTokens} input and ${totals.outputTokens} output tokens, $${totals.costUsd.toFixed(5)} reported`);
  if (runs.check.calls) console.log(`average per practice check: $${(runs.check.costUsd / runs.check.calls).toFixed(5)}`);
  if (runs.generate.calls) console.log(`average per task wording: $${(runs.generate.costUsd / runs.generate.calls).toFixed(5)}`);
}

/** The synthetic transcripts a coach trial uses: enough words, mostly Latin script, unique; --case and --max (default one). */
function coachCases(argv, env) {
  const assessment = require('../src/services/audio/speakingAssessment.service');
  const { settings } = require('../src/services/speakingCoach/policy').readSettings(env);
  const cases = require('../tests/fixtures/audio/speakingBenchmark.cjs');
  const pick = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
  const max = argv.includes('--max') ? Math.max(1, Number(argv[argv.indexOf('--max') + 1]) || 1) : 1;
  const seen = new Set();
  return cases.filter(c => (!pick || c.name.includes(pick)) && !seen.has(c.text) && seen.add(c.text)
    && assessment.countWords(c.text) >= settings.minWords && assessment.nonLatinShare(c.text) <= 0.3).slice(0, max);
}

/** The default speaking rubric's criteria as a session stores them, with grammar and vocabulary at Developing (the others at Good). */
async function coachCriteria() {
  const rubric = (await require('../src/services/audio/speakingRubric').resolveSpeakingRubric({ speaking: null })).rubric;
  return rubric.criteria.map(c => {
    const levelTitle = ['speaking-grammar', 'speaking-vocabulary'].includes(c.id) ? 'Developing' : 'Good';
    return { criterionId: c.id, title: c.title, weight: c.weight, levelTitle, levelPercent: c.levels.find(l => l.title === levelTitle)?.percentage ?? null,
      comment: 'The answer explains the main ideas clearly and gives an example to support them.',
      levels: c.levels.map(l => ({ title: l.title, percent: l.percentage, description: l.description })) };
  });
}

const TRIAL_ASSIGNMENT = Object.freeze({ title: 'Describe your town',
  instructions: 'Speak for one to three minutes about the town where you live: what it is like, what people do there, and what you would change.' });

/** --coach-generate: the coach's real task wording call (stored-data input, strict validation) for a grammar and a vocabulary task. */
async function coachGenerate(argv, env, config, cap, call) {
  const prompt = require('../src/services/speakingCoach/prompt');
  const areas = require('../src/services/speakingCoach/areas');
  const { settings } = require('../src/services/speakingCoach/policy').readSettings(env);
  const { caseRecording } = require('../tests/helpers/speakingAssessmentFixtures');
  const criteria = await coachCriteria();
  // Short synthetic corrections, as the student correction view gives them (the trial's transcripts are synthetic too).
  const corrections = [{ category: 'GRAMMAR', quotedText: 'It have', suggestedText: 'It has' }, { category: 'VOCABULARY', quotedText: 'by walk', suggestedText: 'on foot' },
    { category: 'VOCABULARY', quotedText: 'quiet', suggestedText: 'peaceful' }];
  const plan = areas.planTasks(areas.weakAreas(criteria, settings.passPercent), { vocabTargets: areas.vocabTargets(corrections), passPercent: settings.passPercent })
    .map((item, index) => ({ ...item, taskId: `t${index + 1}` }));
  const taskIds = plan.map(item => item.taskId);
  const forbiddenWords = prompt.forbiddenTitles(criteria);
  const selected = coachCases(argv, env);
  console.log(`task wording: model ${config.chain[0].model}; prompt ${prompt.GENERATION_PROMPT_VERSION}; ${selected.length} transcript(s); ${taskIds.length} task(s) each; cap $${cap.toFixed(5)}`);
  for (const item of selected) {
    const input = prompt.generationInput({ assignment: TRIAL_ASSIGNMENT, plan, criteria, fluency: caseRecording(item).fluency, corrections });
    const capped = await call('generate', `generation ${item.name}`, { feature: prompt.GENERATION_FEATURE, messages: prompt.generationMessages(input),
      maxOutputTokens: settings.maxOutputTokens, temperature: 0.2, responseFormat: 'json', responseSchema: prompt.generationSchema(taskIds),
      schemaName: prompt.GENERATION_FEATURE, validate: raw => prompt.validateGeneration(raw, { taskIds, forbiddenWords }) },
    value => `${Object.keys(value).length} tasks worded`);
    if (capped) break;
  }
}

/** --coach-check: the coach's real practice check (one practised criterion, the attempt's answer) on the grammar criterion. */
async function coachCheck(argv, env, config, cap, call) {
  const checkPrompt = require('../src/services/speakingCoach/checkPrompt');
  const { settings } = require('../src/services/speakingCoach/policy').readSettings(env);
  const { caseRecording } = require('../tests/helpers/speakingAssessmentFixtures');
  const criteria = await coachCriteria();
  const criterion = criteria.find(c => c.criterionId === 'speaking-grammar');
  const levelTitles = criterion.levels.map(l => l.title);
  const forbiddenWords = [...new Set(criteria.flatMap(c => c.levels.map(l => l.title)))];
  const task = { type: 'repeat_improve', prompt: 'Answer the task again. This time, focus on your grammar.', targets: [] };
  const selected = coachCases(argv, env);
  console.log(`practice check: model ${config.chain[0].model}; prompt ${checkPrompt.CHECK_PROMPT_VERSION}; ${selected.length} transcript(s); cap $${cap.toFixed(5)}`);
  for (const item of selected) {
    const { fluency } = caseRecording(item);
    const input = checkPrompt.checkInput({ assignment: TRIAL_ASSIGNMENT, task, criterion, before: { levelReached: 'Developing', notes: ['Check the verb forms as you speak.'],
      fluency }, nowFluency: fluency, answer: item.text, wordsNotToUse: forbiddenWords });
    const capped = await call('check', item.name, { feature: checkPrompt.CHECK_FEATURE, messages: checkPrompt.checkMessages(input), maxOutputTokens: settings.maxOutputTokens,
      temperature: 0, responseFormat: 'json', responseSchema: checkPrompt.checkSchema(levelTitles), schemaName: checkPrompt.CHECK_FEATURE,
      validate: raw => checkPrompt.validateCheck(raw, { levelTitles, forbiddenWords }) },
    value => (value.assessable ? `level ${value.level}, ${value.onTask ? 'on task' : 'off task'}` : `not assessable (${value.reason})`));
    if (capped) break;
  }
}

if (require.main === module) {
  if (process.env.SPEAKING_TRIAL === SWITCH) require('dotenv').config();
  main().catch(error => refuse(`failed: ${String(error?.name || 'Error')}`));
}
module.exports = { main, SWITCH };
