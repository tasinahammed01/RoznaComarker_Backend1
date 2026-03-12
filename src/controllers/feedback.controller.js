const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const File = require('../models/File');
const User = require('../models/user.model');

const uploadService = require('../services/upload.service');
const {
  RubricExcelTemplateError,
  parseRubricDesignerFromExcelTemplate
} = require('../services/rubricExcelTemplateParser.service');
const {
  RubricDocxTemplateError,
  parseRubricDesignerFromDocxTemplate
} = require('../services/docxRubricTemplateParser.service');
const { buildOcrCorrections } = require('../services/ocrCorrections.service');
const { normalizeOcrWordsFromStored } = require('../services/ocrCorrections.service');
const { computeAcademicEvaluation } = require('../modules/academicEvaluationEngine');

const { fetchCompat, buildTimeoutSignal } = require('../services/httpClient.service');

const { bytesToMB, incrementUsage } = require('../middlewares/usage.middleware');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function defaultRubricItem() {
  return { score: 0, maxScore: 5, comment: '' };
}

function buildDefaultSubmissionFeedbackDoc({ submissionId, classId, studentId, teacherId }) {
  return {
    submissionId,
    classId,
    studentId,
    teacherId,
    rubricScores: {
      CONTENT: defaultRubricItem(),
      ORGANIZATION: defaultRubricItem(),
      GRAMMAR: defaultRubricItem(),
      VOCABULARY: defaultRubricItem(),
      MECHANICS: defaultRubricItem()
    },
    overallScore: 0,
    grade: 'F',
    correctionStats: {
      content: 0,
      grammar: 0,
      organization: 0,
      vocabulary: 0,
      mechanics: 0
    },
    detailedFeedback: {
      strengths: [],
      areasForImprovement: [],
      actionSteps: []
    },
    aiFeedback: {
      perCategory: [],
      overallComments: ''
    },
    overriddenByTeacher: false
  };
}

function normalizeTeacherAiConfig(user) {
  const cfg = user && user.aiConfig && typeof user.aiConfig === 'object' ? user.aiConfig : {};
  const strictnessRaw = typeof cfg.strictness === 'string' ? cfg.strictness.trim().toLowerCase() : '';
  const strictness = ['friendly', 'balanced', 'strict'].includes(strictnessRaw) ? strictnessRaw : 'balanced';

  const checks = cfg.checks && typeof cfg.checks === 'object' ? cfg.checks : {};
  return {
    strictness,
    checks: {
      grammarSpelling: typeof checks.grammarSpelling === 'boolean' ? checks.grammarSpelling : true,
      coherenceLogic: typeof checks.coherenceLogic === 'boolean' ? checks.coherenceLogic : true,
      factChecking: typeof checks.factChecking === 'boolean' ? checks.factChecking : false
    }
  };
}

function isGrammarSpellingGroup(groupKey) {
  const k = String(groupKey || '').toLowerCase();
  return k === 'grammar' || k === 'spelling' || k === 'typography';
}

function isCoherenceLogicGroup(groupKey) {
  const k = String(groupKey || '').toLowerCase();
  // LanguageTool uses `style` for many coherence/structure issues.
  return k === 'style';
}

function filterCorrectionsByAiConfig(corrections, aiConfig) {
  const list = Array.isArray(corrections) ? corrections : [];
  const cfg = aiConfig && typeof aiConfig === 'object' ? aiConfig : normalizeTeacherAiConfig(null);

  return list.filter((c) => {
    const k = c && (c.groupKey || c.groupLabel);
    if (isGrammarSpellingGroup(k)) return cfg.checks.grammarSpelling;
    if (isCoherenceLogicGroup(k)) return cfg.checks.coherenceLogic;
    return true;
  });
}

function strictnessPenaltyConfig(strictness) {
  const s = String(strictness || '').toLowerCase();
  if (s === 'friendly') {
    return { gm: 45, org: 30, content: 30 };
  }
  if (s === 'strict') {
    return { gm: 80, org: 55, content: 55 };
  }
  return { gm: 60, org: 40, content: 40 };
}

function clampScore100(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function computeRubricScore100FromRubricScores(rubricScores) {
  const rs = rubricScores && typeof rubricScores === 'object' ? rubricScores : {};
  const keys = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS'];
  const values = [];
  for (const k of keys) {
    const item = rs[k];
    if (!item || typeof item !== 'object') continue;
    const max = typeof item.maxScore === 'number' ? item.maxScore : 5;
    const score = typeof item.score === 'number' ? item.score : Number(item.score);
    if (!Number.isFinite(score)) continue;
    if (!Number.isFinite(max) || max <= 0) continue;
    values.push(Math.max(0, Math.min(max, score)) / max);
  }

  if (!values.length) return 0;
  const avg01 = values.reduce((a, b) => a + b, 0) / values.length;
  return clampScore100(Math.round(avg01 * 1000) / 10);
}

function computeCombinedOverallScore100({ rubricScores, languageToolScore100, rubricWeight = 0.7 }) {
  const rw = typeof rubricWeight === 'number' ? rubricWeight : 0.7;
  const rubricScore100 = computeRubricScore100FromRubricScores(rubricScores);
  const ltScore100 = clampScore100(languageToolScore100);
  const combined = rubricScore100 * rw + ltScore100 * (1 - rw);
  return clampScore100(Math.round(combined * 10) / 10);
}

function gradeFromOverallScore100(score100) {
  const s = clampScore100(score100);
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 70) return 'C';
  if (s >= 60) return 'D';
  return 'F';
}

function normalizeRubricItemPayload(item) {
  const obj = item && typeof item === 'object' ? item : {};
  const scoreRaw = obj.score;
  const score = Number(scoreRaw);
  if (!Number.isFinite(score) || score < 0 || score > 5) {
    return { error: 'score must be a number between 0 and 5' };
  }

  const comment = typeof obj.comment === 'string' ? obj.comment : (obj.comment == null ? '' : String(obj.comment));
  return {
    value: {
      score,
      maxScore: 5,
      comment
    }
  };
}

function normalizeAiFeedbackPerCategoryPayload(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const it of value) {
    const obj = it && typeof it === 'object' ? it : {};
    const category = safeString(obj.category).trim();
    const message = safeString(obj.message).trim();
    const scoreOutOf5 = clampScore5(obj.scoreOutOf5);
    if (!category && !message) continue;
    out.push({ category, message, scoreOutOf5 });
  }
  return out;
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

function buildRubricDesignerFromRubricScores({ rubricScores, title }) {
  // IMPORTANT: Rubric designer must start empty. Teacher will generate/edit/attach.
  // Keep the rubric title, but do not prefill level titles, maxPoints, criteria titles, or any cell text.
  const levels = Array.from({ length: 4 }).map(() => ({ title: '', maxPoints: null }));
  const criteria = Array.from({ length: 4 }).map(() => ({ title: '', cells: levels.map(() => '') }));

  return {
    title: safeString(title).trim(),
    levels,
    criteria
  };
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

function computeCountsFromCorrections(corrections) {
  const counts = {
    CONTENT: 0,
    ORGANIZATION: 0,
    GRAMMAR: 0,
    VOCABULARY: 0,
    MECHANICS: 0
  };
  for (const c of Array.isArray(corrections) ? corrections : []) {
    const category = mapLtGroupKeyToRubricCategory(c && (c.groupKey || c.groupLabel));
    if (category in counts) counts[category] += 1;
  }
  return counts;
}

function buildDetailedFeedbackDefaults({ structuredFeedback }) {
  const sf = structuredFeedback && typeof structuredFeedback === 'object' ? structuredFeedback : {};
  const strengths = [];
  const areas = [];
  const steps = [];

  const grammarSummary = safeString(sf.grammarFeedback && sf.grammarFeedback.summary).trim();
  const structureSummary = safeString(sf.structureFeedback && sf.structureFeedback.summary).trim();
  const contentSummary = safeString(sf.contentFeedback && sf.contentFeedback.summary).trim();
  const vocabSummary = safeString(sf.vocabularyFeedback && sf.vocabularyFeedback.summary).trim();

  if (contentSummary) strengths.push('You addressed the prompt with a clear attempt.');
  if (structureSummary) areas.push('Improve structure and organization for clearer flow.');
  if (grammarSummary) areas.push('Reduce grammar/mechanics errors with careful proofreading.');
  if (vocabSummary) steps.push('Vary word choice and avoid repetition where possible.');

  if (!steps.length) {
    steps.push('Review your work and correct the highlighted issues, then rewrite for clarity.');
  }

  return {
    strengths: strengths.slice(0, 5),
    areasForImprovement: areas.slice(0, 5),
    actionSteps: steps.slice(0, 5)
  };
}

function buildAiFeedbackDefaults({ rubricScores, structuredFeedback, overallComments }) {
  const sf = structuredFeedback && typeof structuredFeedback === 'object' ? structuredFeedback : {};
  const rs = rubricScores && typeof rubricScores === 'object' ? rubricScores : {};

  const perCategory = [
    { category: 'CONTENT', message: safeString(sf.contentFeedback && sf.contentFeedback.summary).trim(), scoreOutOf5: clampScore5(rs.CONTENT && rs.CONTENT.score) },
    { category: 'ORGANIZATION', message: safeString(sf.structureFeedback && sf.structureFeedback.summary).trim(), scoreOutOf5: clampScore5(rs.ORGANIZATION && rs.ORGANIZATION.score) },
    { category: 'GRAMMAR', message: safeString(sf.grammarFeedback && sf.grammarFeedback.summary).trim(), scoreOutOf5: clampScore5(rs.GRAMMAR && rs.GRAMMAR.score) },
    { category: 'VOCABULARY', message: safeString(sf.vocabularyFeedback && sf.vocabularyFeedback.summary).trim(), scoreOutOf5: clampScore5(rs.VOCABULARY && rs.VOCABULARY.score) },
    { category: 'MECHANICS', message: safeString(sf.grammarFeedback && sf.grammarFeedback.summary).trim(), scoreOutOf5: clampScore5(rs.MECHANICS && rs.MECHANICS.score) }
  ].filter((x) => x.message || x.scoreOutOf5 > 0);

  return {
    perCategory,
    overallComments: safeString(overallComments).trim()
  };
}

function normalizeStringArrayPayload(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const v of value) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length) out.push(t);
      continue;
    }
    if (v == null) continue;
    const t = String(v).trim();
    if (t.length) out.push(t);
  }
  return out;
}

