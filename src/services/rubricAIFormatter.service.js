const { fetchCompat, buildTimeoutSignal } = require('./httpClient.service');
const logger = require('../utils/logger');

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function isAbortError(err) {
  const name = err && typeof err === 'object' ? safeString(err.name) : '';
  const msg = err && typeof err === 'object' ? safeString(err.message) : '';
  return name === 'AbortError' || /aborted/i.test(msg) || /timeout/i.test(msg);
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

function coerceParsedTemplateToRubric(parsedRubric) {
  const input = parsedRubric && typeof parsedRubric === 'object' ? parsedRubric : null;
  if (!input) return null;

  const title = safeString(input.title).trim() || 'Rubric';
  const levelsRaw = Array.isArray(input.levels) ? input.levels : [];
  const criteriaRaw = Array.isArray(input.criteria) ? input.criteria : [];

  const levels = levelsRaw
    .map((l) => ({
      name: safeString(l && (l.name || l.title)).trim(),
      score: Number(l && (l.score ?? l.maxPoints))
    }))
    .filter((l) => l.name.length);

  const normalizedLevels = levels.length
    ? levels.map((l, idx) => ({
        name: safeString(l.name).trim() || `Level ${idx + 1}`,
        score: Number.isFinite(Number(l.score)) ? Math.max(0, Math.floor(Number(l.score))) : 0
      }))
    : defaultFourLevels();

  const criteria = criteriaRaw
    .map((c) => {
      const cTitle = safeString(c && (c.title || c.name)).trim();
      const descRaw = Array.isArray(c && c.descriptions)
        ? c.descriptions
        : (Array.isArray(c && c.cells) ? c.cells : []);
      const descriptions = Array.from({ length: normalizedLevels.length }).map((_, i) => safeString(descRaw[i]).trim());
      return cTitle ? { title: cTitle, descriptions } : null;
    })
    .filter(Boolean);

  if (!criteria.length) return null;

  return {
    title,
    levels: normalizedLevels,
    criteria
  };
}

function looksLikeValidRubric(parsedRubric) {
  const input = parsedRubric && typeof parsedRubric === 'object' ? parsedRubric : null;
  if (!input) return false;
  const levelsRaw = Array.isArray(input.levels) ? input.levels : [];
  const criteriaRaw = Array.isArray(input.criteria) ? input.criteria : [];
  return levelsRaw.length >= 2 && criteriaRaw.length >= 1;
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

Convert this rubric document into structured JSON.

Return only JSON.

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
- If levels are not clearly defined, infer a standard 4-level rubric.
- Ensure valid JSON.
`;
}

async function formatRubricFromTemplateParsed({ parsedRubric }) {
  const input = parsedRubric && typeof parsedRubric === 'object' ? parsedRubric : null;
  if (!input) {
    const err = new Error('No parsed rubric provided');
    err.statusCode = 400;
    throw err;
  }

  // Performance + robustness: if the template parser already produced a structured rubric,
  // do not call AI.
  if (looksLikeValidRubric(input)) {
    const coerced = coerceParsedTemplateToRubric(input);
    return coerced || normalizeRubricJson(input) || input;
  }

  const apiKey = safeString(process.env.OPENAI_API_KEY).trim();
  if (!apiKey) {
    const fallback = coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
    logger.error('Rubric AI formatting error: OPENAI_API_KEY missing. Using fallback rubric.');
    return fallback;
  }

  const model = safeString(process.env.OPENAI_MODEL).trim() || 'gpt-4o-mini';
  const endpoint = safeString(process.env.OPENAI_BASE_URL).trim() || 'https://api.openai.com/v1/chat/completions';

  const timeoutMs = Math.min(60000, Math.max(1, Number(process.env.OPENAI_TIMEOUT_MS) || 60000));
  const { signal, cancel } = buildTimeoutSignal(timeoutMs);

  const rawJson = JSON.stringify(input);
  const capped = rawJson.length > 25000 ? rawJson.slice(0, 25000) : rawJson;

  const userPrompt = `Convert the following parsed rubric structure into the required JSON format.\n\nParsed rubric data (JSON):\n${capped}`;

  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userPrompt }
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
    const fallback = coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
    logger.error(`Rubric AI formatting error: request failed. Using fallback rubric. model=${model} endpoint=${endpoint} isTimeout=${isAbortError(e)} message=${e && typeof e === 'object' ? safeString(e.message) : safeString(e)}`);
    return fallback;
  } finally {
    cancel();
  }

  if (!resp || !resp.ok) {
    const fallback = coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
    let message = 'AI parsing failure';
    let responseBody = '';
    try {
      const errJson = await resp.json();
      const apiMsg = safeString(errJson && errJson.error && errJson.error.message).trim();
      if (apiMsg) message = apiMsg;
      try {
        responseBody = JSON.stringify(errJson);
      } catch {
        responseBody = safeString(errJson);
      }
    } catch {
      try {
        const errText = safeString(await resp.text()).trim();
        if (errText) message = errText;
        responseBody = errText;
      } catch {
        // ignore
      }
    }

    logger.error(`Rubric AI formatting error: provider returned non-2xx. Using fallback rubric. model=${model} endpoint=${endpoint} status=${resp.status} statusText=${safeString(resp.statusText)} message=${message}`);
    return fallback;
  }

  const json = await resp.json();
  const content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
  if (!content) {
    const fallback = coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
    logger.error(`Rubric AI formatting error: empty response content. Using fallback rubric. model=${model} endpoint=${endpoint}`);
    return fallback;
  }

  const parsed = safeJsonParse(content);
  const normalized = normalizeRubricJson(parsed);
  if (!normalized) {
    const fallback = coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
    logger.error(`Rubric AI formatting error: invalid JSON response. Using fallback rubric. model=${model} endpoint=${endpoint} sample=${content.length > 2000 ? content.slice(0, 2000) : content}`);
    return fallback;
  }

  return normalized;
}

module.exports = {
  formatRubricFromTemplateParsed
};
