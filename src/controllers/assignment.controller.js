const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');

const { fetchCompat, buildTimeoutSignal } = require('../services/httpClient.service');

const { incrementUsage } = require('../middlewares/usage.middleware');
const logger = require('../utils/logger');
const { createNotification } = require('../services/notification.service');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
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
  if (!s) return null;

  const direct = safeJsonParse(s);
  if (direct && typeof direct === 'object') return direct;

  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') depth--;

      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        const parsed = safeJsonParse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
        break;
      }
      if (depth < 0) break;
    }
  }

  return null;
}

function normalizeRubricDesignerPayload(value) {
  if (value == null) return { value: null };
  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) return { error: 'rubricDesigner must be an object' };

  const title = safeString(obj.title).trim();

  const rawLevels = Array.isArray(obj.levels) ? obj.levels : null;
  if (!rawLevels) return { error: 'rubricDesigner.levels must be an array' };

  const levels = rawLevels
    .map((l) => {
      const lvl = l && typeof l === 'object' ? l : {};
      const maxPoints = Number(lvl.maxPoints);
      return {
        title: safeString(lvl.title).trim(),
        maxPoints: Number.isFinite(maxPoints) ? Math.max(0, Math.floor(maxPoints)) : 0
      };
    })
    .slice(0, 6);

  const rawCriteria = Array.isArray(obj.criteria) ? obj.criteria : null;
  if (!rawCriteria) return { error: 'rubricDesigner.criteria must be an array' };

  const criteria = rawCriteria
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const cells = Array.isArray(row.cells) ? row.cells.map((x) => safeString(x)) : [];
      return {
        title: safeString(row.title).trim(),
        cells: cells.slice(0, 10)
      };
    })
    .slice(0, 50);

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function normalizeOptionalString(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeRubric(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (err) {
    return null;
  }
}

function normalizeRubrics(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) {
    return null;
  }

  const rawCriteria = Array.isArray(obj.criteria) ? obj.criteria : null;
  if (!rawCriteria) {
    return null;
  }

  const criteria = rawCriteria
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const rawLevels = Array.isArray(row.levels) ? row.levels : [];
      const levels = rawLevels
        .map((l) => {
          const lvl = l && typeof l === 'object' ? l : {};
          const score = Number(lvl.score);
          return {
            title: typeof lvl.title === 'string' ? lvl.title.trim() : '',
            score: Number.isFinite(score) ? score : 0,
            description: typeof lvl.description === 'string' ? lvl.description.trim() : ''
          };
        })
        .slice(0, 10);

      return { name, levels };
    })
    .filter((c) => c && typeof c.name === 'string')
    .slice(0, 100);

  return { criteria };
}

async function createAssignment(req, res) {
  try {
    const { title, writingType, instructions, rubric, rubrics, deadline, classId, allowLateResubmission } = req.body || {};

    if (!isNonEmptyString(title)) {
      return sendError(res, 400, 'title is required');
    }

    if (!isNonEmptyString(writingType)) {
      return sendError(res, 400, 'writingType is required');
    }

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const parsedDeadline = toValidDate(deadline);
    if (!parsedDeadline) {
      return sendError(res, 400, 'deadline is required');
    }

    if (parsedDeadline.getTime() <= Date.now()) {
      return sendError(res, 400, 'deadline must be in the future');
    }

    if (typeof allowLateResubmission !== 'undefined' && typeof allowLateResubmission !== 'boolean') {
      return sendError(res, 400, 'allowLateResubmission must be a boolean');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: classId,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const normalizedInstructions = normalizeOptionalString(instructions);
    if (normalizedInstructions === null) {
      return sendError(res, 400, 'instructions must be a string');
    }

    const normalizedRubric = normalizeRubric(rubric);
    if (normalizedRubric === null) {
      return sendError(res, 400, 'rubric must be valid text or JSON');
    }

    const normalizedRubrics = normalizeRubrics(rubrics);
    if (normalizedRubrics === null) {
      return sendError(res, 400, 'rubrics must be valid JSON');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const qrToken = uuidv4();

      try {
        const created = await Assignment.create({
          title: title.trim(),
          writingType: writingType.trim(),
          instructions: normalizedInstructions,
          rubric: normalizedRubric,
          rubrics: normalizedRubrics,
          deadline: parsedDeadline,
          class: classDoc._id,
          teacher: teacherId,
          qrToken,
          allowLateResubmission: typeof allowLateResubmission === 'boolean' ? allowLateResubmission : undefined
        });

        await incrementUsage(teacherId, { assignments: 1 });

        const populated = await Assignment.findById(created._id)
          .populate('class')
          .populate('teacher', '_id email displayName photoURL role');

        classDoc.updatedAt = new Date();
        await classDoc.save();

        // Notify active students in this class (fire-and-forget)
        setImmediate(async () => {
          try {
            const memberships = await Membership.find({
              class: classDoc._id,
              status: 'active'
            }).select('student');

            const studentIds = (memberships || [])
              .map((m) => m && m.student)
              .filter(Boolean);

            const teacherDisplay =
              (req.user && (req.user.displayName || req.user.email))
                ? String(req.user.displayName || req.user.email)
                : 'Teacher';

            const className = classDoc && classDoc.name ? String(classDoc.name) : 'Class';

            await Promise.all(
              studentIds.map((studentId) =>
                createNotification({
                  recipientId: studentId,
                  actorId: teacherId,
                  type: 'assignment_uploaded',
                  title: 'New assignment uploaded',
                  description: `${teacherDisplay} uploaded a new assignment in ${className}: ${created.title}`,
                  data: {
                    classId: String(classDoc._id),
                    assignmentId: String(created._id),
                    route: {
                      path: '/student/my-classes/detail',
                      params: [String(classDoc._id)]
                    }
                  }
                })
              )
            );
          } catch (err) {
            logger.warn('Failed to create student notifications for assignment');
          }
        });

        return sendSuccess(res, populated);
      } catch (err) {
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.qrToken) {
          continue;
        }
        throw err;
      }
    }

    return sendError(res, 500, 'Failed to generate unique qr token');
  } catch (err) {
    logger.error('Failed to create assignment');
    logger.error(err);
    return sendError(res, 500, 'Failed to create assignment');
  }
}

