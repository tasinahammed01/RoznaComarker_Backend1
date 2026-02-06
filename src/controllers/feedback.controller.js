const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const File = require('../models/File');

const uploadService = require('../services/upload.service');
const { buildOcrCorrections } = require('../services/ocrCorrections.service');
const { normalizeOcrWordsFromStored } = require('../services/ocrCorrections.service');
const { computeAcademicEvaluation } = require('../modules/academicEvaluationEngine');

const { bytesToMB, incrementUsage } = require('../middlewares/usage.middleware');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function clampScore5(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(5, v));
}

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function normalizeAiFeedbackPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const textAnnotations = Array.isArray(obj.textAnnotations) ? obj.textAnnotations : [];
  const rubricScores = obj.rubricScores && typeof obj.rubricScores === 'object' ? obj.rubricScores : {};

  const outScores = {
    CONTENT: clampScore5(rubricScores.CONTENT),
    ORGANIZATION: clampScore5(rubricScores.ORGANIZATION),
    GRAMMAR: clampScore5(rubricScores.GRAMMAR),
    VOCABULARY: clampScore5(rubricScores.VOCABULARY),
    MECHANICS: clampScore5(rubricScores.MECHANICS)
  };

  const outAnnotations = textAnnotations
    .map((a) => ({
      text: safeString(a && a.text).trim(),
      category: safeString(a && a.category).trim(),
      color: safeString(a && a.color).trim(),
      explanation: safeString(a && a.explanation).trim()
    }))
    .filter((a) => a.text.length && a.category.length);

  return {
    textAnnotations: outAnnotations,
    rubricScores: outScores,
    generalComments: safeString(obj.generalComments).trim()
  };
}

function legendColorForCategory(category) {
  switch (String(category || '').toUpperCase()) {
    case 'CONTENT':
      return '#FFD6A5';
    case 'ORGANIZATION':
      return '#CDE7F0';
    case 'GRAMMAR':
      return '#B7E4C7';
    case 'VOCABULARY':
      return '#E4C1F9';
    case 'MECHANICS':
      return '#FFF3BF';
    default:
      return '#FFF3BF';
  }
}

function mapLtGroupKeyToRubricCategory(groupKey) {
  const k = String(groupKey || '').toLowerCase();
  if (k.includes('grammar')) return 'GRAMMAR';
  if (k.includes('spelling')) return 'MECHANICS';
  if (k.includes('typography')) return 'MECHANICS';
  if (k.includes('style')) return 'ORGANIZATION';
  return 'CONTENT';
}

