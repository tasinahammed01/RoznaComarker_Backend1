'use strict';

require('../src/config/env');
const { generateFeatureJson, validateFlashcardOutput } = require('../src/services/featureGemini.service');

async function main() {
  if (process.env.RUN_LIVE_FLASHCARD_AI_SMOKE !== 'true') {
    console.log('Flashcard Gemini smoke skipped; set RUN_LIVE_FLASHCARD_AI_SMOKE=true to run.');
    return;
  }
  for (const template of ['qa', 'concept']) {
    const startedAt = Date.now();
    const result = await generateFeatureJson('flashcard', [
      { role: 'system', content: 'Return only one JSON object in the shape {"flashcards":[{"front":"string","back":"string"}]}.' },
      { role: 'user', content: `Create two English ${template} cards about the water cycle. No personal data.` }
    ], { validateValue: (value) => validateFlashcardOutput(value, 2, template) });
    const cards = result.value;
    console.log(JSON.stringify({
      template, provider: result.metadata.provider, model: result.metadata.model,
      durationMs: Date.now() - startedAt, itemCount: cards.length,
      tokenUsage: result.metadata.usage || null
    }));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error?.code || 'LIVE_SMOKE_FAILED' }));
  process.exitCode = 1;
});
