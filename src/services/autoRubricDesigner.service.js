const mongoose = require('mongoose');

const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');

const { fetchCompat, buildTimeoutSignal } = require('./httpClient.service');

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function safeCellString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const obj = v;
    const preferred = [obj.description, obj.text, obj.content, obj.value, obj.label];
    for (const x of preferred) {
      const s = typeof x === 'string' ? x : (x == null ? '' : String(x));
      if (s.trim().length) return s;
    }
    try {
      return JSON.stringify(obj).slice(0, 2000);
    } catch {
      return '';
    }
  }
  return '';
}

function stripMarkdownCodeFences(text) {
  const s = safeString(text).trim();
  if (!s) return '';

  const match = s.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```\s*$/);
  if (match) return safeString(match[1]).trim();

  return s;
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text) {
  const s = safeString(text);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;
  return safeJsonParse(s.slice(first, last + 1));
}

function normalizeRubricDesignerPayload(value) {
  if (value == null) return { value: null };
  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) return { error: 'rubricDesigner must be an object' };

  const title = safeString(obj.title).trim();

  const rawCriteriaCandidate = (Array.isArray(obj.criteria)
    ? obj.criteria
    : (obj.criteria && typeof obj.criteria === 'object' ? Object.values(obj.criteria) : null));

  const rawLevelsCandidate = (Array.isArray(obj.levels)
    ? obj.levels
    : (obj.levels && typeof obj.levels === 'object' ? Object.values(obj.levels) : null));

  let inferredLevels = null;
  if (!rawLevelsCandidate && Array.isArray(rawCriteriaCandidate) && rawCriteriaCandidate.length) {
    const firstRow = rawCriteriaCandidate[0] && typeof rawCriteriaCandidate[0] === 'object' ? rawCriteriaCandidate[0] : {};
    const rawCells = Array.isArray(firstRow.cells)
      ? firstRow.cells
      : (firstRow.cells && typeof firstRow.cells === 'object' ? Object.values(firstRow.cells) : null);
    const cellCount = Array.isArray(rawCells) ? rawCells.length : 0;
    if (cellCount > 0) {
      const count = Math.min(6, Math.max(1, cellCount));
      inferredLevels = Array.from({ length: count }).map(() => ({ title: '', maxPoints: 0 }));
    }
  }

  const levelsCandidate = rawLevelsCandidate || inferredLevels;
  const rawLevels = Array.isArray(levelsCandidate)
    ? levelsCandidate
    : (levelsCandidate && typeof levelsCandidate === 'object' ? Object.values(levelsCandidate) : null);
  const safeRawLevels = (Array.isArray(rawLevels) && rawLevels.length)
    ? rawLevels
    : Array.from({ length: 4 }).map(() => ({ title: '', maxPoints: 0 }));

  const levels = safeRawLevels
    .map((l) => {
      const lvl = l && typeof l === 'object' ? l : {};
      const maxPoints = Number(lvl.maxPoints);
      return {
        title: safeString(lvl.title).trim(),
        maxPoints: Number.isFinite(maxPoints) ? Math.max(0, Math.floor(maxPoints)) : 0
      };
    })
    .slice(0, 6);

  const rawCriteria = Array.isArray(rawCriteriaCandidate)
    ? rawCriteriaCandidate
    : (rawCriteriaCandidate && typeof rawCriteriaCandidate === 'object' ? Object.values(rawCriteriaCandidate) : null);
  const safeRawCriteria = Array.isArray(rawCriteria) ? rawCriteria : [];

  const criteria = safeRawCriteria
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const rawCells = Array.isArray(row.cells)
        ? row.cells
        : (row.cells && typeof row.cells === 'object' ? Object.values(row.cells) : []);
      const cells = Array.isArray(rawCells) ? rawCells.map((x) => safeCellString(x)) : [];
      return {
        title: safeString(row.title).trim(),
        cells: cells.slice(0, 10)
      };
    })
    .slice(0, 50);

  if (!criteria.length) {
    criteria.push({ title: '', cells: Array.from({ length: levels.length }).map(() => '') });
  }

  return { value: { title, levels, criteria } };
}

function sanitizeRubricDesignerCriteria(rubricDesigner) {
  const d = rubricDesigner && typeof rubricDesigner === 'object' ? rubricDesigner : null;
  if (!d) return d;

  const unwanted = new Set([
    'overall_rubric_score',
    'content_relevance',
    'structure_organization',
    'structure_&_organization',
    'grammar_mechanics',
    'grammar_&_mechanics'
  ]);

  const criteria = Array.isArray(d.criteria) ? d.criteria : [];
  const filtered = criteria.filter((c) => {
    const title = safeString(c && c.title).trim().toLowerCase();
    const key = title.replace(/\s+/g, '_');
    return !unwanted.has(key);
  });

  return { ...d, criteria: filtered };
}

async function autoGenerateRubricDesignerForSubmission({ submissionId }) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    return { ok: false, skipped: true, reason: 'invalid_submission_id' };
  }

  const submission = await Submission.findById(submissionId);
  if (!submission) {
    return { ok: false, skipped: true, reason: 'submission_not_found' };
  }

  const assignment = await Assignment.findById(submission.assignment);
  if (!assignment) {
    return { ok: false, skipped: true, reason: 'assignment_not_found' };
  }

  const teacherId = assignment.teacher;
  if (!teacherId) {
    return { ok: false, skipped: true, reason: 'teacher_not_found' };
  }

  const studentText = safeString(submission.transcriptText).trim() || safeString(submission.combinedOcrText).trim() || safeString(submission.ocrText).trim();
  if (!studentText) {
    return { ok: false, skipped: true, reason: 'no_text' };
  }

  const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
  if (existing && existing.overriddenByTeacher && existing.rubricDesigner) {
    return { ok: true, skipped: true, reason: 'teacher_overridden' };
  }

  const apiKey = safeString(process.env.OPENROUTER_API_KEY).trim();
  const baseUrl = safeString(process.env.OPENROUTER_BASE_URL).trim() || 'https://openrouter.ai/api/v1';
  const model = safeString(process.env.LLAMA_MODEL).trim() || 'meta-llama/llama-3-8b-instruct';

  if (!apiKey) {
    return { ok: false, skipped: true, reason: 'ai_not_configured' };
  }

  const systemInstruction = 'You are an academic rubric generator. Return ONLY valid JSON with no explanation, no markdown, no code blocks.';

  const cappedStudentText = studentText.length > 8000 ? studentText.slice(0, 8000) : studentText;
  const assignmentTitle = safeString(assignment.title).trim();
  const assignmentInstructions = safeString(assignment.instructions).trim();
  const assignmentWritingType = safeString(assignment.writingType).trim();

  const rubricTitle = `Rubric: ${assignmentTitle || 'Submission'}`;

  const prompt = `Generate a rubric designer for grading the student's work.\n\nAssignment Title: ${assignmentTitle || 'N/A'}\nAssignment Writing Type: ${assignmentWritingType || 'N/A'}\nAssignment Instructions: ${assignmentInstructions || 'N/A'}\n\nStudent Submission Text (OCR/Transcript):\n${cappedStudentText}\n\nOutput must match this exact JSON structure:\n{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}.\nRules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. Keep criteria 3-10 rows. Keep maxPoints as integers. Make criteria relevant to the writing type. Use clear descriptions in cells for each performance level. Use title: ${rubricTitle}.`;

  const timeoutMs = Math.min(60000, Math.max(1, Number(process.env.OPENROUTER_TIMEOUT_MS) || 60000));
  const { signal, cancel } = buildTimeoutSignal(timeoutMs);
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  let resp;
  try {
    resp = await fetchCompat(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ]
      }),
      signal
    });
  } finally {
    cancel();
  }

  if (!resp || !resp.ok) {
    return { ok: false, skipped: false, reason: 'ai_failed' };
  }

  const json = await resp.json();
  const content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
  if (!content) {
    return { ok: false, skipped: false, reason: 'empty_ai_response' };
  }

  const cleaned = stripMarkdownCodeFences(content);
  const parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
  const normalized = normalizeRubricDesignerPayload(parsed);
  if (normalized.error || !normalized.value) {
    return { ok: false, skipped: false, reason: 'invalid_rubric_json' };
  }

  const rubricDesigner = {
    ...normalized.value,
    title: normalized.value.title && String(normalized.value.title).trim().length ? normalized.value.title : rubricTitle
  };

  const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

  await SubmissionFeedback.findOneAndUpdate(
    { submissionId: submission._id },
    {
      $set: {
        rubricDesigner: sanitizedRubricDesigner,
        overriddenByTeacher: false
      },
      $setOnInsert: {
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { ok: true, skipped: false };
}

module.exports = {
  autoGenerateRubricDesignerForSubmission
};