function buildVocabularyAnnotationsFromText(text) {
  const t = typeof text === 'string' ? text : '';
  const tokens = t
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const freq = new Map();
  for (const w of tokens) {
    if (w.length <= 3) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Keep only obvious repetitions.
  const repeated = Array.from(freq.entries())
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return repeated.map(([word, count]) => ({
    text: word,
    category: 'VOCABULARY',
    color: legendColorForCategory('VOCABULARY'),
    explanation: `The word "${word}" is repeated ${count} times. Consider using synonyms or rephrasing.`
  }));
}

function computeRubricScoresFromCounts(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = (k) => (Number.isFinite(Number(c[k])) ? Number(c[k]) : 0);

  // Simple severity model: start from 5, subtract weighted penalties.
  const score = (penalty) => clampScore5(Math.round((5 - penalty) * 10) / 10);

  const grammarPenalty = n('GRAMMAR') * 0.35;
  const mechanicsPenalty = n('MECHANICS') * 0.25;
  const vocabPenalty = n('VOCABULARY') * 0.3;
  const orgPenalty = n('ORGANIZATION') * 0.3;
  const contentPenalty = n('CONTENT') * 0.25;

  return {
    CONTENT: score(contentPenalty),
    ORGANIZATION: score(orgPenalty),
    GRAMMAR: score(grammarPenalty),
    VOCABULARY: score(vocabPenalty),
    MECHANICS: score(mechanicsPenalty)
  };
}

function buildGeneralComments({ text, rubricScores, counts }) {
  const safe = typeof text === 'string' ? text.trim() : '';
  const wordCount = safe ? safe.split(/\s+/).filter(Boolean).length : 0;
  const scores = rubricScores || {};

  const weakest = Object.entries(scores)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(0, 2)
    .map(([k]) => k);

  const issuesTotal = Object.values(counts || {}).reduce((acc, v) => acc + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);

  const focusLine = weakest.length
    ? `Focus areas: ${weakest.join(', ')}.`
    : 'Focus on clarity and correctness.';

  return `OCR analysis processed ${wordCount} words. Detected ${issuesTotal} issue(s). ${focusLine}`;
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

function getBaseUrl(req) {
  const fromEnv = (process.env.BASE_URL || '').trim();
  const raw = fromEnv.length ? fromEnv : `${req.protocol}://${req.get('host')}`;
  return raw.replace(/\/+$/, '');
}

function toPublicUrl(req, type, filename) {
  const base = getBaseUrl(req);
  return `${base}/uploads/${type}/${encodeURIComponent(filename)}`;
}

function toStoredPath(type, filename) {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.posix.join(basePath, type, filename);
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

function normalizeOptionalNumber(value) {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'string' && !value.trim().length) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function normalizeOptionalObject(value) {
  if (value === null) return undefined;
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeOptionalObject(parsed);
    } catch {
      return { error: 'invalid json object' };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'must be an object' };
  }
  return { value };
}

function normalizeOptionalOverrideScores(value) {
  const obj = normalizeOptionalObject(value);
  if (obj && obj.error) return obj;
  if (!obj || typeof obj.value === 'undefined') return undefined;

  const v = obj.value;
  const keys = ['grammarScore', 'structureScore', 'contentScore', 'vocabularyScore', 'taskAchievementScore', 'overallScore'];
  const out = {};

  for (const k of keys) {
    if (typeof v[k] === 'undefined' || v[k] === null || (typeof v[k] === 'string' && !String(v[k]).trim().length)) {
      continue;
    }

    const n = typeof v[k] === 'number' ? v[k] : Number(v[k]);
    if (!Number.isFinite(n)) {
      return { error: `overriddenScores.${k} must be a number` };
    }
    out[k] = Math.max(0, Math.min(100, n));
  }

  return { value: Object.keys(out).length ? out : undefined };
}

function normalizeAnnotations(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return normalizeAnnotations(parsed);
    } catch (err) {
      return { error: 'annotations must be valid JSON array' };
    }
  }

  if (value === null) {
    return undefined;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return { error: 'annotations must be an array' };
  }

  const normalized = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return { error: 'annotations must be an array of objects' };
    }

    const page = typeof item.page === 'number' ? item.page : Number(item.page);
    if (!Number.isFinite(page)) {
      return { error: 'annotations.page must be a number' };
    }

    const comment = normalizeOptionalString(item.comment);
    if (comment === null || typeof comment === 'undefined') {
      return { error: 'annotations.comment is required' };
    }

    const x = typeof item.x === 'number' ? item.x : Number(item.x);
    if (!Number.isFinite(x)) {
      return { error: 'annotations.x must be a number' };
    }

    const y = typeof item.y === 'number' ? item.y : Number(item.y);
    if (!Number.isFinite(y)) {
      return { error: 'annotations.y must be a number' };
    }

    normalized.push({
      page,
      comment,
      x,
      y
    });
  }

  return {
    value: normalized
  };
}