async function updateAssignment(req, res) {
  try {
    const { id } = req.params;
    const { title, writingType, instructions, rubric, rubrics, deadline, allowLateResubmission } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    if (typeof title !== 'undefined') {
      if (!isNonEmptyString(title)) {
        return sendError(res, 400, 'title must be a non-empty string');
      }
      assignment.title = title.trim();
    }

    if (typeof writingType !== 'undefined') {
      if (!isNonEmptyString(writingType)) {
        return sendError(res, 400, 'writingType must be a non-empty string');
      }
      assignment.writingType = writingType.trim();
    }

    if (typeof instructions !== 'undefined') {
      const normalizedInstructions = normalizeOptionalString(instructions);
      if (normalizedInstructions === null) {
        return sendError(res, 400, 'instructions must be a string');
      }
      assignment.instructions = normalizedInstructions;
    }

    if (typeof rubric !== 'undefined') {
      const normalizedRubric = normalizeRubric(rubric);
      if (normalizedRubric === null) {
        return sendError(res, 400, 'rubric must be valid text or JSON');
      }
      assignment.rubric = normalizedRubric;
    }

    if (typeof rubrics !== 'undefined') {
      const normalizedRubrics = normalizeRubrics(rubrics);
      if (normalizedRubrics === null) {
        return sendError(res, 400, 'rubrics must be valid JSON');
      }
      assignment.rubrics = normalizedRubrics;
    }

    if (typeof deadline !== 'undefined') {
      const parsedDeadline = toValidDate(deadline);
      if (!parsedDeadline) {
        return sendError(res, 400, 'deadline must be a valid date');
      }

      if (parsedDeadline.getTime() <= Date.now()) {
        return sendError(res, 400, 'deadline must be in the future');
      }

      assignment.deadline = parsedDeadline;
    }

    if (typeof allowLateResubmission !== 'undefined') {
      if (typeof allowLateResubmission !== 'boolean') {
        return sendError(res, 400, 'allowLateResubmission must be a boolean');
      }
      assignment.allowLateResubmission = allowLateResubmission;
    }

    const saved = await assignment.save();

    await Class.updateOne(
      { _id: assignment.class, teacher: teacherId, isActive: true },
      { $set: { updatedAt: new Date() } }
    );

    const populated = await Assignment.findById(saved._id)
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to update assignment');
  }
}

async function deleteAssignment(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    assignment.isActive = false;
    const saved = await assignment.save();

    await Class.updateOne(
      { _id: assignment.class, teacher: teacherId, isActive: true },
      { $set: { updatedAt: new Date() } }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to delete assignment');
  }
}

async function getClassAssignments(req, res) {
  try {
    const { classId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const classDoc = await Class.findOne({
      _id: classId,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 404, 'Class not found');
    }

    const assignments = await Assignment.find({
      class: classId,
      teacher: teacherId,
      isActive: true
    })
      .sort({ createdAt: -1 })
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, assignments);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignments');
  }
}

async function getAssignmentByIdForTeacher(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    })
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    return sendSuccess(res, assignment);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignment');
  }
}