function buildDynamicRubricComments({
  wordCount,
  grammarCount,
  mechanicsCount,
  organizationCount,
  contentCount,
  paragraphCount,
  grammarMechanics,
  structureOrganization,
  contentRelevance,
  overallRubricScore
}) {
  const wc = Number(wordCount) || 0;
  const paras = Number(paragraphCount) || 0;

  const gmIssues = (Number(grammarCount) || 0) + (Number(mechanicsCount) || 0);
  const gmDensity = wc ? (gmIssues / wc) : 0;
  const orgDensity = wc ? ((Number(organizationCount) || 0) / wc) : 0;
  const contentDensity = wc ? ((Number(contentCount) || 0) / wc) : 0;

  const gmNote = gmDensity > 0.08
    ? 'Frequent grammar/punctuation issues are reducing clarity.'
    : gmDensity > 0.03
      ? 'A few grammar/punctuation issues were detected; proofreading will help.'
      : 'Grammar and mechanics are strong with minimal issues detected.';

  const orgNote = paras < 2
    ? 'Structure is hard to follow; consider using clear paragraphs.'
    : orgDensity > 0.03
      ? 'Organization can be improved by strengthening transitions and sequencing.'
      : 'Organization is generally clear with a logical flow.';

  const contentNote = wc < 60
    ? 'Content is very brief; add more detail and explanation to address the task fully.'
    : contentDensity > 0.06
      ? 'Some ideas appear unclear or off-target; focus on answering the prompt directly and completely.'
      : 'Content is mostly relevant and adequately developed.';

  const overallNote = `Overall rubric reflects: Grammar & Mechanics ${Number(grammarMechanics || 0).toFixed(1)}/5, Structure & Organization ${Number(structureOrganization || 0).toFixed(1)}/5, Content Relevance ${Number(contentRelevance || 0).toFixed(1)}/5.`;

  return {
    grammarMechanics: gmNote,
    structureOrganization: orgNote,
    contentRelevance: contentNote,
    overallRubricScore: overallNote
  };
}

