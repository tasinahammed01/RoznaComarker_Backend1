const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');

const {
  RubricExcelTemplateError,
  parseRubricDesignerFromExcelTemplate
} = require('../services/rubricExcelTemplateParser.service');
const {
  RubricDocxTemplateError,
  parseRubricDesignerFromDocxTemplate
} = require('../services/docxRubricTemplateParser.service');

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

  const rawCriteriaCandidate = (Array.isArray(obj.criteria)
    ? obj.criteria
    : (obj.criteria && typeof obj.criteria === 'object' ? Object.values(obj.criteria) : null));

  const rawLevelsCandidate = (Array.isArray(obj.levels)
    ? obj.levels
    : (obj.levels && typeof obj.levels === 'object' ? Object.values(obj.levels) : null));

  // Some AI providers may return `levels` as an object or omit it while still providing criteria cells.
  // Attempt to infer the number of levels from the first criteria row's cell count.
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

  // Always coerce into an array. Never fail solely due to shape mismatches.
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

  // Ensure at least one criteria row exists
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

function rubricsToRubricDesigner({ rubrics, assignmentTitle }) {
  const obj = rubrics && typeof rubrics === 'object' ? rubrics : null;
  const criteriaRaw = Array.isArray(obj && obj.criteria) ? obj.criteria : [];
  if (!criteriaRaw.length) return null;

  const first = criteriaRaw[0] && typeof criteriaRaw[0] === 'object' ? criteriaRaw[0] : null;
  const levelsRaw = Array.isArray(first && first.levels) ? first.levels : [];
  if (!levelsRaw.length) return null;

  const levels = levelsRaw.map((l) => ({
    title: safeString(l && l.title).trim(),
    maxPoints: Number(l && l.score) || 0
  }));

  const criteria = criteriaRaw.map((c) => {
    const rowLevels = Array.isArray(c && c.levels) ? c.levels : [];
    return {
      title: safeString(c && c.name).trim(),
      cells: levels.map((_, i) => safeString(rowLevels[i] && rowLevels[i].description).trim())
    };
  });

  const at = safeString(assignmentTitle).trim();
  return {
    title: at ? `Rubric: ${at}` : 'Rubric',
    levels,
    criteria
  };
}

async function propagateAssignmentRubricToSubmissionFeedback({ assignmentId, rubricDesigner }) {
  if (!mongoose.Types.ObjectId.isValid(assignmentId)) return;
  const d = rubricDesigner && typeof rubricDesigner === 'object' ? rubricDesigner : null;
  if (!d) return;

  const submissions = await Submission.find({ assignment: assignmentId }).select('_id');
  const ids = (submissions || []).map((s) => s && s._id).filter(Boolean);
  if (!ids.length) return;

  await SubmissionFeedback.updateMany(
    {
      submissionId: { $in: ids },
      overriddenByTeacher: { $ne: true }
    },
    {
      $set: {
        rubricDesigner: d
      }
    }
  );
}

function normalizeMimeForRubricUpload(file) {
  const name = safeString(file && file.originalname).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const mimetype = safeString(file && file.mimetype).toLowerCase();

  if (ext === '.json') return 'application/json';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.pdf') return 'application/pdf';
  return mimetype;
}

function isAllowedRubricUploadMime(mime) {
  const m = safeString(mime).toLowerCase();
  return [
    'application/json',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ].includes(m);
}

