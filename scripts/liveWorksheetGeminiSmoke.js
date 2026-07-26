'use strict';

const { generateFeatureJson, validateWorksheetOutput } = require('../src/services/featureGemini.service');

async function main() {
  if (process.env.RUN_LIVE_WORKSHEET_AI_SMOKE !== 'true') {
    console.log('Worksheet Gemini smoke skipped; set RUN_LIVE_WORKSHEET_AI_SMOKE=true to run.');
    return;
  }
  const startedAt = Date.now();
  const result = await generateFeatureJson('worksheet', [
    { role: 'system', content: 'Return only one valid JSON worksheet object.' },
    { role: 'user', content: 'Create an English science worksheet with title, description, subject, tags, estimatedMinutes, and one multipleChoice activity. The activity needs title, instructions, order, and data.questions with unique id, text, options, and correctAnswer. Use no personal data.' }
  ]);
  const worksheet = validateWorksheetOutput(result.value, ['multipleChoice']);
  console.log(JSON.stringify({
    provider: result.metadata.provider, model: result.metadata.model,
    durationMs: Date.now() - startedAt, activityCount: worksheet.activities.length,
    tokenUsage: result.metadata.usage || null
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error?.code || 'LIVE_SMOKE_FAILED' }));
  process.exitCode = 1;
});