async function getSubmissionFeedback(req, res) {
  try {
    const { submissionId } = req.params;

    console.log('Checking dynamic fields for submission', submissionId);

    const userId = req.user && req.user._id;
    const role = req.user && req.user.role;
    if (!userId || !role) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return sendError(res, 404, 'Submission not found');
    }

    if (role === 'student') {
      if (String(submission.student) !== String(userId)) {
        return sendError(res, 403, 'No permission');
      }
    } else if (role === 'teacher') {
      const classDoc = await Class.findOne({
        _id: submission.class,
        teacher: userId,
        isActive: true
      });
      if (!classDoc) {
        return sendError(res, 403, 'No permission');
      }
    } else {
      return sendError(res, 403, 'Forbidden');
    }

    let feedback = await SubmissionFeedback.findOne({ submissionId: submission._id });
    if (!feedback) {
      console.log('Generating dynamic AI Feedback for submission', submissionId);
      console.log('Dynamic summary generation for submission', submissionId);
      // Hybrid model: if feedback doesn't exist, generate AI defaults on the backend and persist.
      const classDoc = await Class.findById(submission.class).select('_id teacher');
      const teacherId = role === 'teacher' ? userId : (classDoc && classDoc.teacher ? classDoc.teacher : null);
      if (!teacherId) {
        return sendError(res, 500, 'Failed to resolve class teacher');
      }

      let teacherUser = null;
      try {
        teacherUser = await User.findById(teacherId).select('_id aiConfig');
      } catch {
        teacherUser = null;
      }

      const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
        ? String(submission.transcriptText)
        : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
          ? String(submission.combinedOcrText)
          : (submission.ocrText && String(submission.ocrText).trim())
            ? String(submission.ocrText)
            : '';

      const normalizedWords = normalizeOcrWordsFromStored(submission.ocrData && submission.ocrData.words);

      let built;
      try {
        built = await buildOcrCorrections({
          text: transcriptText,
          language: 'en-US',
          ocrWords: normalizedWords
        });
      } catch {
        built = { corrections: [], fullText: transcriptText };
      }

      // Always use the persisted teacher AI config so student/teacher views compute identical scores.
      // JWT payload may not include aiConfig and can lead to different defaults between roles.
      const aiCfg = normalizeTeacherAiConfig(teacherUser);
      const allCorrections = Array.isArray(built && built.corrections) ? built.corrections : [];
      const corrections = filterCorrectionsByAiConfig(allCorrections, aiCfg);
      const counts = augmentCountsWithTextHeuristics(transcriptText, computeCountsFromCorrections(corrections));

      const correctedText = applyCorrectionsToText(transcriptText, corrections);

      const assignment = await Assignment.findOne({ _id: submission.assignment, isActive: true });
      const normalizedAssignmentRubrics = normalizeAssignmentRubrics(assignment && assignment.rubrics);

      const clamp5 = (n) => {
        const x = Number(n);
        if (!Number.isFinite(x)) return 0;
        return Math.max(0, Math.min(5, x));
      };

      const safeText = typeof transcriptText === 'string' ? transcriptText : '';
      const wordCount = safeText.trim() ? safeText.trim().split(/\s+/).filter(Boolean).length : 0;

      const grammarCount = Number(counts && counts.GRAMMAR) || 0;
      const mechanicsCount = Number(counts && counts.MECHANICS) || 0;
      const organizationCount = Number(counts && counts.ORGANIZATION) || 0;
      const contentCount = Number(counts && counts.CONTENT) || 0;

      const penaltyCfg = strictnessPenaltyConfig(aiCfg.strictness);

      // Grammar & Mechanics (/5) based on issue density.
      const grammarMechanicsIssues = grammarCount + mechanicsCount;
      const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * penaltyCfg.gm);

      // Structure & Organization (/5) from paragraph structure + organization issues.
      const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;
      const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
      const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * penaltyCfg.org);

      // Content Relevance (/5) from content issues + very short submissions penalty.
      const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
      const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * penaltyCfg.content);

      const overallRubricScore = clamp5((grammarMechanics + structureOrganization + contentRelevance) / 3);

      console.log('Dynamic AI rubric generated for submission', submissionId);

      const rubricComments = buildDynamicRubricComments({
        wordCount,
        grammarCount,
        mechanicsCount,
        organizationCount,
        contentCount,
        paragraphCount,
        grammarMechanics,
        structureOrganization,
        contentRelevance,
        overallRubricScore
      });

      const rubricScores = {
        // Mapped into existing schema keys (no DB schema changes).
        CONTENT: { score: contentRelevance, maxScore: 5, comment: rubricComments.contentRelevance },
        ORGANIZATION: { score: structureOrganization, maxScore: 5, comment: rubricComments.structureOrganization },
        GRAMMAR: { score: grammarMechanics, maxScore: 5, comment: rubricComments.grammarMechanics },
        VOCABULARY: { score: 0, maxScore: 5, comment: '' },
        MECHANICS: { score: overallRubricScore, maxScore: 5, comment: rubricComments.overallRubricScore }
      };

      const evaluation = computeAcademicEvaluation({
        text: correctedText,
        issues: corrections,
        teacherOverrideScores: null
      });

      const languageToolScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
      const overallScore100 = computeCombinedOverallScore100({ rubricScores, languageToolScore100, rubricWeight: 0.7 });
      const grade = gradeFromOverallScore100(overallScore100);

      const overallComments = buildGeneralComments({ text: correctedText, rubricScores: { CONTENT: contentRelevance, ORGANIZATION: structureOrganization, GRAMMAR: grammarMechanics }, counts });
      const detailedFeedback = ensureDetailedFeedbackDynamic({
        detailedFeedback: buildDetailedFeedbackDefaults({ structuredFeedback: evaluation && evaluation.structuredFeedback }),
        counts
      });
      const aiFeedback = buildAiFeedbackDefaults({
        rubricScores,
        structuredFeedback: evaluation && evaluation.structuredFeedback,
        overallComments
      });

      // Teacher comment must start empty and must not be AI-generated.
      aiFeedback.overallComments = '';
      console.log('Teacher comment initialized as empty');

      const created = await SubmissionFeedback.create({
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId,
        overallScore: overallScore100,
        grade,
        correctionStats: {
          content: counts.CONTENT,
          grammar: counts.GRAMMAR,
          organization: counts.ORGANIZATION,
          vocabulary: counts.VOCABULARY,
          mechanics: counts.MECHANICS
        },
        detailedFeedback,
        rubricScores,
        aiFeedback,
        overriddenByTeacher: false
      });

      feedback = created.toObject();
    } else {
      const feedbackObj = feedback.toObject();

      const cs0 = feedbackObj && feedbackObj.correctionStats ? feedbackObj.correctionStats : {};
      const csTotal =
        (Number(cs0.content) || 0) +
        (Number(cs0.grammar) || 0) +
        (Number(cs0.organization) || 0) +
        (Number(cs0.vocabulary) || 0) +
        (Number(cs0.mechanics) || 0);

      const persistedOverall = Number(feedbackObj && feedbackObj.overallScore);
      const hasText = ((submission.transcriptText && String(submission.transcriptText).trim()) || (submission.combinedOcrText && String(submission.combinedOcrText).trim()) || (submission.ocrText && String(submission.ocrText).trim())) ? true : false;

      const needsStatsBackfill =
        !feedbackObj.overriddenByTeacher &&
        hasText &&
        ((!Number.isFinite(persistedOverall) || persistedOverall <= 0) || csTotal <= 0);

      if (needsStatsBackfill) {
        const classDoc = await Class.findById(submission.class).select('_id teacher');
        const teacherId = role === 'teacher' ? userId : (classDoc && classDoc.teacher ? classDoc.teacher : null);
        if (!teacherId) {
          return sendSuccess(res, feedbackObj);
        }

        let teacherUser = null;
        try {
          teacherUser = await User.findById(teacherId).select('_id aiConfig');
        } catch {
          teacherUser = null;
        }

        const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
          ? String(submission.transcriptText)
          : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
            ? String(submission.combinedOcrText)
            : (submission.ocrText && String(submission.ocrText).trim())
              ? String(submission.ocrText)
              : '';

        const normalizedWords = normalizeOcrWordsFromStored(submission.ocrData && submission.ocrData.words);

        let built;
        try {
          built = await buildOcrCorrections({
            text: transcriptText,
            language: 'en-US',
            ocrWords: normalizedWords
          });
        } catch {
          built = { corrections: [], fullText: transcriptText };
        }

        // Always use the persisted teacher AI config so student/teacher views compute identical scores.
        // JWT payload may not include aiConfig and can lead to different defaults between roles.
        const aiCfg = normalizeTeacherAiConfig(teacherUser);
        const allCorrections = Array.isArray(built && built.corrections) ? built.corrections : [];
        const corrections = filterCorrectionsByAiConfig(allCorrections, aiCfg);
        const counts = augmentCountsWithTextHeuristics(transcriptText, computeCountsFromCorrections(corrections));

        const correctedText = applyCorrectionsToText(transcriptText, corrections);

        const clamp5 = (n) => {
          const x = Number(n);
          if (!Number.isFinite(x)) return 0;
          return Math.max(0, Math.min(5, x));
        };

        const safeText = typeof transcriptText === 'string' ? transcriptText : '';
        const wordCount = safeText.trim() ? safeText.trim().split(/\s+/).filter(Boolean).length : 0;

        const grammarCount = Number(counts && counts.GRAMMAR) || 0;
        const mechanicsCount = Number(counts && counts.MECHANICS) || 0;
        const organizationCount = Number(counts && counts.ORGANIZATION) || 0;
        const contentCount = Number(counts && counts.CONTENT) || 0;

        const penaltyCfg = strictnessPenaltyConfig(aiCfg.strictness);

        const grammarMechanicsIssues = grammarCount + mechanicsCount;
        const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * penaltyCfg.gm);

        const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;
        const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
        const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * penaltyCfg.org);

        const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
        const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * penaltyCfg.content);

        const overallRubricScore = clamp5((grammarMechanics + structureOrganization + contentRelevance) / 3);

        const rubricComments = buildDynamicRubricComments({
          wordCount,
          grammarCount,
          mechanicsCount,
          organizationCount,
          contentCount,
          paragraphCount,
          grammarMechanics,
          structureOrganization,
          contentRelevance,
          overallRubricScore
        });

        const rubricScores = {
          CONTENT: { score: contentRelevance, maxScore: 5, comment: rubricComments.contentRelevance },
          ORGANIZATION: { score: structureOrganization, maxScore: 5, comment: rubricComments.structureOrganization },
          GRAMMAR: { score: grammarMechanics, maxScore: 5, comment: rubricComments.grammarMechanics },
          VOCABULARY: { score: 0, maxScore: 5, comment: '' },
          MECHANICS: { score: overallRubricScore, maxScore: 5, comment: rubricComments.overallRubricScore }
        };

        const evaluation = computeAcademicEvaluation({
          text: correctedText,
          issues: corrections,
          teacherOverrideScores: null
        });

        const languageToolScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
        const overallScore100 = computeCombinedOverallScore100({ rubricScores, languageToolScore100, rubricWeight: 0.7 });
        const grade = gradeFromOverallScore100(overallScore100);

        const overallComments = buildGeneralComments({ text: correctedText, rubricScores: { CONTENT: contentRelevance, ORGANIZATION: structureOrganization, GRAMMAR: grammarMechanics }, counts });
        const detailedFeedback = ensureDetailedFeedbackDynamic({
          detailedFeedback: buildDetailedFeedbackDefaults({ structuredFeedback: evaluation && evaluation.structuredFeedback }),
          counts
        });
        const aiFeedback = buildAiFeedbackDefaults({
          rubricScores,
          structuredFeedback: evaluation && evaluation.structuredFeedback,
          overallComments
        });
        aiFeedback.overallComments = '';

        try {
          const saved = await SubmissionFeedback.findOneAndUpdate(
            { submissionId: submission._id },
            {
              $set: {
                overallScore: overallScore100,
                grade,
                correctionStats: {
                  content: counts.CONTENT,
                  grammar: counts.GRAMMAR,
                  organization: counts.ORGANIZATION,
                  vocabulary: counts.VOCABULARY,
                  mechanics: counts.MECHANICS
                },
                rubricScores,
                detailedFeedback,
                aiFeedback
              }
            },
            { new: true }
          );
          return sendSuccess(res, saved ? saved.toObject() : { ...feedbackObj, overallScore: overallScore100 });
        } catch {
          return sendSuccess(res, feedbackObj);
        }
      }

      const rs = feedbackObj && feedbackObj.rubricScores ? feedbackObj.rubricScores : null;
      const needsBackfill = !rs?.GRAMMAR?.comment || !rs?.ORGANIZATION?.comment || !rs?.CONTENT?.comment || !rs?.MECHANICS?.comment;

      if (!needsBackfill) {
        feedback = feedbackObj;
      } else {
        const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
          ? String(submission.transcriptText)
          : (submission.ocrText && String(submission.ocrText).trim())
            ? String(submission.ocrText)
            : '';

        const safeText = typeof transcriptText === 'string' ? transcriptText : '';
        const wordCount = safeText.trim() ? safeText.trim().split(/\s+/).filter(Boolean).length : 0;
        const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;

        const cs = feedbackObj && feedbackObj.correctionStats ? feedbackObj.correctionStats : {};
        const grammarCount = Number(cs.grammar) || 0;
        const mechanicsCount = Number(cs.mechanics) || 0;
        const organizationCount = Number(cs.organization) || 0;
        const contentCount = Number(cs.content) || 0;

        const clamp5 = (n) => {
          const x = Number(n);
          if (!Number.isFinite(x)) return 0;
          return Math.max(0, Math.min(5, x));
        };

        const grammarMechanicsIssues = grammarCount + mechanicsCount;
        const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * 60);
        const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
        const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * 40);
        const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
        const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * 40);
        const overallRubricScore = clamp5((grammarMechanics + structureOrganization + contentRelevance) / 3);

        const rubricComments = buildDynamicRubricComments({
          wordCount,
          grammarCount,
          mechanicsCount,
          organizationCount,
          contentCount,
          paragraphCount,
          grammarMechanics,
          structureOrganization,
          contentRelevance,
          overallRubricScore
        });

        const updatedRubricScores = {
          ...(rs || {}),
          GRAMMAR: { ...(rs?.GRAMMAR || {}), comment: rubricComments.grammarMechanics },
          ORGANIZATION: { ...(rs?.ORGANIZATION || {}), comment: rubricComments.structureOrganization },
          CONTENT: { ...(rs?.CONTENT || {}), comment: rubricComments.contentRelevance },
          MECHANICS: { ...(rs?.MECHANICS || {}), comment: rubricComments.overallRubricScore }
        };

        try {
          const saved = await SubmissionFeedback.findOneAndUpdate(
            { submissionId: submission._id },
            { $set: { rubricScores: updatedRubricScores } },
            { new: true }
          );
          feedback = saved ? saved.toObject() : { ...feedbackObj, rubricScores: updatedRubricScores };
        } catch {
          feedback = { ...feedbackObj, rubricScores: updatedRubricScores };
        }
      }
    }

    console.log('[FEEDBACK GET]', submissionId, feedback);
    return sendSuccess(res, feedback);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch feedback');
  }
}

