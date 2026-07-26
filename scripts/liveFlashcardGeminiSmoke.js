'use strict';

const { generateFeatureJson, validateFlashcardOutput } = require('../src/services/featureGemini.service');

async function main() {
  if (process.env.RUN_LIVE_FLASHCARD_AI_SMOKE !== 'true') {
    console.log('Flashcard Gemini smoke skipped; set RUN_LIVE_FLASHCARD_AI_SMOKE=true to run.');
    return;
  }
  const startedAt = Date.now();
  const result = await generateFeatureJson('flashcard', [
    { role: 'system', content: 'Return only a JSON array of two objects with non-empty front and back strings.' },
    { role: 'user', content: 'Create two English term-definition cards about the water cycle. No personal data.' }
  ]);
  const cards = validateFlashcardOutput(result.value, 2);
  console.log(JSON.stringify({
    provider: result.metadata.provider, model: result.metadata.model,
    durationMs: Date.now() - startedAt, itemCount: cards.length,
    tokenUsage: result.metadata.usage || null
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error?.code || 'LIVE_SMOKE_FAILED' }));
  process.exitCode = 1;
});