async function uploadRubricFileForAssignment(req, res) {
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

    const file = req && req.file;
    if (!file || !file.buffer) {
      return sendError(res, 400, 'file is required');
    }

    const normalizedMime = normalizeMimeForRubricUpload(file);
    if (!isAllowedRubricUploadMime(normalizedMime)) {
      return sendError(res, 400, 'Invalid file type. Only PDF, DOCX, XLSX, and JSON are allowed.');
    }

    let rubricDesigner;
    const rubricTitle = `Rubric: ${safeString(assignment && assignment.title).trim() || 'Assignment'}`;

    if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        rubricDesigner = await parseRubricDesignerFromDocxTemplate({ buffer: file.buffer, title: rubricTitle });
      } catch (err) {
        if (err instanceof RubricDocxTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric DOCX template');
        }
        return sendError(res, 422, 'Invalid rubric DOCX template');
      }
    } else if (normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      try {
        rubricDesigner = parseRubricDesignerFromExcelTemplate({ buffer: file.buffer, title: rubricTitle });
      } catch (err) {
        if (err instanceof RubricExcelTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric Excel template');
        }
        return sendError(res, 422, 'Invalid rubric Excel template');
      }
    } else if (normalizedMime === 'application/json') {
      const raw = Buffer.isBuffer(file.buffer) ? file.buffer.toString('utf8') : '';
      const parsed = safeJsonParse(raw);
      const obj = parsed && typeof parsed === 'object' ? parsed : null;
      const levels = Array.isArray(obj && obj.levels) ? obj.levels : null;
      const criteria = Array.isArray(obj && obj.criteria) ? obj.criteria : null;
      if (!levels || !criteria) {
        return sendError(res, 422, 'Invalid rubric JSON file');
      }
      rubricDesigner = { ...obj, title: safeString(obj.title).trim() || rubricTitle };
    } else {
      return sendError(res, 501, 'PDF rubric import is not supported yet. Please upload DOCX, XLSX, or JSON.');
    }

    const converted = rubricDesignerToRubrics(rubricDesigner);
    if (!converted) {
      return sendError(res, 422, 'Invalid rubric format extracted from file');
    }

    const normalizedRubrics = normalizeRubrics(converted);
    if (normalizedRubrics === null) {
      return sendError(res, 422, 'Invalid rubric format extracted from file');
    }

    assignment.rubrics = normalizedRubrics;
    const saved = await assignment.save();

    try {
      const designer = rubricsToRubricDesigner({ rubrics: saved.rubrics, assignmentTitle: saved.title });
      await propagateAssignmentRubricToSubmissionFeedback({ assignmentId: saved._id, rubricDesigner: designer });
    } catch {
      // ignore propagation failures
    }

    await Class.updateOne(
      { _id: assignment.class, teacher: teacherId, isActive: true },
      { $set: { updatedAt: new Date() } }
    );

    const populated = await Assignment.findById(saved._id)
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to attach rubric file');
  }
}

