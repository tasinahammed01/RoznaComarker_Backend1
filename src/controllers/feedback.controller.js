const mongoose = require('mongoose');
const path = require('path');

const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const Feedback = require('../models/Feedback');
const SubmissionFeedback = require('../models/SubmissionFeedback');
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

function clampScore100(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
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
          language: 'en-US',
          ocrWords: normalizedWords
        });
      } catch {
        built = { corrections: [], fullText: transcriptText };
      }

      const corrections = Array.isArray(built && built.corrections) ? built.corrections : [];
      const counts = augmentCountsWithTextHeuristics(transcriptText, computeCountsFromCorrections(corrections));

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

      // Grammar & Mechanics (/5) based on issue density.
      const grammarMechanicsIssues = grammarCount + mechanicsCount;
      const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * 60);

      // Structure & Organization (/5) from paragraph structure + organization issues.
      const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;
      const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
      const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * 40);

      // Content Relevance (/5) from content issues + very short submissions penalty.
      const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
      const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * 40);

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
        text: transcriptText,
        issues: corrections,
        teacherOverrideScores: null
      });

      const overallScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
      const grade = evaluation && evaluation.effectiveRubric && typeof evaluation.effectiveRubric.gradeLetter === 'string'
        ? evaluation.effectiveRubric.gradeLetter
        : gradeFromOverallScore100(overallScore100);

      const overallComments = buildGeneralComments({ text: transcriptText, rubricScores: { CONTENT: contentRelevance, ORGANIZATION: structureOrganization, GRAMMAR: grammarMechanics }, counts });
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

    const corrections = Array.isArray(built && built.corrections) ? built.corrections : [];
    const counts = augmentCountsWithTextHeuristics(transcriptText, computeCountsFromCorrections(corrections));

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

    const grammarMechanicsIssues = grammarCount + mechanicsCount;
    const grammarMechanics = clamp5(5 - (grammarMechanicsIssues / Math.max(1, wordCount)) * 60);

    const paragraphCount = safeText.split(/\n\s*\n+/).filter((p) => String(p).trim()).length;
    const paragraphPenalty = paragraphCount >= 3 ? 0 : paragraphCount === 2 ? 0.5 : 1;
    const structureOrganization = clamp5(5 - paragraphPenalty - (organizationCount / Math.max(1, wordCount)) * 40);

    const lengthPenalty = wordCount >= 120 ? 0 : wordCount >= 60 ? 0.5 : 1;
    const contentRelevance = clamp5(5 - lengthPenalty - (contentCount / Math.max(1, wordCount)) * 40);

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
      text: transcriptText,
      issues: corrections,
      teacherOverrideScores: null
    });

    const overallScore100 = clampScore100(evaluation && evaluation.effectiveRubric && evaluation.effectiveRubric.overallScore);
    const grade = evaluation && evaluation.effectiveRubric && typeof evaluation.effectiveRubric.gradeLetter === 'string'
      ? evaluation.effectiveRubric.gradeLetter
      : gradeFromOverallScore100(overallScore100);

    const overallComments = buildGeneralComments({
      text: transcriptText,
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
      }
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
  updateFeedback,
  getSubmissionFeedback,
  upsertSubmissionFeedback,
  getFeedbackBySubmissionForStudent,
  getFeedbackBySubmissionForTeacher,
  getFeedbackByIdForTeacher,
  listFeedbackByClassForTeacher
};
