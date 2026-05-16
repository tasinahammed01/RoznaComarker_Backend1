/**
 * worksheetTheme.service.js
 *
 * Calls AI (OpenAI/OpenRouter) to generate a matching visual theme for a worksheet
 * based on its topic, title and description.
 */

const { generateChatCompletion } = require('./aiGeneration.service');

const VALID_PATTERNS = [
  'none', 'leaves', 'dots', 'stars', 'waves',
  'geometric', 'honeycomb', 'circuit', 'bubbles',
  'grid', 'paws', 'musical-notes', 'molecules',
  'books', 'clouds', 'grass', 'space',
];
const VALID_FONTS   = ['modern', 'friendly', 'classic', 'bold', 'playful'];
const VALID_HEADERS = ['flat', 'gradient', 'wave', 'diagonal'];

const THEME_SYSTEM_PROMPT = `You are a worksheet theme generator. an educational platform.
Given a worksheet topic, generate a JSON theme configuration.

Return ONLY valid JSON. No markdown, no explanation.

The JSON must match this exact structure:
{
  "primaryColor": "#hexcode",
  "accentColor": "#hexcode",
  "backgroundColor": "#hexcode",
  "headerGradient": "linear-gradient(135deg, #hex1, #hex2)",
  "patternType": "one of: none|leaves|dots|stars|waves|geometric|honeycomb|circuit|bubbles|grid|paws|musical-notes|molecules|books|clouds|grass|space",
  "fontStyle": "one of: modern|friendly|classic|bold|playful",
  "headerStyle": "one of: flat|gradient|wave|diagonal",
  "darkHeader": true or false,
  "colorPalette": {
    "correct": "#hexcode",
    "wrong": "#hexcode",
    "highlight": "#hexcode",
    "cardBackground": "#hexcode",
    "borderColor": "#hexcode"
  },
  "reasoning": "brief explanation of theme choices"
}

Theme guidelines by topic type:
- Nature/Biology/Food Chain/Animals: greens, earth tones, leaf patterns
- Space/Astronomy: dark navy/purple, star patterns, cosmic gradients
- Ocean/Marine: blues, wave patterns, coral accents
- Math/Numbers: clean whites, geometric patterns, primary colors
- History: sepia/brown tones, paper texture, classic serif
- Chemistry/Science: lab blue/white, molecule patterns, modern clean
- Music/Arts: purple/pink, musical note patterns, creative curves
- Geography: earth map tones, grid patterns, warm browns
- Literature: warm cream/gold, book patterns, elegant classic
- Sports/PE: energetic oranges/reds, dynamic diagonal patterns
- Technology/Computers: dark modern, circuit patterns, neon accents
- Health/Body: warm pinks/reds, clean medical white
- Language/English: soft blues, paper patterns, classic fonts

Rules:
- primaryColor: main brand color for headers and buttons
- accentColor: lighter version for backgrounds and highlights
- backgroundColor: page/card background (usually white or very light)
- headerGradient: used in worksheet header bar
- Make colors harmonious and appropriate for children/students
- Ensure sufficient contrast for readability
- darkHeader: true if header background is dark enough to need white text`;

function isValidHex(str) {
  return typeof str === 'string' && /^#[0-9A-Fa-f]{6}$/.test(str);
}

function getDefaultTheme() {
  return {
    primaryColor:    '#0d9488',
    accentColor:     '#99f6e4',
    backgroundColor: '#ffffff',
    headerGradient:  'linear-gradient(135deg, #0d3a4c 0%, #134e63 60%, #1a6070 100%)',
    patternType:     'none',
    fontStyle:       'modern',
    headerStyle:     'gradient',
    darkHeader:      true,
    colorPalette: {
      correct:        '#16a34a',
      wrong:          '#dc2626',
      highlight:      '#fef3c7',
      cardBackground: '#f9fafb',
      borderColor:    '#e5e7eb',
    },
  };
}

function validateTheme(theme) {
  return {
    primaryColor:    isValidHex(theme.primaryColor)    ? theme.primaryColor    : '#0d9488',
    accentColor:     isValidHex(theme.accentColor)     ? theme.accentColor     : '#99f6e4',
    backgroundColor: isValidHex(theme.backgroundColor) ? theme.backgroundColor : '#ffffff',
    headerGradient:  typeof theme.headerGradient === 'string' && theme.headerGradient
      ? theme.headerGradient : '',
    patternType: VALID_PATTERNS.includes(theme.patternType) ? theme.patternType : 'none',
    fontStyle:   VALID_FONTS.includes(theme.fontStyle)      ? theme.fontStyle   : 'modern',
    headerStyle: VALID_HEADERS.includes(theme.headerStyle)  ? theme.headerStyle : 'flat',
    darkHeader:  Boolean(theme.darkHeader),
    colorPalette: {
      correct:        isValidHex(theme.colorPalette?.correct)        ? theme.colorPalette.correct        : '#16a34a',
      wrong:          isValidHex(theme.colorPalette?.wrong)          ? theme.colorPalette.wrong          : '#dc2626',
      highlight:      isValidHex(theme.colorPalette?.highlight)      ? theme.colorPalette.highlight      : '#fef3c7',
      cardBackground: isValidHex(theme.colorPalette?.cardBackground) ? theme.colorPalette.cardBackground : '#f9fafb',
      borderColor:    isValidHex(theme.colorPalette?.borderColor)    ? theme.colorPalette.borderColor    : '#e5e7eb',
    },
  };
}

async function generateWorksheetTheme(topic, title, description) {
  const userPrompt = `Generate a theme for this worksheet:
Topic: ${topic || ''}
Title: ${title || ''}
Description: ${description || ''}

Create an appropriate educational theme for this subject.`;

  try {
    const raw = await generateChatCompletion([
      { role: 'system', content: THEME_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ], {
      temperature: 0.7,
      max_tokens: 500,
    });

    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace  = cleaned.lastIndexOf('}');
    const jsonStr = (firstBrace >= 0 && lastBrace > firstBrace)
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;

    const parsed = JSON.parse(jsonStr);
    const validated = validateTheme(parsed);
    validated.generatedFor = String(topic || title || '').slice(0, 200);
    return validated;
  } catch (err) {
    console.error('[WORKSHEET THEME] OpenAI error:', err.response?.data || err.message);
    return getDefaultTheme();
  }
}

module.exports = { generateWorksheetTheme, getDefaultTheme };