function rubricDesignerToRubrics(value) {
  const d = value && typeof value === 'object' ? value : null;
  if (!d) return null;

  const rawLevels = Array.isArray(d.levels) ? d.levels : null;
  const rawCriteria = Array.isArray(d.criteria) ? d.criteria : null;
  if (!rawLevels || !rawCriteria) return null;

  const levels = rawLevels
    .map((l) => {
      const lvl = l && typeof l === 'object' ? l : {};
      const score = Number(lvl.maxPoints);
      return {
        title: safeString(lvl.title).trim(),
        score: Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0
      };
    })
    .slice(0, 10);

  const criteria = rawCriteria
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const name = safeString(row.title).trim();
      const cells = Array.isArray(row.cells) ? row.cells.map((x) => safeString(x)) : [];
      const mappedLevels = levels.map((lvl, i) => ({
        title: lvl.title,
        score: lvl.score,
        description: safeString(cells[i]).trim()
      }));
      return { name, levels: mappedLevels };
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

    try {
      if (typeof rubrics !== 'undefined') {
        const designer = rubricsToRubricDesigner({ rubrics: saved.rubrics, assignmentTitle: saved.title });
        await propagateAssignmentRubricToSubmissionFeedback({ assignmentId: saved._id, rubricDesigner: designer });
      }
    } catch {
      // ignore propagation failures
    }

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

async function updateAssignmentRubrics(req, res) {
  try {
    const { id } = req.params;
    const body = req.body && typeof body === 'object' ? req.body : {};

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

    let normalizedRubrics;
    if (typeof body.rubricDesigner !== 'undefined') {
      if (body.rubricDesigner === null) {
        normalizedRubrics = undefined;
      } else {
        const converted = rubricDesignerToRubrics(body.rubricDesigner);
        if (!converted) {
          return sendError(res, 400, 'rubricDesigner must be valid JSON');
        }
        normalizedRubrics = normalizeRubrics(converted);
      }
    } else {
      normalizedRubrics = normalizeRubrics(body.rubrics);
    }

    if (normalizedRubrics === null) {
      return sendError(res, 400, 'rubrics must be valid JSON');
    }

    assignment.rubrics = normalizedRubrics;
    const saved = await assignment.save();

    try {
      const designer = rubricsToRubricDesigner({ rubrics: saved.rubrics, assignmentTitle: saved.title });
      await propagateAssignmentRubricToSubmissionFeedback({ assignmentId: saved._id, rubricDesigner: designer });
    } catch {
      // ignore propagation failures
    }

    await Class.updateOne(
      { _id: assignment.class, teacher: teacherId, isActive: true },
      { $set: { updatedAt: new Date() } }
    );

    const populated = await Assignment.findById(saved._id)
      .populate('class')
      .populate('teacher', '_id email displayName photoURL role');

    return sendSuccess(res, populated);
  } catch (err) {
    return sendError(res, 500, 'Failed to update rubrics');
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

function isCompleteRubricDesigner(designer) {
  const d = designer && typeof designer === 'object' ? designer : null;
  if (!d) return false;
  const levels = Array.isArray(d.levels) ? d.levels : [];
  const criteria = Array.isArray(d.criteria) ? d.criteria : [];
  if (levels.length < 3 || levels.length > 6) return false;
  if (criteria.length < 3) return false;
  for (const row of criteria) {
    const cells = row && typeof row === 'object' && Array.isArray(row.cells) ? row.cells : [];
    if (cells.length !== levels.length) return false;
  }
  return true;
}

function buildRubricRetryPrompt(userPrompt) {
  return `${userPrompt}\n\nIMPORTANT: Your previous response was incomplete/truncated. Return the FULL JSON object only. No markdown, no comments, no trailing text.`;
}

function isLikelyTruncatedJson(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return false;
  if (!s.startsWith('{')) return false;

  // If braces/brackets aren't balanced, the model likely got cut off.
  let braces = 0;
  let brackets = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
  }

  return braces !== 0 || brackets !== 0 || !s.endsWith('}');
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

    const maxTokens = Math.min(8000, Math.max(1200, Number(process.env.OPENROUTER_MAX_TOKENS) || 4000));

    const doRequest = async (promptText) => fetchCompat(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: promptText }
        ]
      }),
      signal
    });

    let resp;
    try {
      resp = await doRequest(userPrompt);
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

    let content = '';
    let cleaned = '';
    let parsed = null;
    let normalized = { value: null };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const json = attempt === 0 ? await resp.json() : null;
      if (attempt > 0) {
        const { signal: signalN, cancel: cancelN } = buildTimeoutSignal(timeoutMs);
        try {
          const nextResp = await fetchCompat(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              max_tokens: maxTokens,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: buildRubricRetryPrompt(userPrompt) }
              ]
            }),
            signal: signalN
          });
          if (!nextResp || !nextResp.ok) break;
          const nextJson = await nextResp.json();
          content = safeString(nextJson && nextJson.choices && nextJson.choices[0] && nextJson.choices[0].message && nextJson.choices[0].message.content).trim();
        } catch {
          break;
        } finally {
          cancelN();
        }
      } else {
        content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
      }

      if (!content) {
        normalized = { error: 'AI returned an empty response' };
        break;
      }

      cleaned = stripMarkdownCodeFences(content);
      if (isLikelyTruncatedJson(cleaned)) {
        normalized = { error: 'AI returned truncated JSON' };
        logger.warn({
          message: 'AI rubric JSON appears truncated; retrying',
          assignmentId: id
        });
        continue;
      }
      parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
      if (!parsed || typeof parsed !== 'object') {
        logger.warn({
          message: 'AI rubric returned non-JSON object',
          assignmentId: id,
          contentPreview: content.slice(0, 800),
          cleanedPreview: cleaned.slice(0, 800)
        });
      }

      normalized = normalizeRubricDesignerPayload(parsed);
      const candidate = normalized && normalized.value ? normalized.value : null;
      if (normalized.error || !candidate) break;
      if (isCompleteRubricDesigner(candidate)) break;

      logger.warn({
        message: attempt === 0 ? 'AI rubric incomplete; retrying' : 'AI rubric still incomplete; retrying',
        assignmentId: id
      });
    }

    if (normalized.error || !normalized.value) {
      logger.warn({
        message: 'AI rubric normalization failed',
        assignmentId: id,
        error: normalized.error,
        parsedType: parsed === null ? 'null' : typeof parsed,
        parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 50) : [],
        contentPreview: content.slice(0, 800),
        cleanedPreview: cleaned.slice(0, 800)
      });
      return sendError(res, 422, normalized.error || 'Invalid JSON rubric returned from AI');
    }

    if (!isCompleteRubricDesigner(normalized.value)) {
      return sendError(res, 422, 'AI returned an incomplete rubric. Please try again.');
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
  updateAssignmentRubrics,
  deleteAssignment,
  getClassAssignments,
  getMyAssignments,
  getAssignmentById,
  getAssignmentByIdForTeacher,
  generateRubricDesignerFromPrompt,
  uploadRubricFileForAssignment
};
