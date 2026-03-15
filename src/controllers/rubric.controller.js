const fs = require('fs');

const rubricFileParserService = require('../services/rubricFileParser.service');
const rubricAIParserService = require('../services/rubricAIParser.service');
const rubricAIFormatterService = require('../services/rubricAIFormatter.service');

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
      console.warn('AI rubric formatting failed. Using parsed rubric.', aiError);
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

module.exports = {
  parseRubricFile,
  parseRubricTemplate
};
