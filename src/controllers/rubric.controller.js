const fs = require('fs');

const rubricFileParserService = require('../services/rubricFileParser.service');
const rubricAIParserService = require('../services/rubricAIParser.service');
const rubricAIFormatterService = require('../services/rubricAIFormatter.service');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const Assignment = require('../models/assignment.model');
const SavedRubric = require('../models/savedRubric.model');
const {
  cloneRubricData,
  normalizeRubricData,
  normalizeRubricFromAssignment,
  normalizeMetadata,
  validateRubricData
} = require('../utils/savedRubricNormalizer');

const {
  RubricDocxTemplateError,
  parseRubricDesignerFromDocxTemplate
} = require('../services/docxRubricTemplateParser.service');

const {
  RubricExcelTemplateError,
  parseRubricDesignerFromExcelTemplate
} = require('../services/rubricExcelTemplateParser.service');

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function tryDeleteUploadedFile(file) {
  try {
    if (file && file.path) {
      fs.unlink(file.path, () => {});
    }
  } catch {
    // ignore
  }
}

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function getUploadedFileExtension(file) {
  const name = safeString(file && file.originalname).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return ext;
}

function isSupportedRubricTemplateExtension(ext) {
  const e = String(ext || '').toLowerCase();
  return e === '.docx' || e === '.xlsx';
}

async function parseRubricTemplate(req, res) {
  const file = req && req.file;

  if (!file) {
    return sendError(res, 400, 'file is required');
  }

  try {
    const ext = getUploadedFileExtension(file);
    if (!isSupportedRubricTemplateExtension(ext)) {
      return sendError(res, 400, 'Unsupported file type. Only DOCX and XLSX rubric templates are allowed.');
    }

    if (!file.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      return sendError(res, 400, 'Invalid file');
    }

    const defaultTitle = 'Rubric';

    let parsedRubricDesigner;
    if (ext === '.docx') {
      try {
        parsedRubricDesigner = await parseRubricDesignerFromDocxTemplate({
          buffer: file.buffer,
          title: defaultTitle
        });
      } catch (err) {
        if (err instanceof RubricDocxTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric DOCX template');
        }
        return sendError(res, 422, 'Invalid rubric DOCX template');
      }
    } else if (ext === '.xlsx') {
      try {
        parsedRubricDesigner = parseRubricDesignerFromExcelTemplate({
          buffer: file.buffer,
          title: defaultTitle
        });
      } catch (err) {
        if (err instanceof RubricExcelTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric Excel template');
        }
        return sendError(res, 422, 'Invalid rubric Excel template');
      }
    } else {
      return sendError(res, 400, 'Unsupported file type');
    }

    let formattedRubric;
    try {
      formattedRubric = await rubricAIFormatterService.formatRubricFromTemplateParsed({
        parsedRubric: parsedRubricDesigner
      });
    } catch (aiError) {
      logger.warn(`AI rubric formatting failed. Using parsed rubric. ${aiError && aiError.message ? aiError.message : aiError}`);
      formattedRubric = parsedRubricDesigner;
    }

    return res.json({
      success: true,
      rubric: formattedRubric
    });
  } catch (err) {
    const statusCode = err && typeof err === 'object' && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    const message = err && typeof err === 'object' && err.message ? String(err.message) : 'Failed to parse rubric template';
    return sendError(res, statusCode, message);
  } finally {
    tryDeleteUploadedFile(file);
  }
}

async function parseRubricFile(req, res) {
  const file = req && req.file;

  if (!file) {
    return sendError(res, 400, 'file is required');
  }

  try {
    const normalizedText = await rubricFileParserService.extractRubricTextFromUploadedFile(file);
    if (!normalizedText || !String(normalizedText).trim().length) {
      return sendError(res, 422, 'Could not extract any text from the uploaded rubric file');
    }

    const parsed = await rubricAIParserService.parseRubricTextToJson({
      text: normalizedText
    });

    return sendSuccess(res, parsed);
  } catch (err) {
    const statusCode = err && typeof err === 'object' && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    const message = err && typeof err === 'object' && err.message ? String(err.message) : 'Failed to parse rubric file';
    return sendError(res, statusCode, message);
  } finally {
    tryDeleteUploadedFile(file);
  }
}

function teacherId(req) {
  return req?.user?._id || null;
}

