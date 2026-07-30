'use strict';

const aiGateway = require('../services/aiGateway.service');

async function callVisionModelWithFallback(base64Image, prompt) {
  const result = await aiGateway.generate({
    feature: 'vision_analysis',
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
      { type: 'text', text: prompt }
    ] }],
    maxOutputTokens: 4000,
    responseFormat: 'json',
    validate: (content) => {
      parseVisionJSON(content);
      return content;
    }
  });
  return result.content;
}

function parseVisionJSON(rawContent) {
  let cleaned = String(rawContent || '').trim()
    .replace(/^```json\s*/iu, '').replace(/^```\s*/u, '').replace(/```\s*$/u, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error('No valid JSON found in AI response');
  try { return JSON.parse(match[0]); }
  catch (error) { throw new Error(`Failed to parse JSON: ${error.message}`); }
}

module.exports = { callVisionModelWithFallback, parseVisionJSON };