async function generateRubricDesignerFromContext(req, res) {
  try {
    const { submissionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const submission = await Submission.findById(submissionId).populate('assignment');
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

    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
    const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId
    });

    const assignment = submission.assignment && typeof submission.assignment === 'object' ? submission.assignment : null;
    const assignmentTitle = safeString(assignment && assignment.title).trim();
    const assignmentInstructions = safeString(assignment && assignment.instructions).trim();
    const assignmentWritingType = safeString(assignment && assignment.writingType).trim();

    const studentText = safeString(submission.transcriptText).trim() || safeString(submission.combinedOcrText).trim() || safeString(submission.ocrText).trim();

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const teacherPrompt = safeString(body.prompt).trim();
    const forceRegenerate = Boolean(body.forceRegenerate);

    if (!forceRegenerate && base && base.overriddenByTeacher && base.rubricDesigner) {
      return sendSuccess(res, existing);
    }

    const apiKey = safeString(process.env.OPENROUTER_API_KEY).trim();
    const baseUrl = safeString(process.env.OPENROUTER_BASE_URL).trim() || 'https://openrouter.ai/api/v1';
    const model = safeString(process.env.LLAMA_MODEL).trim() || 'meta-llama/llama-3-8b-instruct';
    if (!apiKey) {
      return sendError(res, 501, 'AI provider not configured');
    }

    const systemInstruction = 'You are an academic rubric generator. Return ONLY valid JSON with no explanation, no markdown, no code blocks.';

    const cappedStudentText = studentText.length > 8000 ? studentText.slice(0, 8000) : studentText;
    const rubricTitle = `Rubric: ${assignmentTitle || 'Submission'}`;

    const studentTextSection = cappedStudentText
      ? `\n\nStudent Submission Text (OCR/Transcript):\n${cappedStudentText}`
      : '';

    const userPrompt = `${teacherPrompt ? teacherPrompt + "\n\n" : ''}Generate a rubric designer for grading the student's work.\n\nAssignment Title: ${assignmentTitle || 'N/A'}\nAssignment Writing Type: ${assignmentWritingType || 'N/A'}\nAssignment Instructions: ${assignmentInstructions || 'N/A'}${studentTextSection}\n\nOutput must match this exact JSON structure:\n{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}.\nRules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. Keep criteria 3-10 rows. Keep maxPoints as integers. Make criteria relevant to the writing type. Use clear descriptions in cells for each performance level. Use title: ${rubricTitle}.`;

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
      let msg = 'Failed to generate rubric';
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
        continue;
      }
      parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
      normalized = normalizeRubricDesignerPayload(parsed);
      const candidate = normalized && normalized.value ? normalized.value : null;
      if (normalized.error || !candidate) break;
      if (isCompleteRubricDesigner(candidate)) break;
    }

    if (normalized.error || !normalized.value) {
      return sendError(res, 422, normalized.error || 'Invalid JSON rubric returned from AI');
    }

    if (!isCompleteRubricDesigner(normalized.value)) {
      return sendError(res, 422, 'AI returned an incomplete rubric. Please try again.');
    }

    const rubricDesigner = {
      ...normalized.value,
      title: normalized.value.title && String(normalized.value.title).trim().length ? normalized.value.title : rubricTitle
    };

    const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      {
        $set: {
          submissionId: submission._id,
          classId: submission.class,
          studentId: submission.student,
          teacherId,
          rubricDesigner: sanitizedRubricDesigner,
          rubricScores: base.rubricScores || {},
          overriddenByTeacher: false
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric');
  }
}

