/**
 * Vision AI Utility Functions
 * Shared utilities for vision AI model calls with fallback chain
 */

// Vision model fallback chain
const VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'openrouter/auto',
  'qwen/qwen2.5-vl-72b-instruct:free'
];

/**
 * Call vision model with fallback chain
 * Tries multiple free vision models in order until one succeeds
 */
async function callVisionModelWithFallback(base64Image, prompt, apiKey = null) {
  let lastError = null;
  const effectiveApiKey = apiKey || process.env.OPENROUTER_API_KEY;

  for (const model of VISION_MODELS) {
    try {
      console.log(`[VISION AI] Trying model: ${model}`);

      const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${effectiveApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:4200',
            'X-Title': 'RoznaHub'
          },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                },
                { type: 'text', text: prompt }
              ]
            }],
            max_tokens: 4000,
            temperature: 0.1
          })
        }
      );

      if (response.status === 404) {
        console.log(`[VISION AI] ${model} not found, skipping`);
        lastError = new Error(`${model} not found`);
        continue;
      }

      if (response.status === 429) {
        console.log(`[VISION AI] ${model} rate limited, waiting 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        lastError = new Error(`${model} rate limited`);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        console.log(`[VISION AI] ${model} error ${response.status}:`, body);
        lastError = new Error(`${model} failed: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      
      if (!content) {
        lastError = new Error(`${model} empty response`);
        continue;
      }

      console.log(`[VISION AI] Success with: ${model}`);
      return content;

    } catch (err) {
      console.log(`[VISION AI] ${model} threw:`, err.message);
      lastError = err;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
  }

  throw new Error(`All vision models failed. Last error: ${lastError?.message}`);
}

/**
 * Parse JSON from vision AI response
 * Handles markdown code blocks and extracts JSON object
 */
function parseVisionJSON(rawContent) {
  let cleaned = rawContent.trim();
  
  // Remove markdown code blocks if present
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '');
  cleaned = cleaned.replace(/```\s*$/i, '');
  cleaned = cleaned.trim();
  
  // Find JSON object in response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON: ${parseError.message}`);
    }
  }
  
  throw new Error('No valid JSON found in AI response');
}

module.exports = {
  callVisionModelWithFallback,
  parseVisionJSON
};