async function persistUploadedFile(req, type) {
  const userId = req.user && req.user._id;
  const role = req.user && req.user.role;

  if (!userId || !role) {
    return { error: { statusCode: 401, message: 'Unauthorized' } };
  }

  const file = req.file;
  if (!file) {
    return { fileDoc: undefined, url: undefined };
  }

  const storedPath = toStoredPath(type, file.filename);
  const url = toPublicUrl(req, type, file.filename);

  const created = await File.create({
    originalName: file.originalname,
    filename: file.filename,
    path: storedPath,
    url,
    uploadedBy: userId,
    role,
    type
  });

  return {
    fileDoc: created,
    url
  };
}

async function populateFeedback(feedbackId) {
  return Feedback.findById(feedbackId)
    .populate('teacher', '_id email displayName photoURL role')
    .populate('student', '_id email displayName photoURL role')
    .populate('class')
    .populate('assignment')
    .populate('submission')
    .populate('file');
}

async function attachEvaluationToFeedbackDoc(feedbackDoc) {
  if (!feedbackDoc) return feedbackDoc;
  const feedback = feedbackDoc && typeof feedbackDoc.toObject === 'function' ? feedbackDoc.toObject() : feedbackDoc;

  const submission = feedbackDoc.submission;
  if (!submission || typeof submission !== 'object') {
    return feedback;
  }

  const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
    ? String(submission.transcriptText)
    : (submission.ocrText && String(submission.ocrText).trim())
      ? String(submission.ocrText)
      : '';

  const ocrWords = submission && submission.ocrData && typeof submission.ocrData === 'object' ? submission.ocrData.words : null;

  let issues = [];
  try {
    const built = await buildOcrCorrections({
      text: transcriptText,
      language: 'en-US',
      ocrWords
    });
    issues = Array.isArray(built && built.corrections) ? built.corrections : [];
  } catch {
    issues = [];
  }

  const evaluation = computeAcademicEvaluation({
    text: transcriptText,
    issues,
    teacherOverrideScores: feedbackDoc.overriddenScores
  });

  return {
    ...feedback,
    evaluation
  };
}

function validateScoreFields({ score, maxScore }) {
  if (typeof maxScore !== 'undefined' && maxScore !== null) {
    if (maxScore <= 0) {
      return 'maxScore must be greater than 0';
    }
  }

  if (typeof score !== 'undefined' && score !== null && typeof maxScore !== 'undefined' && maxScore !== null) {
    if (score > maxScore) {
      return 'score cannot be greater than maxScore';
    }
  }

  return null;
}