async function generateRubricDesignerFromFile(req, res) {
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

    const file = req && req.file;
    if (!file || !file.buffer) {
      return sendError(res, 400, 'file is required');
    }

    const normalizedMime = normalizeMimeForRubricUpload(file);
    if (!isAllowedRubricUploadMime(normalizedMime)) {
      return sendError(res, 400, 'Invalid file type. Only PDF, DOCX, XLSX, and JSON are allowed.');
    }

    if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      let rubricDesigner;
      try {
        rubricDesigner = await parseRubricDesignerFromDocxTemplate({
          buffer: file.buffer,
          title: `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`
        });
      } catch (err) {
        if (err instanceof RubricDocxTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric DOCX template');
        }
        return sendError(res, 422, 'Invalid rubric DOCX template');
      }

      const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

      const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
      const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId
      });

      const saved = await SubmissionFeedback.findOneAndUpdate(
        { submissionId: submission._id },
        {
          $set: {
            submissionId: submission._id,
            classId: submission.class,
            studentId: submission.student,
            teacherId,
            rubricDesigner: sanitizedRubricDesigner,
            rubricScores: base.rubricScores || {},
            overriddenByTeacher: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return sendSuccess(res, saved);
    }

    if (normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      let rubricDesigner;
      try {
        rubricDesigner = parseRubricDesignerFromExcelTemplate({
          buffer: file.buffer,
          title: `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`
        });
      } catch (err) {
        if (err instanceof RubricExcelTemplateError) {
          return sendError(res, err.statusCode || 422, err.message || 'Invalid rubric Excel template');
        }
        return sendError(res, 422, 'Invalid rubric Excel template');
      }

      const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

      const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
      const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId
      });

      const saved = await SubmissionFeedback.findOneAndUpdate(
        { submissionId: submission._id },
        {
          $set: {
            submissionId: submission._id,
            classId: submission.class,
            studentId: submission.student,
            teacherId,
            rubricDesigner: sanitizedRubricDesigner,
            rubricScores: base.rubricScores || {},
            overriddenByTeacher: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return sendSuccess(res, saved);
    }

    // JSON rubrics can be ingested directly without Gemini.
    if (normalizedMime === 'application/json') {
      const raw = Buffer.isBuffer(file.buffer) ? file.buffer.toString('utf8') : '';
      const parsed = safeJsonParse(raw);
      const normalized = normalizeRubricDesignerPayload(parsed);
      if (normalized.error || !normalized.value) {
        return sendError(res, 422, normalized.error || 'Invalid rubric JSON file');
      }

      const rubricDesignerTitle = normalized.value.title || `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`;
      const rubricDesigner = { ...normalized.value, title: rubricDesignerTitle };
      const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

      const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
      const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId
      });

      const saved = await SubmissionFeedback.findOneAndUpdate(
        { submissionId: submission._id },
        {
          $set: {
            submissionId: submission._id,
            classId: submission.class,
            studentId: submission.student,
            teacherId,
            rubricDesigner: sanitizedRubricDesigner,
            rubricScores: base.rubricScores || {},
            overriddenByTeacher: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return sendSuccess(res, saved);
    }

    const fileCall = await callGeminiGenerateRubricFromFile({
      promptText: safeString(req.body && req.body.prompt).trim(),
      fileMime: normalizedMime,
      fileBuffer: file.buffer
    });
    if (fileCall.error) {
      return sendError(res, fileCall.error.statusCode, fileCall.error.message);
    }

    const cleaned = stripMarkdownCodeFences(fileCall.content);
    const parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
    const normalized = normalizeRubricDesignerPayload(parsed);
    if (normalized.error || !normalized.value) {
      return sendError(res, 422, normalized.error || 'Invalid JSON rubric returned from Gemini');
    }

    const rubricDesignerTitle = normalized.value.title || `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`;
    const rubricDesigner = { ...normalized.value, title: rubricDesignerTitle };
    const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
    const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId
    });

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      {
        $set: {
          submissionId: submission._id,
          classId: submission.class,
          studentId: submission.student,
          teacherId,
          rubricDesigner,
          rubricScores: base.rubricScores || {},
          overriddenByTeacher: false
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric from file');
  }
}

function applyCorrectionsToText(text, corrections) {
  const base = typeof text === 'string' ? text : '';
  const list = Array.isArray(corrections) ? corrections : [];

  const edits = list
    .map((c) => {
      const start = typeof c?.startChar === 'number' ? c.startChar : Number(c?.startChar);
      const end = typeof c?.endChar === 'number' ? c.endChar : Number(c?.endChar);
      const replacement = typeof c?.suggestedText === 'string' ? c.suggestedText : '';
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      if (!replacement) return null;
      return { start, end, replacement };
    })
    .filter(Boolean)
    .sort((a, b) => b.start - a.start);

  let out = base;
  for (const e of edits) {
    if (e.start < 0 || e.end > out.length) continue;
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

function normalizeForMatch(value) {
  return safeString(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(a, b) {
  const aa = normalizeForMatch(a);
  const bb = normalizeForMatch(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 100;

  const aTokens = new Set(aa.split(' ').filter(Boolean));
  const bTokens = new Set(bb.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter += 1;
  const union = aTokens.size + bTokens.size - inter;
  return union ? (inter / union) * 100 : 0;
}

function buildRubricDesignerFilledFromRubricScores({ rubricDesigner, rubricScores }) {
  const d = rubricDesigner && typeof rubricDesigner === 'object' ? rubricDesigner : null;
  const rs = rubricScores && typeof rubricScores === 'object' ? rubricScores : {};
  if (!d) return null;

  const criteria = Array.isArray(d.criteria) ? d.criteria : [];
  const levels = Array.isArray(d.levels) ? d.levels : [];
  const levelCount = levels.length;

  const scoreEntries = Object.entries(rs)
    .map(([key, item]) => {
      const obj = item && typeof item === 'object' ? item : {};
      return {
        key: safeString(key).trim(),
        comment: safeString(obj.comment).trim()
      };
    })
    .filter((x) => x.key.length);

  const toTitleCase = (value) => {
    const s = safeString(value).trim();
    if (!s) return '';
    return s
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  const buildCandidates = (entry) => {
    const raw = safeString(entry && entry.key).trim();
    const spaced = raw.replace(/_/g, ' ');
    return [raw, spaced, toTitleCase(spaced)].filter((x) => safeString(x).trim().length);
  };

  const filled = criteria.map((row) => {
    const title = safeString(row && row.title).trim();
    const cellsRaw = Array.isArray(row && row.cells) ? row.cells : [];
    const cells = Array.from({ length: levelCount }).map((_, i) => safeString(cellsRaw[i]));

    let best = null;
    let bestScore = 0;
    for (const entry of scoreEntries) {
      for (const candidate of buildCandidates(entry)) {
        const s = similarityScore(title, candidate);
        if (s > bestScore) {
          bestScore = s;
          best = entry;
        }
      }
    }

    if (best && best.comment) {
      cells[0] = best.comment;
    }

    return {
      title,
      cells
    };
  });

  return {
    title: safeString(d.title).trim(),
    levels: levels.map((l) => ({
      title: safeString(l && l.title).trim(),
      maxPoints: Number.isFinite(Number(l && l.maxPoints)) ? Math.max(0, Math.floor(Number(l.maxPoints))) : 0
    })),
    criteria: filled
  };
}

async function generateAiRubricFromDesigner(req, res) {
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

    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
    const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId
    });

    const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
      ? String(submission.transcriptText)
      : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
        ? String(submission.combinedOcrText)
        : (submission.ocrText && String(submission.ocrText).trim())
          ? String(submission.ocrText)
          : '';

    if (!transcriptText.trim()) {
      return sendError(res, 422, 'OCR text is not available for this submission yet');
    }

    const normalizedWords = normalizeOcrWordsFromStored(submission.ocrData && submission.ocrData.words);

    let built;
    try {
      built = await buildOcrCorrections({
        text: transcriptText,
        language: (req.body && req.body.language) ? String(req.body.language) : 'en-US',
        ocrWords: normalizedWords
      });
    } catch {
      built = { corrections: [], fullText: transcriptText };
    }

    const corrections = Array.isArray(built && built.corrections) ? built.corrections : [];
    const correctedText = applyCorrectionsToText(transcriptText, corrections);

    const evaluation = computeAcademicEvaluation({
      text: correctedText,
      issues: corrections,
      teacherOverrideScores: null
    });

    const counts = computeCountsFromCorrections(corrections);

    const er = evaluation && evaluation.effectiveRubric ? evaluation.effectiveRubric : null;
    const to5 = (score100) => clampScore5((Number(score100) || 0) / 20);

    const rubricComments = buildDynamicRubricComments({
      wordCount: Number(evaluation?.rubric?.wordCount) || 0,
      grammarCount: Number(counts?.GRAMMAR) || 0,
      mechanicsCount: Number(counts?.MECHANICS) || 0,
      organizationCount: Number(counts?.ORGANIZATION) || 0,
      contentCount: Number(counts?.CONTENT) || 0,
      paragraphCount: Number(evaluation?.rubric?.paragraphCount) || 0,
      grammarMechanics: to5(er && er.grammarScore),
      structureOrganization: to5(er && er.structureScore),
      contentRelevance: to5(er && er.contentScore),
      overallRubricScore: (to5(er && er.grammarScore) + to5(er && er.structureScore) + to5(er && er.contentScore)) / 3
    });

    const rubricScores = {
      ...(base.rubricScores || {}),
      CONTENT: {
        score: to5(er && er.contentScore),
        maxScore: 5,
        comment: safeString(rubricComments && rubricComments.contentRelevance).trim() || safeString(base?.rubricScores?.CONTENT?.comment)
      },
      ORGANIZATION: {
        score: to5(er && er.structureScore),
        maxScore: 5,
        comment: safeString(rubricComments && rubricComments.structureOrganization).trim() || safeString(base?.rubricScores?.ORGANIZATION?.comment)
      },
      GRAMMAR: {
        score: to5(er && er.grammarScore),
        maxScore: 5,
        comment: safeString(rubricComments && rubricComments.grammarMechanics).trim() || safeString(base?.rubricScores?.GRAMMAR?.comment)
      },
      VOCABULARY: {
        score: to5(er && er.vocabularyScore),
        maxScore: 5,
        comment: safeString(base?.rubricScores?.VOCABULARY?.comment)
      },
      MECHANICS: {
        score: to5(er && er.taskAchievementScore),
        maxScore: 5,
        comment: safeString(rubricComments && rubricComments.overallRubricScore).trim() || safeString(base?.rubricScores?.MECHANICS?.comment)
      }
    };

    const structuredFeedback = evaluation && evaluation.structuredFeedback ? evaluation.structuredFeedback : null;
    const aiFeedback = buildAiFeedbackDefaults({
      rubricScores,
      structuredFeedback,
      overallComments: ''
    });

    const detailedFeedback = ensureDetailedFeedbackDynamic({
      detailedFeedback: buildDetailedFeedbackDefaults({ structuredFeedback }),
      counts
    });

    const rubricDesignerTitle = `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`;
    const existingDesigner = base && base.rubricDesigner ? base.rubricDesigner : null;
    const designerBase = existingDesigner || buildRubricDesignerFromRubricScores({ rubricScores, title: rubricDesignerTitle });
    const rubricDesigner = buildRubricDesignerFilledFromRubricScores({ rubricDesigner: designerBase, rubricScores }) || designerBase;
    const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

    const update = {
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId,
      rubricScores,
      detailedFeedback,
      aiFeedback,
      rubricDesigner: sanitizedRubricDesigner,
      overriddenByTeacher: false,
      overallScore: computeCombinedOverallScore100({ rubricScores, languageToolScore100: clampScore100(er && er.overallScore), rubricWeight: 0.7 }),
      grade: gradeFromOverallScore100(computeCombinedOverallScore100({ rubricScores, languageToolScore100: clampScore100(er && er.overallScore), rubricWeight: 0.7 }))
    };

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric');
  }
}

async function generateAiSubmissionFeedback(req, res) {
  try {
    const { submissionId } = req.params;

    console.log('Checking dynamic fields for submission', submissionId);

    console.log('Generating dynamic AI Feedback for submission', submissionId);

    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      return sendError(res, 400, 'Invalid submission id');
    }

    const teacherId = req.user && req.user._id;
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }

    console.log('Generate AI for submission', submissionId);
    console.log('Dynamic summary generation for submission', submissionId);

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

    const transcriptText = (submission.transcriptText && String(submission.transcriptText).trim())
      ? String(submission.transcriptText)
      : (submission.ocrText && String(submission.ocrText).trim())
        ? String(submission.ocrText)
        : '';

    const normalizedWords = normalizeOcrWordsFromStored(submission.ocrData && submission.ocrData.words);

    let built;
    try {
      built = await buildOcrCorrections({
        text: transcriptText,
        language: (req.body && req.body.language) ? String(req.body.language) : 'en-US',
        ocrWords: normalizedWords
      });
    } catch {
      built = { corrections: [], fullText: transcriptText };
    }

    const aiCfg = normalizeTeacherAiConfig(req.user);
    const allCorrections = Array.isArray(built && built.corrections) ? built.corrections : [];
    const corrections = filterCorrectionsByAiConfig(allCorrections, aiCfg);
    const counts = augmentCountsWithTextHeuristics(transcriptText, computeCountsFromCorrections(corrections));

    const correctedText = applyCorrectionsToText(transcriptText, corrections);

    const clamp5 = (n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return 0;
      return Math.max(0, Math.min(5, x));
    };

    const canUseRubricsAi = Boolean(normalizedAssignmentRubrics);

    if (canUseRubricsAi) {
      const apiKey = safeString(process.env.OPENROUTER_API_KEY).trim();
      const baseUrl = safeString(process.env.OPENROUTER_BASE_URL).trim() || 'https://openrouter.ai/api/v1';
      const model = safeString(process.env.LLAMA_MODEL).trim() || 'meta-llama/llama-3-8b-instruct';

      if (apiKey) {
        const { systemInstruction, userPrompt } = buildRubricsPrompt({
          assignmentTitle: assignment && assignment.title,
          correctedText,
          corrections,
          rubrics: normalizedAssignmentRubrics
        });

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
        } finally {
          cancel();
        }

        if (resp && resp.ok) {
          const json = await resp.json();
          const content = safeString(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content).trim();
          const cleaned = stripMarkdownCodeFences(content);
          const parsed = safeJsonParse(cleaned) || extractFirstJsonObject(cleaned);
          const normalized = normalizeAiRubricEvaluationResponse(parsed);

          if (normalized) {
            const gmCrit = findCriterionByTitle(normalizedAssignmentRubrics, 'Grammar & Mechanics');
            const soCrit = findCriterionByTitle(normalizedAssignmentRubrics, 'Structure & Organization');
            const crCrit = findCriterionByTitle(normalizedAssignmentRubrics, 'Content Relevance');

            const maxScore = (crit) => {
              const lvls = Array.isArray(crit && crit.levels) ? crit.levels : [];
              const max = lvls.reduce((m, l) => Math.max(m, Number(l && l.score) || 0), 0);
              return Number.isFinite(max) ? max : 0;
            };

            const gm5 = toScore5FromLevel({ selectedLevelScore: normalized.gm.score, maxLevelScore: maxScore(gmCrit) });
            const so5 = toScore5FromLevel({ selectedLevelScore: normalized.so.score, maxLevelScore: maxScore(soCrit) });
            const cr5 = toScore5FromLevel({ selectedLevelScore: normalized.cr.score, maxLevelScore: maxScore(crCrit) });

            const overallRubricScore5 = clampScore5((gm5 + so5 + cr5) / 3);

            const rubricScores = {
              CONTENT: { score: cr5, maxScore: 5, comment: normalized.cr.feedback },
              ORGANIZATION: { score: so5, maxScore: 5, comment: normalized.so.feedback },
              GRAMMAR: { score: gm5, maxScore: 5, comment: normalized.gm.feedback },
              VOCABULARY: { score: 0, maxScore: 5, comment: '' },
              MECHANICS: { score: overallRubricScore5, maxScore: 5, comment: normalized.overall.feedback }
            };

            const evaluation = computeAcademicEvaluation({
              text: correctedText,
              issues: corrections,
              teacherOverrideScores: null
            });

            const languageToolScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
            const overallScore100 = computeCombinedOverallScore100({ rubricScores, languageToolScore100, rubricWeight: 0.7 });
            const grade = gradeFromOverallScore100(overallScore100);

            const detailedFeedback = ensureDetailedFeedbackDynamic({
              detailedFeedback: buildDetailedFeedbackDefaults({ structuredFeedback: evaluation && evaluation.structuredFeedback }),
              counts
            });

            const aiFeedback = buildAiFeedbackDefaults({
              rubricScores,
              structuredFeedback: evaluation && evaluation.structuredFeedback,
              overallComments: ''
            });

            const update = {
              submissionId: submission._id,
              classId: submission.class,
              studentId: submission.student,
              teacherId,
              overallScore: overallScore100,
              grade,
              correctionStats: {
                content: counts.CONTENT,
                grammar: counts.GRAMMAR,
                organization: counts.ORGANIZATION,
                vocabulary: counts.VOCABULARY,
                mechanics: counts.MECHANICS
              },
              detailedFeedback,
              rubricScores,
              aiFeedback,
              overriddenByTeacher: false
            };

            const saved = await SubmissionFeedback.findOneAndUpdate(
              { submissionId: submission._id },
              { $set: update },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            return sendSuccess(res, saved);
          }
        }
      }
    }

    const safeText = typeof transcriptText === 'string' ? transcriptText : '';
    const wordCount = safeText.trim() ? safeText.trim().split(/\s+/).filter(Boolean).length : 0;

    const grammarCount = Number(counts && counts.GRAMMAR) || 0;
    const mechanicsCount = Number(counts && counts.MECHANICS) || 0;
    const organizationCount = Number(counts && counts.ORGANIZATION) || 0;
    const contentCount = Number(counts && counts.CONTENT) || 0;

    const penaltyCfg = strictnessPenaltyConfig(aiCfg.strictness);

    const grammarMechanicsIssues = grammarCount + mechanicsCount;
    const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * penaltyCfg.gm);

    const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;
    const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
    const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * penaltyCfg.org);

    const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
    const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * penaltyCfg.content);

    const overallRubricScore = clamp5((grammarMechanics + structureOrganization + contentRelevance) / 3);

    console.log('Dynamic AI rubric generated for submission', submissionId);

    const rubricComments = buildDynamicRubricComments({
      wordCount,
      grammarCount,
      mechanicsCount,
      organizationCount,
      contentCount,
      paragraphCount,
      grammarMechanics,
      structureOrganization,
      contentRelevance,
      overallRubricScore
    });

    const rubricScores = {
      CONTENT: { score: contentRelevance, maxScore: 5, comment: rubricComments.contentRelevance },
      ORGANIZATION: { score: structureOrganization, maxScore: 5, comment: rubricComments.structureOrganization },
      GRAMMAR: { score: grammarMechanics, maxScore: 5, comment: rubricComments.grammarMechanics },
      VOCABULARY: { score: 0, maxScore: 5, comment: '' },
      MECHANICS: { score: overallRubricScore, maxScore: 5, comment: rubricComments.overallRubricScore }
    };

    const evaluation = computeAcademicEvaluation({
      text: correctedText,
      issues: corrections,
      teacherOverrideScores: null
    });

    const languageToolScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
    const overallScore100 = computeCombinedOverallScore100({ rubricScores, languageToolScore100, rubricWeight: 0.7 });
    const grade = gradeFromOverallScore100(overallScore100);

    const overallComments = buildGeneralComments({
      text: correctedText,
      rubricScores: {
        CONTENT: contentRelevance,
        ORGANIZATION: structureOrganization,
        GRAMMAR: grammarMechanics
      },
      counts
    });
    const detailedFeedback = ensureDetailedFeedbackDynamic({
      detailedFeedback: buildDetailedFeedbackDefaults({ structuredFeedback: evaluation && evaluation.structuredFeedback }),
      counts
    });
    const aiFeedback = buildAiFeedbackDefaults({
      rubricScores,
      structuredFeedback: evaluation && evaluation.structuredFeedback,
      overallComments
    });

    // Teacher comment must start empty and must not be AI-generated.
    aiFeedback.overallComments = '';
    console.log('Teacher comment initialized as empty');

    const update = {
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId,
      overallScore: overallScore100,
      grade,
      correctionStats: {
        content: counts.CONTENT,
        grammar: counts.GRAMMAR,
        organization: counts.ORGANIZATION,
        vocabulary: counts.VOCABULARY,
        mechanics: counts.MECHANICS
      },
      detailedFeedback,
      rubricScores,
      aiFeedback,
      overriddenByTeacher: false
    };

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate AI feedback');
  }
}

async function generateAiRubricDesigner(req, res) {
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

    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
    const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId
    });

    const rubricDesignerTitle = `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`;
    const rubricDesigner = buildRubricDesignerFromRubricScores({ rubricScores: base.rubricScores, title: rubricDesignerTitle });

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      {
        $set: {
          submissionId: submission._id,
          classId: submission.class,
          studentId: submission.student,
          teacherId,
          rubricDesigner
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric');
  }
}

