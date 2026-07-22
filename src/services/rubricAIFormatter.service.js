const { completeRubric } = require('./rubricCompletion.service');
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
    { "title": "Below Expectation", "maxPoints": 10 }
  ],
  "criteria": [
    {
      "title": "Content Relevance",
      "cells": ["level1 desc", "level2 desc", "level3 desc", "level4 desc"]
    }
  ]
}

Rules:
- Output MUST be a single JSON object.
- Do not include markdown, code fences, or commentary.
- Each criteria.cells length MUST equal levels.length.
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

  const rawJson = JSON.stringify(input);
  const capped = rawJson.length > 25000 ? rawJson.slice(0, 25000) : rawJson;

  const userPrompt = `Convert the following parsed rubric structure into the required JSON format.\n\nParsed rubric data (JSON):\n${capped}`;
  try {
    const rubric = await completeRubric({ systemInstruction: buildSystemPrompt(), userPrompt });
    return normalizeRubricJson(rubric) || coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
  } catch (error) {
    logger.warn({ message: 'Rubric AI formatting failed; using parsed fallback', errorCode: error?.code || 'RUBRIC_PROVIDER_FAILED' });
    return coerceParsedTemplateToRubric(input) || normalizeRubricJson(input) || input;
  }
}

module.exports = {
  formatRubricFromTemplateParsed
};