function validateLibraryPayload(body, { partial = false, requireRubric = true } = {}) {
  const metadata = normalizeMetadata(body, { partial });
  const errors = [...metadata.errors];
  let rubricData;
  if (requireRubric || Object.prototype.hasOwnProperty.call(body || {}, 'rubricData')) {
    rubricData = normalizeRubricData(body?.rubricData);
    errors.push(...validateRubricData(rubricData));
  }
  return { metadata: metadata.value, rubricData, errors: [...new Set(errors)] };
}

async function listSavedRubrics(req, res) {
  const filter = { teacher: teacherId(req) };
  if (String(req.query.includeArchived || '').toLowerCase() !== 'true') filter.isActive = true;
  const search = String(req.query.search || '').trim();
  if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const rubrics = await SavedRubric.find(filter).sort({ updatedAt: -1, _id: -1 }).lean();
  return sendSuccess(res, rubrics);
}

async function getSavedRubric(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 400, 'Invalid rubric id');
  const rubric = await SavedRubric.findOne({ _id: req.params.id, teacher: teacherId(req) }).lean();
  if (!rubric) return sendError(res, 404, 'Saved rubric not found');
  return sendSuccess(res, rubric);
}

async function createSavedRubric(req, res) {
  const validated = validateLibraryPayload(req.body || {});
  if (validated.errors.length) return res.status(400).json({ success: false, message: validated.errors[0], errors: validated.errors });
  const rubric = await SavedRubric.create({
    teacher: teacherId(req), ...validated.metadata, rubricData: cloneRubricData(validated.rubricData)
  });
  return res.status(201).json({ success: true, data: rubric });
}

async function createSavedRubricFromAssignment(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.assignmentId)) return sendError(res, 400, 'Invalid assignment id');
  const metadata = normalizeMetadata(req.body || {});
  if (metadata.errors.length) return res.status(400).json({ success: false, message: metadata.errors[0], errors: metadata.errors });
  const assignment = await Assignment.findOne({ _id: req.params.assignmentId, teacher: teacherId(req), isActive: true }).lean();
  if (!assignment) return sendError(res, 404, 'Assignment not found');
  const rubricData = normalizeRubricFromAssignment(assignment);
  const errors = validateRubricData(rubricData);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  const rubric = await SavedRubric.create({
    teacher: teacherId(req), ...metadata.value,
    writingType: metadata.value.writingType || assignment.writingType || undefined,
    sourceAssignmentId: assignment._id,
    rubricData: cloneRubricData(rubricData)
  });
  return res.status(201).json({ success: true, data: rubric });
}

async function updateSavedRubric(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 400, 'Invalid rubric id');
  const validated = validateLibraryPayload(req.body || {}, { partial: true, requireRubric: false });
  if (validated.errors.length) return res.status(400).json({ success: false, message: validated.errors[0], errors: validated.errors });
  const update = { ...validated.metadata };
  if (validated.rubricData) update.rubricData = cloneRubricData(validated.rubricData);
  const rubric = await SavedRubric.findOneAndUpdate(
    { _id: req.params.id, teacher: teacherId(req) }, { $set: update }, { returnDocument: 'after', runValidators: true }
  );
  if (!rubric) return sendError(res, 404, 'Saved rubric not found');
  return sendSuccess(res, rubric);
}

async function duplicateSavedRubric(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 400, 'Invalid rubric id');
  const source = await SavedRubric.findOne({ _id: req.params.id, teacher: teacherId(req) }).lean();
  if (!source) return sendError(res, 404, 'Saved rubric not found');
  const rubric = await SavedRubric.create({
    teacher: teacherId(req), name: `${source.name} - Copy`.slice(0, 120),
    description: source.description, writingType: source.writingType,
    rubricData: cloneRubricData(source.rubricData), isActive: true
  });
  return res.status(201).json({ success: true, data: rubric });
}

async function archiveSavedRubric(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 400, 'Invalid rubric id');
  const rubric = await SavedRubric.findOneAndUpdate(
    { _id: req.params.id, teacher: teacherId(req) },
    { $set: { isActive: false, archivedAt: new Date() } }, { returnDocument: 'after' }
  );
  if (!rubric) return sendError(res, 404, 'Saved rubric not found');
  return sendSuccess(res, rubric);
}

module.exports = {
  parseRubricFile,
  parseRubricTemplate,
  listSavedRubrics,
  getSavedRubric,
  createSavedRubric,
  createSavedRubricFromAssignment,
  updateSavedRubric,
  duplicateSavedRubric,
  archiveSavedRubric
};