async function upsertSubmissionFeedback(req, res) {
  try {
    const { submissionId } = req.params;

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
      return sendError(res, 403, 'No permission');
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    console.log('[FEEDBACK UPSERT]', submissionId, body);

    const detailedFeedbackObj = body.detailedFeedback && typeof body.detailedFeedback === 'object' ? body.detailedFeedback : {};

    const rubric = body.rubricScores && typeof body.rubricScores === 'object' ? body.rubricScores : {};
    const keys = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS'];
    const normalizedRubric = {};
    for (const k of keys) {
      const normalized = normalizeRubricItemPayload(rubric[k]);
      if (normalized.error) {
        return sendError(res, 400, `rubricScores.${k}.${normalized.error}`);
      }
      normalizedRubric[k] = normalized.value;
    }

    // Accept both the new contract (body.detailedFeedback.*) and legacy root arrays.
    const strengths = normalizeStringArrayPayload(
      typeof detailedFeedbackObj.strengths !== 'undefined' ? detailedFeedbackObj.strengths : body.strengths
    );
    if (strengths === null) {
      return sendError(res, 400, 'strengths must be an array of strings');
    }

    const areasForImprovement = normalizeStringArrayPayload(
      typeof detailedFeedbackObj.areasForImprovement !== 'undefined'
        ? detailedFeedbackObj.areasForImprovement
        : body.areasForImprovement
    );
    if (areasForImprovement === null) {
      return sendError(res, 400, 'areasForImprovement must be an array of strings');
    }

    const actionSteps = normalizeStringArrayPayload(
      typeof detailedFeedbackObj.actionSteps !== 'undefined' ? detailedFeedbackObj.actionSteps : body.actionSteps
    );
    if (actionSteps === null) {
      return sendError(res, 400, 'actionSteps must be an array of strings');
    }

    const aiFeedbackObj = body.aiFeedback && typeof body.aiFeedback === 'object' ? body.aiFeedback : {};
    const perCategory = normalizeAiFeedbackPerCategoryPayload(aiFeedbackObj.perCategory);
    if (perCategory === null) {
      return sendError(res, 400, 'aiFeedback.perCategory must be an array');
    }
    const aiOverallComments = typeof aiFeedbackObj.overallComments === 'string'
      ? aiFeedbackObj.overallComments
      : (aiFeedbackObj.overallComments == null ? '' : String(aiFeedbackObj.overallComments));

    const normalizedRubricDesigner = normalizeRubricDesignerPayload(body.rubricDesigner);
    if (normalizedRubricDesigner.error) {
      return sendError(res, 400, normalizedRubricDesigner.error);
    }

    const overallScore = typeof body.overallScore === 'number' || typeof body.overallScore === 'string'
      ? clampScore100(body.overallScore)
      : undefined;
    if (typeof body.overallScore !== 'undefined' && typeof overallScore !== 'number') {
      return sendError(res, 400, 'overallScore must be a number');
    }

    const grade = typeof overallScore === 'number' ? gradeFromOverallScore100(overallScore) : undefined;

    const update = {
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId,
      rubricScores: normalizedRubric,
      overriddenByTeacher: true,
      detailedFeedback: {
        strengths,
        areasForImprovement,
        actionSteps
      },
      aiFeedback: {
        perCategory,
        overallComments: aiOverallComments
      },
      rubricDesigner: normalizedRubricDesigner.value
    };

    if (typeof overallScore === 'number') {
      update.overallScore = overallScore;
      update.grade = grade;
    }

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to save feedback');
  }
}