async function createFeedback(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    const classDoc = await Class.findOne({
      _id: submission.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'Not class teacher');
    }

    const assignment = await Assignment.findOne({
      _id: submission.assignment,
      isActive: true
    });

    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    if (String(assignment.class) !== String(submission.class)) {
      return sendError(res, 400, 'Submission does not belong to assignment class');
    }

    const existing = await Feedback.findOne({ submission: submission._id });
    if (existing) {
      return sendError(res, 409, 'Feedback already exists');
    }

    const textFeedback = normalizeOptionalString(req.body && req.body.textFeedback);
    if (textFeedback === null) {
      return sendError(res, 400, 'textFeedback must be a string');
    }

    const teacherComments = normalizeOptionalString(req.body && req.body.teacherComments);
    if (teacherComments === null) {
      return sendError(res, 400, 'teacherComments must be a string');
    }

    const overrideReason = normalizeOptionalString(req.body && req.body.overrideReason);
    if (overrideReason === null) {
      return sendError(res, 400, 'overrideReason must be a string');
    }

    const overriddenScoresResult = normalizeOptionalOverrideScores(req.body && req.body.overriddenScores);
    if (overriddenScoresResult && overriddenScoresResult.error) {
      return sendError(res, 400, overriddenScoresResult.error);
    }

    const score = normalizeOptionalNumber(req.body && req.body.score);
    if (score === null) {
      return sendError(res, 400, 'score must be a number');
    }

    const maxScore = normalizeOptionalNumber(req.body && req.body.maxScore);
    if (maxScore === null) {
      return sendError(res, 400, 'maxScore must be a number');
    }

    const scoreError = validateScoreFields({ score, maxScore });
    if (scoreError) {
      return sendError(res, 400, scoreError);
    }

    const annotationsResult = normalizeAnnotations(req.body && req.body.annotations);
    if (annotationsResult && annotationsResult.error) {
      return sendError(res, 400, annotationsResult.error);
    }

    const persisted = await persistUploadedFile(req, 'feedback');
    if (persisted.error) {
      return sendError(res, persisted.error.statusCode, persisted.error.message);
    }

    if (persisted.fileDoc) {
      const uploadedMB =
        typeof req.uploadSizeMB === 'number'
          ? req.uploadSizeMB
          : bytesToMB(req.file && req.file.size);
      await incrementUsage(teacherId, { storageMB: uploadedMB });
    }

    try {
      const created = await Feedback.create({
        teacher: teacherId,
        student: submission.student,
        class: submission.class,
        assignment: submission.assignment,
        submission: submission._id,
        textFeedback,
        score,
        maxScore,
        teacherComments,
        overriddenScores: overriddenScoresResult ? overriddenScoresResult.value : undefined,
        overrideReason,
        overriddenBy: overriddenScoresResult && overriddenScoresResult.value ? teacherId : undefined,
        overriddenAt: overriddenScoresResult && overriddenScoresResult.value ? new Date() : undefined,
        annotations: annotationsResult ? annotationsResult.value : undefined,
        file: persisted.fileDoc ? persisted.fileDoc._id : undefined,
        fileUrl: persisted.url
      });

      await Submission.updateOne(
        { _id: submission._id, $or: [{ feedback: { $exists: false } }, { feedback: null }] },
        { $set: { feedback: created._id } }
      );

      const populated = await populateFeedback(created._id);
      const withEval = await attachEvaluationToFeedbackDoc(populated);
      return sendSuccess(res, withEval);
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern && err.keyPattern.submission) {
        return sendError(res, 409, 'Feedback already exists');
      }

      return sendError(res, 500, 'Failed to create feedback');
    }
  } catch (err) {
    return sendError(res, 500, 'Failed to create feedback');
  }
}

