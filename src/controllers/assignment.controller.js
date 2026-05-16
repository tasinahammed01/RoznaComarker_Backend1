const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const FlashcardSubmission = require('../models/FlashcardSubmission');
const FlashcardSet = require('../models/FlashcardSet');
const WorksheetSubmission = require('../models/WorksheetSubmission');
const Worksheet = require('../models/Worksheet');
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
const { normalizeRubricDesignerPayload } = require('../utils/rubricNormalizer');
const { repairAiRubric } = require('../utils/aiRubricRepair');

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

async function filterAssignmentsWithAvailableResources(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return [];
  }

  const flashcardAssignments = assignments.filter((assignment) => assignment && assignment.resourceType === 'flashcard');
  const worksheetAssignments = assignments.filter((assignment) => assignment && assignment.resourceType === 'worksheet');
  
  if (flashcardAssignments.length === 0 && worksheetAssignments.length === 0) {
    return assignments;
  }

  const staleAssignmentIds = [];
  const filteredAssignments = [];

  // Filter flashcard assignments
  if (flashcardAssignments.length > 0) {
    const flashcardResourceIds = Array.from(new Set(
      flashcardAssignments
        .map((assignment) => safeString(assignment.resourceId).trim())
        .filter((resourceId) => resourceId.length > 0 && mongoose.Types.ObjectId.isValid(resourceId))
    ));

    const existingSetIds = new Set();
    if (flashcardResourceIds.length > 0) {
      const sets = await FlashcardSet.find({ _id: { $in: flashcardResourceIds } }).select('_id').lean();
      for (const set of sets || []) {
        existingSetIds.add(String(set._id));
      }
    }

    for (const assignment of flashcardAssignments) {
      const resourceId = safeString(assignment.resourceId).trim();
      const hasValidResource = resourceId.length > 0
        && mongoose.Types.ObjectId.isValid(resourceId)
        && existingSetIds.has(resourceId);

      if (!hasValidResource) {
        if (assignment._id) {
          staleAssignmentIds.push(assignment._id);
        }
        continue;
      }

      filteredAssignments.push(assignment);
    }
  }

  // Filter worksheet assignments
  if (worksheetAssignments.length > 0) {
    const worksheetResourceIds = Array.from(new Set(
      worksheetAssignments
        .map((assignment) => safeString(assignment.resourceId).trim())
        .filter((resourceId) => resourceId.length > 0 && mongoose.Types.ObjectId.isValid(resourceId))
    ));

    const existingWorksheetIds = new Set();
    if (worksheetResourceIds.length > 0) {
      const worksheets = await Worksheet.find({ _id: { $in: worksheetResourceIds } }).select('_id').lean();
      for (const ws of worksheets || []) {
        existingWorksheetIds.add(String(ws._id));
      }
    }

    for (const assignment of worksheetAssignments) {
      const resourceId = safeString(assignment.resourceId).trim();
      const hasValidResource = resourceId.length > 0
        && mongoose.Types.ObjectId.isValid(resourceId)
        && existingWorksheetIds.has(resourceId);

      if (!hasValidResource) {
        if (assignment._id) {
          staleAssignmentIds.push(assignment._id);
        }
        continue;
      }

      filteredAssignments.push(assignment);
    }
  }

  // Include non-resource assignments (essay type)
  for (const assignment of assignments) {
    if (!assignment || assignment.resourceType !== 'flashcard' && assignment.resourceType !== 'worksheet') {
      filteredAssignments.push(assignment);
    }
  }

  if (staleAssignmentIds.length > 0) {
    await Assignment.updateMany(
      { _id: { $in: staleAssignmentIds }, isActive: true },
      { $set: { isActive: false } }
    );

    logger.warn({
      message: 'Deactivated stale assignments with missing resources',
      assignmentIds: staleAssignmentIds.map((id) => String(id))
    });
  }

  return filteredAssignments;
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
            score: Number.isFinite(score) ? score : 1,
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

  const rawLevels = Array.isArray(d.levels)
    ? d.levels
    : (d.levels && typeof d.levels === 'object' ? Object.values(d.levels) : null);

  const rawCriteria = Array.isArray(d.criteria)
    ? d.criteria
    : (d.criteria && typeof d.criteria === 'object' ? Object.values(d.criteria) : null);

  if (!Array.isArray(rawCriteria)) return null;

  let levelsSource = rawLevels;
  if (!Array.isArray(levelsSource)) {
    const firstRow = rawCriteria[0] && typeof rawCriteria[0] === 'object' ? rawCriteria[0] : null;
    const rawCells = firstRow && (Array.isArray(firstRow.cells)
      ? firstRow.cells
      : (firstRow.cells && typeof firstRow.cells === 'object' ? Object.values(firstRow.cells) : null));

    const count = Array.isArray(rawCells) && rawCells.length
      ? Math.min(6, Math.max(1, rawCells.length))
      : 4;

    levelsSource = Array.from({ length: count }).map(() => ({ title: '', maxPoints: 0 }));
  }

  const levels = (levelsSource || [])
    .map((l) => {
      const lvl = l && typeof l === 'object' ? l : {};
      const score = Number(lvl.maxPoints);
      return {
        title: safeString(lvl.title).trim(),
        score: Number.isFinite(score) ? Math.max(1, Math.floor(score)) : 1
      };
    })
    .slice(0, 10);

  const criteria = rawCriteria
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const name = safeString(row.title).trim();
      const rawCells = Array.isArray(row.cells)
        ? row.cells
        : (row.cells && typeof row.cells === 'object' ? Object.values(row.cells) : []);
      const cells = Array.isArray(rawCells) ? rawCells.map((x) => safeString(x)) : [];

      // Ensure cell count matches level count (pad with empty strings or truncate).
      const normalizedCells = cells.slice(0, levels.length);
      while (normalizedCells.length < levels.length) normalizedCells.push('');
      const mappedLevels = levels.map((lvl, i) => ({
        title: lvl.title,
        score: lvl.score,
        description: safeString(normalizedCells[i]).trim()
      }));
      return { name, levels: mappedLevels };
    })
    .filter((c) => c && typeof c.name === 'string')
    .slice(0, 100);

  return { criteria };
}