async function generateRubricDesignerFromPrompt(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      teacher: teacherId,
      isActive: true
    });
    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prompt = safeString(body.prompt).trim();
    if (!prompt) {
      return sendError(res, 400, 'prompt is required');
    }

    const apiKey = safeString(process.env.OPENROUTER_API_KEY).trim();
    const baseUrl = safeString(process.env.OPENROUTER_BASE_URL).trim() || 'https://openrouter.ai/api/v1';
    const model = safeString(process.env.LLAMA_MODEL).trim() || 'meta-llama/llama-3-8b-instruct';

    if (!apiKey) {
      return sendError(res, 501, 'AI provider not configured');
    }

    const systemInstruction = 'You are an academic rubric generator. Return ONLY valid JSON with no explanation, no markdown, no code blocks.';

    const assignmentTitle = safeString(assignment.title).trim();
    const assignmentWritingType = safeString(assignment.writingType).trim();
    const assignmentInstructions = safeString(assignment.instructions).trim();
    const rubricTitle = `Rubric: ${assignmentTitle || 'Assignment'}`;

    const userPrompt = `${prompt}\n\nGenerate a rubric designer for grading student submissions for this assignment.\n\nAssignment Title: ${assignmentTitle || 'N/A'}\nAssignment Writing Type: ${assignmentWritingType || 'N/A'}\nAssignment Instructions: ${assignmentInstructions || 'N/A'}\n\nOutput must match this exact JSON structure:\n{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}.\nRules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. Keep criteria 3-10 rows. Keep maxPoints as integers. Make criteria relevant to the writing type. Use clear descriptions in cells for each performance level. Use title: ${rubricTitle}.`;

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
            { role: 'user', content: userPrompt }
          ]
        }),
        signal
      });
    } catch (err) {
      const name = err && typeof err === 'object' ? safeString(err.name) : '';
      const msg = err && typeof err === 'object' ? safeString(err.message) : '';
      if (name === 'AbortError' || /aborted/i.test(msg)) {
        return sendError(res, 504, 'AI request timed out. Please try again.');
      }
      return sendError(res, 502, msg || 'AI request failed');
    } finally {
      cancel();
    }

    if (!resp || !resp.ok) {
      let msg = 'Failed to generate rubric from prompt';
      let status = 502;
      try {
        const errJson = resp ? await resp.json() : null;
        const apiMsg = safeString(errJson && errJson.error && errJson.error.message).trim();
        if (apiMsg) msg = apiMsg;
      } catch {
        const errText = resp ? safeString(await resp.text()) : '';
        if (errText) msg = errText;
      }

      const sc = resp && typeof resp.status === 'number' ? resp.status : 0;
      if (sc === 429) {
        status = 429;
        msg = 'AI quota exceeded. Please try again later.';
      }
      return sendError(res, status, msg);
    }

    const json = await resp.json();
    const content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
    if (!content) {
      return sendError(res, 422, 'AI returned an empty response');
    }

    const cleaned = stripMarkdownCodeFences(content);
    const parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
    const normalized = normalizeRubricDesignerPayload(parsed);
    if (normalized.error || !normalized.value) {
      return sendError(res, 422, normalized.error || 'Invalid JSON rubric returned from AI');
    }

    const rubricDesigner = {
      ...normalized.value,
      title: normalized.value.title && String(normalized.value.title).trim().length ? normalized.value.title : rubricTitle
    };

    const sanitized = sanitizeRubricDesignerCriteria(rubricDesigner);
    return sendSuccess(res, sanitized);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric from prompt');
  }
}

async function getMyAssignments(req, res) {
  try {
    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const memberships = await Membership.find({
      student: studentId,
      status: 'active'
    }).populate({
      path: 'class',
      match: { isActive: true },
      populate: {
        path: 'teacher',
        select: '_id email displayName photoURL role'
      }
    });

    const classIds = memberships.filter((m) => m.class).map((m) => m.class._id);

    if (classIds.length === 0) {
      return sendSuccess(res, []);
    }

    const assignments = await Assignment.find({
      class: { $in: classIds },
      isActive: true
    })
      .sort({ deadline: 1 })
      .populate({
        path: 'class',
        populate: { path: 'teacher', select: '_id email displayName photoURL role' }
      })
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, assignments);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignments');
  }
}

async function getAssignmentById(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const assignment = await Assignment.findOne({
      _id: id,
      isActive: true
    })
      .populate({
        path: 'class',
        populate: { path: 'teacher', select: '_id email displayName photoURL role' }
      })
      .populate('teacher', '_id email displayName photoURL role');

    if (!assignment || !assignment.class || assignment.class.isActive === false) {
      return sendError(res, 404, 'Assignment not found');
    }

    const membership = await Membership.findOne({
      student: studentId,
      class: assignment.class._id,
      status: 'active'
    });

    if (!membership) {
      return sendError(res, 403, 'Forbidden');
    }

    return sendSuccess(res, assignment);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignment');
  }
}

module.exports = {
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getClassAssignments,
  getMyAssignments,
  getAssignmentById,
  getAssignmentByIdForTeacher,
  generateRubricDesignerFromPrompt
};