async function generateAiFeedbackFromOcr(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    const classDoc = await Class.findOne({
      _id: submission.class,
      teacher: teacherId,
      isActive: true
    });
    if (!classDoc) {
      return sendError(res, 403, 'Not class teacher');
    }

    const assignment = await Assignment.findOne({
      _id: submission.assignment,
      isActive: true
    });
    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }

    const ocrText = typeof submission.ocrText === 'string' ? submission.ocrText : '';
    if (!ocrText.trim()) {
      return sendError(res, 400, 'Submission OCR text is empty');
    }

    const preDetectedIssues = req.body && Array.isArray(req.body.preDetectedIssues) ? req.body.preDetectedIssues : null;

    let corrections = [];
    try {
      if (preDetectedIssues) {
        corrections = preDetectedIssues;
      } else {
        const normalizedWords = normalizeOcrWordsFromStored(submission.ocrData && submission.ocrData.words);
        const built = await buildOcrCorrections({
          text: ocrText,
          language: (req.body && req.body.language) ? String(req.body.language) : 'en-US',
          ocrWords: normalizedWords
        });
        corrections = Array.isArray(built && built.corrections) ? built.corrections : [];
      }
    } catch {
      corrections = [];
    }

    const textAnnotations = [];
    const counts = {
      CONTENT: 0,
      ORGANIZATION: 0,
      GRAMMAR: 0,
      VOCABULARY: 0,
      MECHANICS: 0
    };

    for (const c of Array.isArray(corrections) ? corrections : []) {
      const category = mapLtGroupKeyToRubricCategory(c && (c.groupKey || c.groupLabel));
      const start = Number.isFinite(Number(c && c.startChar)) ? Number(c.startChar) : NaN;
      const end = Number.isFinite(Number(c && c.endChar)) ? Number(c.endChar) : NaN;
      const exact = Number.isFinite(start) && Number.isFinite(end) && end > start
        ? ocrText.slice(start, end)
        : safeString(c && (c.wrongText || c.text || c.message)).trim();

      const explanation = safeString(c && (c.message || c.description || c.explanation)).trim() || 'Check this section.';

      if (!exact) continue;

      textAnnotations.push({
        text: exact,
        category,
        color: legendColorForCategory(category),
        explanation
      });

      if (category in counts) counts[category] += 1;
    }

    const vocabAnnotations = buildVocabularyAnnotationsFromText(ocrText);
    for (const a of vocabAnnotations) {
      textAnnotations.push(a);
      counts.VOCABULARY += 1;
    }

    const paragraphCount = ocrText.split(/\n\s*\n/).filter((p) => p.trim().length).length;
    if (paragraphCount <= 1) {
      textAnnotations.push({
        text: 'Structure',
        category: 'ORGANIZATION',
        color: legendColorForCategory('ORGANIZATION'),
        explanation: 'The response appears to be a single block. Consider splitting into paragraphs (intro, body, conclusion).'
      });
      counts.ORGANIZATION += 1;
    }

    const sentenceCount = ocrText.split(/[.!?]+/).filter((s) => s.trim().length).length;
    if (sentenceCount < 3) {
      textAnnotations.push({
        text: 'Idea development',
        category: 'CONTENT',
        color: legendColorForCategory('CONTENT'),
        explanation: 'The response is very short. Add supporting details and examples to develop your ideas.'
      });
      counts.CONTENT += 1;
    }

    const rubricScores = computeRubricScoresFromCounts(counts);
    const generalComments = buildGeneralComments({ text: ocrText, rubricScores, counts });

    const aiFeedback = normalizeAiFeedbackPayload({
      textAnnotations,
      rubricScores,
      generalComments
    });

    let feedbackDoc = await Feedback.findOne({ submission: submission._id });
    if (!feedbackDoc) {
      feedbackDoc = await Feedback.create({
        teacher: teacherId,
        student: submission.student,
        class: submission.class,
        assignment: submission.assignment,
        submission: submission._id,
        aiFeedback,
        aiGeneratedAt: new Date()
      });
    } else {
      feedbackDoc.aiFeedback = aiFeedback;
      feedbackDoc.aiGeneratedAt = new Date();
      await feedbackDoc.save();
    }

    if (!submission.feedback || String(submission.feedback) !== String(feedbackDoc._id)) {
      submission.feedback = feedbackDoc._id;
      await submission.save();
    }

    const populated = await populateFeedback(feedbackDoc._id);
    const withEval = await attachEvaluationToFeedbackDoc(populated);
    return sendSuccess(res, withEval);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate AI feedback');
  }
}