async function createAssignment(req, res) {
  try {
    const {
      title, writingType, instructions, rubric, rubrics, deadline,
      classId, allowLateResubmission,
      /** PART 1 — resource fields for flashcard / worksheet assignments */
      resourceType, resourceId
    } = req.body || {};

    if (!isNonEmptyString(title)) {
      return sendError(res, 400, 'title is required');
    }

    const resolvedResourceType = resourceType || 'essay';
    if (!['essay', 'flashcard', 'worksheet'].includes(resolvedResourceType)) {
      return sendError(res, 400, 'resourceType must be essay, flashcard, or worksheet');
    }

    const resolvedWritingType = writingType || (resolvedResourceType !== 'essay' ? resolvedResourceType : null);
    if (!isNonEmptyString(resolvedWritingType)) {
      return sendError(res, 400, 'writingType is required for essay assignments');
    }

    if (resolvedResourceType !== 'essay' && !isNonEmptyString(resourceId)) {
      return sendError(res, 400, 'resourceId is required for flashcard/worksheet assignments');
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
          writingType: resolvedWritingType.trim(),
          resourceType: resolvedResourceType,
          resourceId: resourceId || null,
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
            const typeLabel = created.resourceType === 'flashcard' ? 'flashcard set'
              : created.resourceType === 'worksheet' ? 'worksheet' : 'assignment';

            await Promise.all(
              studentIds.map((studentId) =>
                createNotification({
                  recipientId: studentId,
                  actorId: teacherId,
                  type: 'assignment_uploaded',
                  title: `New ${typeLabel} assigned`,
                  description: `${teacherDisplay} assigned a new ${typeLabel} in ${className}: ${created.title}`,
                  data: {
                    classId: String(classDoc._id),
                    assignmentId: String(created._id),
                    resourceType: created.resourceType,
                    resourceId: created.resourceId || null,
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
    const body = req.body && typeof req.body === 'object' ? req.body : {};

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

    // Helper: coerce any rubric-ish payload into an object (supports JSON string inputs).
    const coerceObjectPayload = (value) => {
      if (value == null) return value;
      if (typeof value === 'string') {
        const parsed = safeJsonParse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
      }
      return typeof value === 'object' ? value : null;
    };

    let normalizedRubrics;

    if (typeof body.rubricDesigner !== 'undefined') {
      // rubricDesigner payload (AI or manual).
      if (body.rubricDesigner === null) {
        normalizedRubrics = undefined;
      } else {
        const rawDesigner = coerceObjectPayload(body.rubricDesigner);
        if (!rawDesigner) {
          return sendError(res, 400, 'rubricDesigner must be valid JSON');
        }

        // Repair and normalize rubric designer shape.
        const repaired = repairAiRubric(rawDesigner);
        const normalizedDesigner = normalizeRubricDesignerPayload(repaired || rawDesigner);

        // Enforce criteria/levels/cells array invariants and cells alignment.
        const safeLevels = Array.isArray(normalizedDesigner.levels) ? normalizedDesigner.levels : [];
        const safeCriteria = Array.isArray(normalizedDesigner.criteria) ? normalizedDesigner.criteria : [];

        const cleanedDesigner = {
          title: safeString(normalizedDesigner.title).trim(),
          levels: safeLevels.map((l) => {
            const lvl = l && typeof l === 'object' ? l : {};
            const maxPoints = Number(lvl.maxPoints);
            return {
              title: safeString(lvl.title).trim(),
              maxPoints: Number.isFinite(maxPoints) ? Math.max(1, Math.floor(maxPoints)) : 1
            };
          }),
          criteria: safeCriteria.map((c) => {
            const row = c && typeof c === 'object' ? c : {};
            const rawCells = Array.isArray(row.cells)
              ? row.cells
              : (row.cells && typeof row.cells === 'object' ? Object.values(row.cells) : []);
            const cells = Array.isArray(rawCells) ? rawCells.map((x) => safeString(x)) : [];
            const normalizedCells = cells.slice(0, safeLevels.length);
            while (normalizedCells.length < safeLevels.length) normalizedCells.push('');
            return {
              title: safeString(row.title || row.name).trim() || 'Criteria',
              cells: normalizedCells
            };
          })
        };

        const converted = rubricDesignerToRubrics(cleanedDesigner);
        if (!converted) {
          return sendError(res, 400, 'rubricDesigner must be valid JSON');
        }

        normalizedRubrics = normalizeRubrics(converted);
      }
    } else {
      // Legacy rubrics payload.
      const rawRubrics = coerceObjectPayload(body.rubrics);
      normalizedRubrics = normalizeRubrics(rawRubrics);
    }

    if (normalizedRubrics === null) {
      return sendError(res, 400, 'rubrics must be valid JSON');
    }

    // Log final rubrics payload going into MongoDB for production debugging.
    logger.debug(`Normalized Rubrics: ${JSON.stringify(normalizedRubrics, null, 2)}`);

    assignment.rubrics = normalizedRubrics;

    let saved;
    try {
      saved = await assignment.save();
    } catch (err) {
      logger.error(`Failed to save assignment rubrics: ${err && err.message ? err.message : err}`);
      return sendError(res, 500, 'Failed to update rubrics');
    }

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

    const resourceType = safeString(assignment.resourceType).trim();
    const resourceId = safeString(assignment.resourceId).trim();
    const classId = assignment.class ? String(assignment.class) : '';

    if (
      resourceType === 'flashcard'
      && resourceId.length > 0
      && mongoose.Types.ObjectId.isValid(resourceId)
      && classId.length > 0
      && mongoose.Types.ObjectId.isValid(classId)
    ) {
      const hasOtherActiveAssignments = await Assignment.exists({
        _id: { $ne: assignment._id },
        resourceType: 'flashcard',
        resourceId,
        class: classId,
        isActive: true
      });

      if (!hasOtherActiveAssignments) {
        await FlashcardSet.updateOne(
          { _id: resourceId },
          { $pull: { assignedClasses: assignment.class } }
        );
      }
    }

    // Cascade delete submissions tied to this assignment
    try {
      if (resourceType === 'flashcard') {
        await FlashcardSubmission.deleteMany({ assignmentId: assignment._id });
      } else if (resourceType === 'worksheet') {
        await WorksheetSubmission.deleteMany({ assignmentId: assignment._id });
      } else {
        await Submission.deleteMany({ assignment: assignment._id });
      }
    } catch (cascadeErr) {
      logger.warn('deleteAssignment: cascade submissions delete failed', cascadeErr);
    }

    await Class.updateOne(
      { _id: assignment.class, teacher: teacherId, isActive: true },
      { $set: { updatedAt: new Date() } }
    );

    setImmediate(async () => {
      try {
        const memberships = await Membership.find({ class: assignment.class, status: 'active' }).select('student').lean();
        const classDoc = await Class.findById(assignment.class).select('name').lean();
        const studentIds = (memberships || []).map((m) => m && m.student).filter(Boolean);
        const teacherDisplay = String(req.user.displayName || req.user.email || 'Teacher');
        const className = classDoc && classDoc.name ? String(classDoc.name) : 'Class';
        const typeLabel = resourceType === 'flashcard' ? 'flashcard set'
          : resourceType === 'worksheet' ? 'worksheet' : 'assignment';

        await Promise.all(studentIds.map((studentId) =>
          createNotification({
            recipientId: studentId,
            actorId: teacherId,
            type: 'assignment_removed',
            title: `${assignment.title} removed`,
            description: `${teacherDisplay} removed a ${typeLabel} from ${className}: ${assignment.title}`,
            data: {
              classId: String(assignment.class),
              assignmentId: String(assignment._id),
              resourceType: resourceType || null,
              resourceId: resourceId || null,
              route: { path: '/student/my-classes/detail', params: [String(assignment.class)] }
            }
          })
        ));
      } catch (err) {
        logger.warn('deleteAssignment: notification error', err);
      }
    });

    return sendSuccess(res, saved);
  } catch (err) {
    logger.error('deleteAssignment failed', err);
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

    const filteredAssignments = await filterAssignmentsWithAvailableResources(assignments);

    // Add submission counts for each assignment
    const assignmentsWithCounts = await Promise.all(
      filteredAssignments.map(async (assignment) => {
        let submittedCount = 0;
        
        if (assignment.resourceType === 'essay') {
          submittedCount = await Submission.countDocuments({
            assignmentId: assignment._id
          });
        } else if (assignment.resourceType === 'flashcard') {
          submittedCount = await FlashcardSubmission.countDocuments({
            assignmentId: assignment._id
          });
        } else if (assignment.resourceType === 'worksheet') {
          submittedCount = await WorksheetSubmission.countDocuments({
            assignmentId: assignment._id
          });
        }

        return {
          ...assignment.toObject(),
          submitted: submittedCount
        };
      })
    );

    return sendSuccess(res, assignmentsWithCounts);
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

    const [filteredAssignment] = await filterAssignmentsWithAvailableResources([assignment]);
    if (!filteredAssignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    return sendSuccess(res, filteredAssignment);
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

    const systemInstruction = `
You are a rubric generator.

Return ONLY valid JSON.

DO NOT include:
- explanations
- markdown
- code blocks
- comments

The JSON MUST match this structure EXACTLY:

{
 "title": "string",
 "levels": [
   { "title": "string", "maxPoints": number }
 ],
 "criteria": [
   { "title": "string", "cells": ["string"] }
 ]
}

Rules:
- levels must be an ARRAY
- criteria must be an ARRAY
- cells must be an ARRAY
- cells length MUST equal levels length
- levels must be 3-5 items
- criteria must be 3-10 rows
`;

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
    let normalized = null;
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

      const repaired = repairAiRubric(parsed);

      normalized = normalizeRubricDesignerPayload(repaired || parsed);
      if (!normalized || typeof normalized !== 'object') break;

      if (isCompleteRubricDesigner(normalized)) break;

      logger.warn({
        message: attempt === 0 ? 'AI rubric incomplete; retrying' : 'AI rubric still incomplete; retrying',
        assignmentId: id
      });
    }

    if (!normalized || typeof normalized !== 'object') {
      logger.warn({
        message: 'AI rubric normalization failed',
        assignmentId: id,
        error: 'invalid_rubric_shape_after_normalize',
        parsedType: parsed === null ? 'null' : typeof parsed,
        parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 50) : [],
        contentPreview: content.slice(0, 800),
        cleanedPreview: cleaned.slice(0, 800)
      });
      return sendError(res, 422, 'Invalid JSON rubric returned from AI');
    }

    if (!isCompleteRubricDesigner(normalized)) {
      return sendError(res, 422, 'AI returned an incomplete rubric. Please try again.');
    }

    let rubricDesigner = {
      ...normalized,
      title: normalized.title && String(normalized.title).trim().length ? normalized.title : rubricTitle
    };

    rubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

    rubricDesigner = normalizeRubricDesignerPayload(rubricDesigner);

    return res.json({
      success: true,
      data: rubricDesigner
    });
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

    const filteredAssignments = await filterAssignmentsWithAvailableResources(assignments);

    return sendSuccess(res, filteredAssignments);
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

    const [filteredAssignment] = await filterAssignmentsWithAvailableResources([assignment]);
    if (!filteredAssignment || !filteredAssignment.class || filteredAssignment.class.isActive === false) {
      return sendError(res, 404, 'Assignment not found');
    }

    const membership = await Membership.findOne({
      student: studentId,
      class: filteredAssignment.class._id,
      status: 'active'
    });

    if (!membership) {
      return sendError(res, 403, 'Forbidden');
    }

    return sendSuccess(res, filteredAssignment);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch assignment');
  }
}

/**
 * POST /api/assignments/:id/submit — student submits a flashcard assignment result.
 * @param {string} req.params.id — assignmentId
 * @param {number} req.body.score — percentage 0-100
 * @param {number} req.body.timeTaken — seconds
 * @param {Array}  req.body.results — array of { cardId, status }
 * @returns {object} FlashcardSubmission document
 */
async function submitFlashcardAssignment(req, res) {
  try {
    const { id: assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) return sendError(res, 401, 'Unauthorized');

    const assignment = await Assignment.findOne({ _id: assignmentId, isActive: true });
    if (!assignment || assignment.resourceType !== 'flashcard') {
      return sendError(res, 404, 'Flashcard assignment not found');
    }

    const [filteredAssignment] = await filterAssignmentsWithAvailableResources([assignment]);
    if (!filteredAssignment || filteredAssignment.resourceType !== 'flashcard') {
      return sendError(res, 404, 'Flashcard assignment not found');
    }

    const membership = await Membership.findOne({ student: studentId, class: filteredAssignment.class, status: 'active' });
    if (!membership) return sendError(res, 403, 'Not enrolled in this class');

    const existing = await FlashcardSubmission.findOne({ assignmentId, userId: studentId });
    const { score, timeTaken, results, completedAt, template, totalCards, cardResults } = req.body || {};
    const resolvedTemplate = ['term-def', 'qa', 'concept'].includes(template) ? template : 'term-def';

    let sub;
    if (existing) {
      sub = await FlashcardSubmission.findOneAndUpdate(
        { assignmentId, userId: studentId },
        {
          score:       typeof score === 'number' ? score : 0,
          timeTaken:   typeof timeTaken === 'number' ? timeTaken : 0,
          results:     Array.isArray(results) ? results : [],
          template:    resolvedTemplate,
          totalCards:  typeof totalCards === 'number' ? totalCards : undefined,
          cardResults: Array.isArray(cardResults) ? cardResults : [],
          submittedAt: completedAt ? new Date(completedAt) : new Date()
        },
        { new: true }
      );
    } else {
      sub = await FlashcardSubmission.create({
        flashcardSetId: filteredAssignment.resourceId,
        userId: studentId,
        assignmentId,
        score:       typeof score === 'number' ? score : 0,
        timeTaken:   typeof timeTaken === 'number' ? timeTaken : 0,
        results:     Array.isArray(results) ? results : [],
        template:    resolvedTemplate,
        totalCards:  typeof totalCards === 'number' ? totalCards : undefined,
        cardResults: Array.isArray(cardResults) ? cardResults : [],
        submittedAt: completedAt ? new Date(completedAt) : new Date()
      });
    }

    setImmediate(async () => {
      try {
        const teacherId = filteredAssignment && filteredAssignment.teacher ? String(filteredAssignment.teacher) : '';
        if (!teacherId || !mongoose.Types.ObjectId.isValid(teacherId)) {
          return;
        }

        const studentDisplay = String(req.user?.displayName || req.user?.email || 'Student');
        const assignmentTitle = String(filteredAssignment.title || 'Flashcard assignment');

        await createNotification({
          recipientId: teacherId,
          actorId: studentId,
          type: 'assignment_submitted',
          title: 'Assignment submitted',
          description: `${studentDisplay} submitted ${assignmentTitle}`,
          data: {
            classId: String(filteredAssignment.class || ''),
            assignmentId: String(filteredAssignment._id || assignmentId),
            submissionId: String(sub._id || ''),
            studentId: String(studentId || ''),
            route: {
              path: '/flashcards',
              params: [String(filteredAssignment.resourceId || ''), 'report'],
              queryParams: {
                assignmentId: String(filteredAssignment._id || assignmentId)
              }
            }
          }
        });
      } catch (notifyErr) {
        logger.warn('submitFlashcardAssignment notification error', notifyErr);
      }
    });

    return sendSuccess(res, sub);
  } catch (err) {
    logger.error('submitFlashcardAssignment error:', err);
    return sendError(res, 500, 'Failed to submit assignment');
  }
}

/**
 * GET /api/assignments/:id/my-submission — student checks if they already submitted.
 * @param {string} req.params.id — assignmentId
 * @returns {object} FlashcardSubmission document or 404
 */
async function getMyFlashcardSubmission(req, res) {
  try {
    const { id: assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) return sendError(res, 401, 'Unauthorized');

    const sub = await FlashcardSubmission.findOne({ assignmentId, userId: studentId }).lean();
    if (!sub) return sendSuccess(res, null);

    const set = await FlashcardSet.findById(sub.flashcardSetId).select('cards template').lean();
    const cards = set
      ? (set.cards || []).map(c => ({ _id: String(c._id), front: c.front, back: c.back, template: c.template }))
      : [];

    return sendSuccess(res, { ...sub, cards, template: sub.template || set?.template || 'term-def' });
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submission');
  }
}

/**
 * GET /api/assignments/:id/submissions — teacher views all submissions for a flashcard assignment.
 * @param {string} req.params.id — assignmentId
 * @returns {Array} array of submissions populated with user info
 */
async function getFlashcardAssignmentSubmissions(req, res) {
  try {
    const { id: assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) return sendError(res, 401, 'Unauthorized');

    const assignment = await Assignment.findOne({ _id: assignmentId, teacher: teacherId, isActive: true });
    if (!assignment) return sendError(res, 404, 'Assignment not found');

    const subs = await FlashcardSubmission.find({ assignmentId })
      .populate('userId', '_id email displayName photoURL')
      .sort({ submittedAt: -1 });

    return sendSuccess(res, subs);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch submissions');
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
  uploadRubricFileForAssignment,
  submitFlashcardAssignment,
  getMyFlashcardSubmission,
  getFlashcardAssignmentSubmissions
};