function clampScore5(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(5, v));
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

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripMarkdownCodeFences(text) {
  const s = safeString(text).trim();
  if (!s) return '';

  // Common Gemini / LLM formatting: ```json ... ``` or ``` ... ```
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && fenced[1]) return String(fenced[1]).trim();

  // If it's not a pure fenced block, still try to remove any fenced wrappers.
  return s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function normalizeAssignmentRubrics(value) {
  const obj = value && typeof value === 'object' ? value : null;
  const criteriaRaw = Array.isArray(obj && obj.criteria) ? obj.criteria : null;
  if (!criteriaRaw) return null;

  const criteria = criteriaRaw
    .map((c) => {
      const row = c && typeof c === 'object' ? c : {};
      const name = safeString(row.name).trim();
      const levelsRaw = Array.isArray(row.levels) ? row.levels : [];
      const levels = levelsRaw
        .map((l) => {
          const lvl = l && typeof l === 'object' ? l : {};
          const score = Number(lvl.score);
          return {
            title: safeString(lvl.title).trim(),
            score: Number.isFinite(score) ? score : 0,
            description: safeString(lvl.description).trim()
          };
        })
        .filter((l) => l.title.length || l.description.length)
        .slice(0, 10);

      return { name, levels };
    })
    .filter((c) => c.name.length && Array.isArray(c.levels) && c.levels.length)
    .slice(0, 100);

  if (!criteria.length) return null;
  return { criteria };
}