async function updateFeedback(req, res) {
  try {
    const { feedbackId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(feedbackId)) {
      return sendError(res, 400, 'Invalid feedback id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const classDoc = await Class.findOne({
      _id: feedback.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'Not class teacher');
    }

    const textFeedback = normalizeOptionalString(req.body && req.body.textFeedback);
    if (textFeedback === null) {
      return sendError(res, 400, 'textFeedback must be a string');
    }

    const score = normalizeOptionalNumber(req.body && req.body.score);
    if (score === null) {
      return sendError(res, 400, 'score must be a number');
    }

    const maxScore = normalizeOptionalNumber(req.body && req.body.maxScore);
    if (maxScore === null) {
      return sendError(res, 400, 'maxScore must be a number');
    }

    const nextScore = typeof score === 'undefined' ? feedback.score : score;
    const nextMaxScore = typeof maxScore === 'undefined' ? feedback.maxScore : maxScore;

    const scoreError = validateScoreFields({ score: nextScore, maxScore: nextMaxScore });
    if (scoreError) {
      return sendError(res, 400, scoreError);
    }

    const annotationsResult = normalizeAnnotations(req.body && req.body.annotations);
    if (annotationsResult && annotationsResult.error) {
      return sendError(res, 400, annotationsResult.error);
    }

    const persisted = await persistUploadedFile(req, 'feedback');
    if (persisted.error) {
      return sendError(res, persisted.error.statusCode, persisted.error.message);
    }

    if (persisted.fileDoc) {
      const uploadedMB =
        typeof req.uploadSizeMB === 'number'
          ? req.uploadSizeMB
          : bytesToMB(req.file && req.file.size);
      await incrementUsage(teacherId, { storageMB: uploadedMB });
    }

    if (typeof textFeedback !== 'undefined') {
      feedback.textFeedback = textFeedback;
    }

    if (typeof teacherComments !== 'undefined') {
      feedback.teacherComments = teacherComments;
    }

    if (typeof overrideReason !== 'undefined') {
      feedback.overrideReason = overrideReason;
    }

    if (typeof overriddenScoresResult !== 'undefined') {
      feedback.overriddenScores = overriddenScoresResult ? overriddenScoresResult.value : undefined;
      feedback.overriddenBy = overriddenScoresResult && overriddenScoresResult.value ? teacherId : undefined;
      feedback.overriddenAt = overriddenScoresResult && overriddenScoresResult.value ? new Date() : undefined;
    }

    if (typeof score !== 'undefined') {
      feedback.score = score;
    }

    if (typeof maxScore !== 'undefined') {
      feedback.maxScore = maxScore;
    }

    if (typeof annotationsResult !== 'undefined') {
      feedback.annotations = annotationsResult ? annotationsResult.value : undefined;
    }

    if (persisted.fileDoc) {
      feedback.file = persisted.fileDoc._id;
      feedback.fileUrl = persisted.url;
    }

    await feedback.save();

    const populated = await populateFeedback(feedback._id);
    const withEval = await attachEvaluationToFeedbackDoc(populated);
    return sendSuccess(res, withEval);
  } catch (err) {
    return sendError(res, 500, 'Failed to update feedback');
  }
}

async function getFeedbackBySubmissionForStudent(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const studentId = req.user && req.user._id;
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    if (String(submission.student) !== String(studentId)) {
      return sendError(res, 403, 'No permission');
    }

    const feedback = await Feedback.findOne({ submission: submission._id });
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const populated = await populateFeedback(feedback._id);
    const withEval = await attachEvaluationToFeedbackDoc(populated);
    return sendSuccess(res, withEval);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

async function getFeedbackByIdForTeacher(req, res) {
  try {
    const { feedbackId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(feedbackId)) {
      return sendError(res, 400, 'Invalid feedback id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return sendError(res, 404, 'Feedback not found');
    }

    const classDoc = await Class.findOne({
      _id: feedback.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
      return sendError(res, 403, 'No permission');
    }

    const populated = await populateFeedback(feedback._id);
    const withEval = await attachEvaluationToFeedbackDoc(populated);
    return sendSuccess(res, withEval);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

async function listFeedbackByClassForTeacher(req, res) {
  try {
    const { classId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid class id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    await uploadService.assertTeacherOwnsClassOrThrow(teacherId, classId);

    const feedbacks = await Feedback.find({ class: classId })
      .sort({ createdAt: -1 })
      .populate('teacher', '_id email displayName photoURL role')
      .populate('student', '_id email displayName photoURL role')
      .populate('class')
      .populate('assignment')
      .populate('submission')
      .populate('file');

    const out = [];
    for (const fb of feedbacks) {
      out.push(await attachEvaluationToFeedbackDoc(fb));
    }

    return sendSuccess(res, out);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

module.exports = {
  createFeedback,
  generateAiFeedbackFromOcr,
  updateFeedback,
  getFeedbackBySubmissionForStudent,
  getFeedbackByIdForTeacher,
  listFeedbackByClassForTeacher
};
