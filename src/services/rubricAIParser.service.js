const { fetchCompat, buildTimeoutSignal } = require('./httpClient.service');

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function stripMarkdownCodeFences(text) {
  const raw = safeString(text).trim();
  if (!raw) return '';
  return raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractFirstJsonObject(text) {
  const s = safeString(text);
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) {
      const candidate = s.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeJsonParse(text) {
  const raw = safeString(text).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = stripMarkdownCodeFences(raw);
    try {
      return JSON.parse(cleaned);
    } catch {
      return extractFirstJsonObject(cleaned);
    }
  }
}

function defaultFourLevels() {
  return [
    { name: 'Below Expectation', score: 10 },
    { name: 'Meets Expectation', score: 20 },
    { name: 'Exceeds Expectation', score: 30 },
    { name: 'Outstanding', score: 40 }
  ];
}

function normalizeRubricJson(obj) {
  const o = obj && typeof obj === 'object' ? obj : null;
  if (!o) return null;

  const title = safeString(o.title).trim() || 'Rubric';

  const levelsRaw = Array.isArray(o.levels) ? o.levels : [];
  let levels = levelsRaw
    .map((l) => ({
      name: safeString(l && (l.name || l.title)).trim(),
      score: Number(l && (l.score ?? l.maxPoints))
    }))
    .filter((l) => l.name.length);

  if (!levels.length) {
    levels = defaultFourLevels();
  }

  const criteriaRaw = Array.isArray(o.criteria) ? o.criteria : [];
  const criteria = criteriaRaw
    .map((c) => {
      const cTitle = safeString(c && c.title).trim() || safeString(c && c.name).trim();
      const descRaw = Array.isArray(c && c.descriptions)
        ? c.descriptions
        : (Array.isArray(c && c.cells) ? c.cells : []);
      const descriptions = Array.from({ length: levels.length }).map((_, i) => safeString(descRaw[i]).trim());
      return cTitle ? { title: cTitle, descriptions } : null;
    })
    .filter(Boolean);

  if (!criteria.length) {
    return null;
  }

  return {
    title,
    levels: levels.map((l, idx) => ({
      name: safeString(l.name).trim() || `Level ${idx + 1}`,
      score: Number.isFinite(Number(l.score)) ? Math.max(0, Math.floor(Number(l.score))) : 0
    })),
    criteria
  };
}

function buildSystemPrompt() {
  return `You are an academic rubric parser.

Extract rubric grading structure from the document.

Return ONLY valid JSON.

Required structure:
{
  "title": "Rubric Title",
  "levels": [
    { "name": "Below Expectation", "score": 10 }
  ],
  "criteria": [
    {
      "title": "Content Relevance",
      "descriptions": ["level1 desc", "level2 desc", "level3 desc", "level4 desc"]
    }
  ]
}

Rules:
- Output MUST be a single JSON object.
- Do not include markdown, code fences, or commentary.
- Each criteria.descriptions length MUST equal levels.length.
- If levels are missing, infer a standard 4-level rubric.
- If numeric scores are missing, infer increasing integer scores.
`;
}

async function parseRubricTextToJson({ text }) {
  const extractedText = safeString(text).trim();
  if (!extractedText) {
    const err = new Error('No text provided to AI parser');
    err.statusCode = 400;
    throw err;
  }

  const apiKey = safeString(process.env.OPENAI_API_KEY).trim();
  if (!apiKey) {
    const err = new Error('AI provider not configured');
    err.statusCode = 501;
    throw err;
  }

  const model = safeString(process.env.OPENAI_MODEL).trim() || 'gpt-4o-mini';
  const endpoint = safeString(process.env.OPENAI_BASE_URL).trim() || 'https://api.openai.com/v1/chat/completions';

  const timeoutMs = Math.min(60000, Math.max(1, Number(process.env.OPENAI_TIMEOUT_MS) || 60000));
  const { signal, cancel } = buildTimeoutSignal(timeoutMs);

  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: extractedText.length > 25000 ? extractedText.slice(0, 25000) : extractedText }
    ]
  };

  let resp;
  try {
    resp = await fetchCompat(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (e) {
    const name = e && typeof e === 'object' ? safeString(e.name) : '';
    const msg = e && typeof e === 'object' ? safeString(e.message) : '';
    const err = new Error(name === 'AbortError' || /aborted/i.test(msg) ? 'AI request timed out. Please try again.' : (msg || 'AI request failed'));
    err.statusCode = name === 'AbortError' || /aborted/i.test(msg) ? 504 : 502;
    throw err;
  } finally {
    cancel();
  }

  if (!resp || !resp.ok) {
    let message = 'AI parsing failure';
    let statusCode = 502;
    try {
      const errJson = await resp.json();
      const apiMsg = safeString(errJson && errJson.error && errJson.error.message).trim();
      if (apiMsg) message = apiMsg;
    } catch {
      try {
        const errText = safeString(await resp.text()).trim();
        if (errText) message = errText;
      } catch {
        // ignore
      }
    }
    if (resp.status === 429) {
      statusCode = 429;
      message = 'AI quota exceeded. Please try again later.';
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  }

  const json = await resp.json();
  const content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
  if (!content) {
    const err = new Error('AI returned an empty response');
    err.statusCode = 422;
    throw err;
  }

  const parsed = safeJsonParse(content);
  const normalized = normalizeRubricJson(parsed);
  if (!normalized) {
    const err = new Error('Invalid JSON response from AI');
    err.statusCode = 422;
    throw err;
  }

  return normalized;
}

module.exports = {
  parseRubricTextToJson
};