function normalizeRubricCriterionKey(name) {
  return safeString(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function findCriterionByTitle(rubrics, title) {
  const crit = Array.isArray(rubrics && rubrics.criteria) ? rubrics.criteria : [];
  const target = normalizeRubricCriterionKey(title);
  return crit.find((c) => normalizeRubricCriterionKey(c && c.name) === target) || null;
}

function toScore5FromLevel({ selectedLevelScore, maxLevelScore }) {
  const sel = Number(selectedLevelScore);
  const max = Number(maxLevelScore);
  if (!Number.isFinite(sel) || !Number.isFinite(max) || max <= 0) return 0;
  return clampScore5((sel / max) * 5);
}

function buildRubricsPrompt({ assignmentTitle, correctedText, corrections, rubrics }) {
  const required = ['Grammar & Mechanics', 'Structure & Organization', 'Content Relevance'];

  const criteriaPayload = required
    .map((t) => ({ title: t, criterion: findCriterionByTitle(rubrics, t) }))
    .filter((x) => x.criterion);

  const systemInstruction = 'You are an academic evaluator. Return ONLY valid JSON. No explanation, no markdown, no code blocks.';

  const correctionsCompact = (Array.isArray(corrections) ? corrections : [])
    .slice(0, 60)
    .map((c) => ({
      message: safeString(c && (c.message || c.description)).trim(),
      groupKey: safeString(c && (c.groupKey || c.groupLabel || c.category)).trim(),
      wrongText: safeString(c && (c.wrongText || c.text)).trim(),
      suggestedText: safeString(c && (c.suggestedText || c.suggestion)).trim()
    }));

  const userPrompt = `Evaluate the student's submission using the teacher-provided rubric criteria and the provided grammar corrections.\n\nAssignment: ${safeString(assignmentTitle).trim() || 'N/A'}\n\nCorrected Student Text:\n${safeString(correctedText).slice(0, 8000)}\n\nGrammar Corrections (LanguageTool):\n${JSON.stringify(correctionsCompact)}\n\nRubric Criteria (use these EXACT titles and choose ONE level per criterion):\n${JSON.stringify(criteriaPayload)}\n\nOutput JSON must match exactly:\n{\n  "Grammar & Mechanics": {"selectedLevelTitle": "string", "score": number, "feedback": "string"},\n  "Structure & Organization": {"selectedLevelTitle": "string", "score": number, "feedback": "string"},\n  "Content Relevance": {"selectedLevelTitle": "string", "score": number, "feedback": "string"},\n  "Overall Rubric Score": {"score": number, "feedback": "string"}\n}\n\nRules:\n- Keep the 4 top-level keys EXACTLY as written.\n- For each category, selectedLevelTitle must match one of the provided level titles for that criterion.\n- Use the level's numeric score as the category score.\n- Overall Rubric Score.score should be the sum of the 3 category scores.\n- Feedback must be concise and directly tied to the rubric descriptions and the grammar corrections.`;

  return { systemInstruction, userPrompt };
}

function normalizeAiRubricEvaluationResponse(value) {
  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) return null;

  const pick = (k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null);
  const requiredKeys = ['Grammar & Mechanics', 'Structure & Organization', 'Content Relevance', 'Overall Rubric Score'];
  if (!requiredKeys.every((k) => pick(k) && typeof pick(k) === 'object')) return null;

  const normItem = (x) => {
    const it = x && typeof x === 'object' ? x : {};
    const score = Number(it.score);
    return {
      selectedLevelTitle: safeString(it.selectedLevelTitle).trim(),
      score: Number.isFinite(score) ? score : 0,
      feedback: safeString(it.feedback).trim()
    };
  };

  const gm = normItem(pick('Grammar & Mechanics'));
  const so = normItem(pick('Structure & Organization'));
  const cr = normItem(pick('Content Relevance'));
  const overall = normItem(pick('Overall Rubric Score'));

  return {
    gm,
    so,
    cr,
    overall
  };
}

function normalizeMimeForRubricUpload(file) {
  const name = safeString(file && file.originalname).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const mimetype = safeString(file && file.mimetype).toLowerCase();

  // Normalize common cases from browsers.
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // Fall back to mimetype if it looks safe.
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

function buildGeminiBaseUrlCandidates(baseUrl) {
  const raw = safeString(baseUrl).trim() || 'https://generativelanguage.googleapis.com/v1';
  const normalized = raw.replace(/\/$/, '');

  const v1 = normalized.replace(/\/v1beta$/i, '/v1').replace(/\/v1beta\//i, '/v1/');
  const v1beta = normalized.replace(/\/v1$/i, '/v1beta').replace(/\/v1\//i, '/v1beta/');

  if (v1 === v1beta) return [v1];
  return [v1, v1beta].filter((x, i, a) => x && a.indexOf(x) === i);
}

function buildGeminiModelCandidates(model) {
  const m = safeString(model).trim();
  const list = [
    m,
    'gemini-1.5-flash-latest',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest'
  ].map((x) => safeString(x).trim()).filter(Boolean);

  return list.filter((x, i, a) => a.indexOf(x) === i);
}

function isGeminiModelNotSupportedError(statusCode, message) {
  const msg = safeString(message).toLowerCase();
  if (statusCode === 404) return true;
  if (msg.includes('model') && msg.includes('not found')) return true;
  if (msg.includes('not supported') && msg.includes('generatecontent')) return true;
  if (msg.includes('api version') && msg.includes('not found')) return true;
  return false;
}

async function geminiGenerateContentWithFallback({ apiKey, baseUrl, model, contents, timeoutMs }) {
  const baseUrls = buildGeminiBaseUrlCandidates(baseUrl);
  const models = buildGeminiModelCandidates(model);

  let lastErr = { statusCode: 502, message: 'Failed to contact Gemini' };

  for (const b of baseUrls) {
    for (const m of models) {
      const { signal, cancel } = buildTimeoutSignal(timeoutMs);
      const endpoint = `${b.replace(/\/$/, '')}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      let resp;
      try {
        resp = await fetchCompat(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents }),
          signal
        });
      } catch (err) {
        const name = err && typeof err === 'object' ? safeString(err.name) : '';
        const msg = err && typeof err === 'object' ? safeString(err.message) : '';
        cancel();
        if (name === 'AbortError' || /aborted/i.test(msg)) {
          return { error: { statusCode: 504, message: 'Gemini request timed out. Please try again.' } };
        }
        lastErr = { statusCode: 502, message: msg || 'Gemini request failed' };
        continue;
      } finally {
        cancel();
      }

      if (resp && resp.ok) {
        const json = await resp.json();
        return { json };
      }

      let msg = 'Gemini error';
      let status = resp && typeof resp.status === 'number' ? resp.status : 502;
      try {
        const errJson = resp ? await resp.json() : null;
        const gemMsg = safeString(errJson && errJson.error && errJson.error.message).trim();
        if (gemMsg) msg = gemMsg;
      } catch {
        try {
          const errText = resp ? safeString(await resp.text()) : '';
          if (errText) msg = errText;
        } catch {
          // ignore
        }
      }

      if (status === 429) {
        return { error: { statusCode: 429, message: 'Gemini quota exceeded. Please try again later.' } };
      }

      lastErr = { statusCode: 502, message: msg || 'Gemini request failed' };
      if (isGeminiModelNotSupportedError(status, msg)) {
        continue;
      }

      return { error: lastErr };
    }
  }

  return { error: lastErr };
}

async function callGeminiGenerateRubricFromFile({ promptText, fileMime, fileBuffer }) {
  const apiKey = safeString(process.env.GEMINI_API_KEY).trim();
  const baseUrl = safeString(process.env.GEMINI_BASE_URL).trim() || 'https://generativelanguage.googleapis.com/v1';
  const model = safeString(process.env.GEMINI_MODEL).trim() || 'gemini-1.5-flash-latest';

  if (!apiKey) {
    return { error: { statusCode: 501, message: 'Gemini not configured' } };
  }

  const systemInstruction =
    'You are an academic rubric generator.\n' +
    'You will be given a document file that contains a rubric or rubric-like guidance.\n' +
    'Return ONLY valid JSON.\n' +
    'Do not include explanation text.\n' +
    'Do not include markdown.\n' +
    'Do not include code blocks.\n' +
    'Output must match this exact structure:\n' +
    '{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}.\n' +
    'Rules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. ' +
    'Keep criteria 3-10 rows. Keep maxPoints as integers.\n';

  const fullPrompt = `${systemInstruction}\nTeacher context/instructions:\n${safeString(promptText).trim() || 'Convert the attached file into the required rubric JSON.'}`;

  const timeoutMs = Math.min(30000, Math.max(1, Number(process.env.GEMINI_TIMEOUT_MS) || 30000));
  const resp = await geminiGenerateContentWithFallback({
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    contents: [
      {
        parts: [
          { text: fullPrompt },
          {
            inlineData: {
              mimeType: safeString(fileMime).toLowerCase(),
              data: Buffer.isBuffer(fileBuffer) ? fileBuffer.toString('base64') : ''
            }
          }
        ]
      }
    ]
  });

  if (resp.error) {
    return { error: resp.error };
  }

  const json = resp.json;
  const parts =
    json && json.candidates && json.candidates[0] && json.candidates[0].content &&
    Array.isArray(json.candidates[0].content.parts)
      ? json.candidates[0].content.parts
      : [];

  const content = parts.map((p) => safeString(p && p.text)).join('\n').trim();
  if (!content) {
    return { error: { statusCode: 422, message: 'Gemini returned an empty response' } };
  }

  return { content };
}

function extractFirstJsonObject(text) {
  const s = safeString(text);
  if (!s) return null;

  // Try a fast path first.
  const direct = safeJsonParse(s);
  if (direct && typeof direct === 'object') return direct;

  // Scan for the first balanced-brace JSON object that successfully parses.
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

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prompt = safeString(body.prompt).trim();
    if (!prompt) {
      return sendError(res, 400, 'prompt is required');
    }

    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
    const base = existing ? existing.toObject() : buildDefaultSubmissionFeedbackDoc({
      submissionId: submission._id,
      classId: submission.class,
      studentId: submission.student,
      teacherId
    });

    const apiKey = safeString(process.env.OPENROUTER_API_KEY).trim();
    const baseUrl = safeString(process.env.OPENROUTER_BASE_URL).trim() || 'https://openrouter.ai/api/v1';
    const model = safeString(process.env.LLAMA_MODEL).trim() || 'meta-llama/llama-3-8b-instruct';

    if (!apiKey) {
      return sendError(res, 501, 'AI provider not configured');
    }

    const systemInstruction = 'You are an academic rubric generator. Return ONLY valid JSON with no explanation, no markdown, no code blocks.';
    const userPrompt = `${prompt}\n\nOutput must match this exact JSON structure:\n{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}. Rules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. Keep criteria 3-10 rows. Keep maxPoints as integers.`;

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
      if (sc === 401 || sc === 403) {
        status = 502;
        msg = msg || 'AI authentication failed';
      }
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

    const rubricDesignerTitle = normalized.value.title || `Rubric: ${safeString((submission && (submission.title || submission.name)) || '').trim() || 'Submission'}`;
    const rubricDesigner = { ...normalized.value, title: rubricDesignerTitle };

    const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

    const saved = await SubmissionFeedback.findOneAndUpdate(
      { submissionId: submission._id },
      {
        $set: {
          submissionId: submission._id,
          classId: submission.class,
          studentId: submission.student,
          teacherId,
          rubricDesigner: sanitizedRubricDesigner,
          rubricScores: base.rubricScores || {},
          overriddenByTeacher: false
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, saved);
  } catch (err) {
    return sendError(res, 500, 'Failed to generate rubric from prompt');
  }
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

async function getFeedbackBySubmissionForTeacher(req, res) {
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

    // Required: Feedback collection must be the single source of truth. Teachers fetch feedback by submissionId
    // and we only allow access if they own the class (access control remains unchanged).
    const classDoc = await Class.findOne({
      _id: submission.class,
      teacher: teacherId,
      isActive: true
    });

    if (!classDoc) {
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
    : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
      ? String(submission.combinedOcrText)
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

function augmentCountsWithTextHeuristics(text, counts) {
  if (!text || typeof text !== 'string') return counts;
  const next = { ...counts };

  const paragraphCount = text.split(/\n\s*\n/).filter((p) => p.trim().length).length;
  if (paragraphCount <= 1) {
    next.ORGANIZATION = (Number(next.ORGANIZATION) || 0) + 1;
  }

  const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length).length;
  if (sentenceCount < 3) {
    next.CONTENT = (Number(next.CONTENT) || 0) + 1;
  }

  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length >= 30) {
    const freq = new Map();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    let maxCount = 0;
    for (const c of freq.values()) maxCount = Math.max(maxCount, c);
    if (maxCount / Math.max(1, words.length) > 0.08) {
      next.VOCABULARY = (Number(next.VOCABULARY) || 0) + 1;
    }
  }

  return next;
}

function ensureDetailedFeedbackDynamic({ detailedFeedback, counts }) {
  const out = detailedFeedback && typeof detailedFeedback === 'object'
    ? {
        strengths: Array.isArray(detailedFeedback.strengths) ? detailedFeedback.strengths : [],
        areasForImprovement: Array.isArray(detailedFeedback.areasForImprovement) ? detailedFeedback.areasForImprovement : [],
        actionSteps: Array.isArray(detailedFeedback.actionSteps) ? detailedFeedback.actionSteps : []
      }
    : { strengths: [], areasForImprovement: [], actionSteps: [] };

  const c = counts && typeof counts === 'object' ? counts : {};
  const grammar = Number(c.GRAMMAR) || 0;
  const vocab = Number(c.VOCABULARY) || 0;
  const org = Number(c.ORGANIZATION) || 0;
  const content = Number(c.CONTENT) || 0;

  if (!out.strengths.length) {
    const strengths = [];
    if (org <= 1) strengths.push('Clear paragraph structure');
    if (content <= 1) strengths.push('Ideas are present and on-topic');
    if (grammar <= 1) strengths.push('Good grammar control overall');
    if (!strengths.length) strengths.push('Shows effort and engagement with the task');
    out.strengths = strengths;
  }

  if (!out.areasForImprovement.length) {
    const areas = [];
    if (grammar > 0) areas.push('Minor grammar and punctuation mistakes');
    if (org > 0) areas.push('Improve paragraphing and logical flow');
    if (vocab > 0) areas.push('Vocabulary variety could be richer');
    if (content > 0) areas.push('Develop ideas with clearer examples and details');
    out.areasForImprovement = areas.length ? areas.slice(0, 3) : ['Improve clarity and completeness of ideas'];
  }

  if (!out.actionSteps.length) {
    const steps = [];
    if (org > 0) steps.push('Split your response into introduction, body, and conclusion paragraphs');
    if (content > 0) steps.push('Add 1-2 concrete examples to support your main points');
    if (grammar > 0) steps.push('Review LanguageTool suggestions and re-check tense/agreement and punctuation');
    if (vocab > 0) steps.push('Replace repeated words with suitable synonyms and more precise terms');
    out.actionSteps = steps.length ? steps.slice(0, 5) : ['Proofread and revise for clarity'];
  }

  return out;
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

    const ocrText = (submission.transcriptText && String(submission.transcriptText).trim())
      ? String(submission.transcriptText)
      : (submission.combinedOcrText && String(submission.combinedOcrText).trim())
        ? String(submission.combinedOcrText)
        : (typeof submission.ocrText === 'string' ? submission.ocrText : '');
    if (!String(ocrText || '').trim()) {
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
  generateAiSubmissionFeedback,
  generateAiRubricDesigner,
  generateAiRubricFromDesigner,
  generateRubricDesignerFromPrompt,
  generateRubricDesignerFromContext,
  generateRubricDesignerFromFile,
  updateFeedback,
  getSubmissionFeedback,
  upsertSubmissionFeedback,
  getFeedbackBySubmissionForStudent,
  getFeedbackBySubmissionForTeacher,
  getFeedbackByIdForTeacher,
  listFeedbackByClassForTeacher
};
