const mongoose = require('mongoose');
const StudentFlashcardProgress = require('../models/StudentFlashcardProgress');
const FlashcardSet = require('../models/FlashcardSet');
const Assignment = require('../models/assignment.model');
const Membership = require('../models/membership.model');
const User = require('../models/user.model');
const logger = require('../utils/logger');
const FlashcardAnswerCheck = require('../models/FlashcardAnswerCheck');

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message, code, field) {
  return res.status(statusCode).json({ success: false, ...(code ? { code } : {}), message, ...(field ? { field } : {}) });
}

function invalidProgressPayload(req, res, message, field) {
  logger.warn({ event: 'flashcard.progress.validation_failed', setId: String(req.params?.setId || ''),
    assignmentIdPresent: Boolean(req.body?.assignmentId || req.query?.assignmentId),
    bodyFields: Object.keys(req.body || {}), field, code: 'INVALID_PROGRESS_PAYLOAD' });
  return sendError(res, 400, message, 'INVALID_PROGRESS_PAYLOAD', field);
}

function revisionConflict(res, revision) {
  return res.status(409).json({
    success: false,
    code: 'PROGRESS_VERSION_CONFLICT',
    message: 'Progress was updated in another session.',
    data: { revision: Number(revision) || 0 }
  });
}

function progressSaveErrorDetails(err) {
  const validationErrors = err?.errors && typeof err.errors === 'object'
    ? Object.fromEntries(Object.entries(err.errors).map(([field, value]) => [field, {
      name: value?.name,
      message: value?.message,
      kind: value?.kind
    }]))
    : undefined;
  return {
    event: 'flashcard.progress.save_failed',
    name: err?.name || 'Error',
    message: err?.message || 'Unknown error',
    code: err?.code,
    ...(validationErrors ? { validationErrors } : {}),
    ...(process.env.NODE_ENV !== 'production' && err?.stack ? { stack: err.stack } : {})
  };
}

/**
 * PATCH /api/flashcards/:setId/progress
 * Save or update student progress for a flashcard set.
 * Called on every card navigation to persist progress.
 */
async function saveProgress(req, res) {
  try {
    const { setId } = req.params;
    const studentId = req.user && req.user._id;
    
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }
    
    if (!mongoose.Types.ObjectId.isValid(setId)) {
      return invalidProgressPayload(req, res, 'Invalid flashcard set ID', 'setId');
    }
    
    const { 
      lastCardIndex, 
      cardsViewed, 
      cardResults, 
      assignmentId,
      template,
      totalCards,
      currentCardId,
      cardProgress,
      expectedRevision
    } = req.body || {};
    
    // Validate required fields
    if (typeof lastCardIndex !== 'number' || !Array.isArray(cardsViewed)) {
      return invalidProgressPayload(req, res, 'lastCardIndex (number) and cardsViewed (array) are required',
        typeof lastCardIndex !== 'number' ? 'lastCardIndex' : 'cardsViewed');
    }
    
    // Get flashcard set to verify it exists and get totalCards if not provided
    const flashcardSet = await FlashcardSet.findById(setId).lean();
    if (!flashcardSet) {
      return sendError(res, 404, 'Flashcard set not found');
    }
    
    const resolvedTotalCards = (flashcardSet.cards?.length) || 0;
    const canonicalCardIds = new Set((flashcardSet.cards || []).map((card) => String(card._id)));
    const resolvedTemplate = flashcardSet.template || 'term-def';
    
    // Verify assignment access if assignmentId provided
    let classId = null;
    if (assignmentId) {
      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        return invalidProgressPayload(req, res, 'Invalid assignment ID', 'assignmentId');
      }
      
      const assignment = await Assignment.findOne({
        _id: assignmentId,
        resourceType: 'flashcard',
        resourceId: setId,
        isActive: true
      }).lean();
      
      if (!assignment) {
        return sendError(res, 404, 'Assignment not found or inactive');
      }
      
      // Verify student is enrolled in the class
      const membership = await Membership.findOne({
        student: studentId,
        class: assignment.class,
        status: 'active'
      }).lean();
      
      if (!membership) {
        return sendError(res, 403, 'Not enrolled in this class');
      }
      
      classId = assignment.class;
    } else if (flashcardSet.visibility === 'private') return sendError(res, 403, 'Forbidden');
    
    // Build the query to find existing progress
    const query = {
      studentId: new mongoose.Types.ObjectId(studentId),
      flashcardSetId: new mongoose.Types.ObjectId(setId)
    };
    
    if (assignmentId) {
      query.assignmentId = new mongoose.Types.ObjectId(assignmentId);
    } else {
      query.assignmentId = null;
    }
    
    const existingProgress = await StudentFlashcardProgress.findOne(query);
    if (existingProgress?.status === 'completed') {
      return sendSuccess(res, existingProgress);
    }
    if (expectedRevision !== undefined && Number(expectedRevision) !== Number(existingProgress?.revision || 0)) {
      return revisionConflict(res, existingProgress?.revision);
    }

    // Build update data
    const updateData = {
      lastCardIndex: Math.min(Math.max(0, lastCardIndex), Math.max(resolvedTotalCards - 1, 0)),
      cardsViewed: [],
      completedCards: 0,
      lastActivityAt: new Date(),
      template: resolvedTemplate,
      totalCards: resolvedTotalCards
    };
    const incomingByCardId = new Map();
    for (const item of Array.isArray(cardProgress) ? cardProgress : []) {
      const cardId = String(item?.cardId || '');
      if (canonicalCardIds.has(cardId)) incomingByCardId.set(cardId, item);
    }

    if (resolvedTemplate === 'qa') {
      const checks = await FlashcardAnswerCheck.find({ flashcardSetId: setId, userId: studentId,
        ...(assignmentId ? { assignmentId } : { assignmentId: null }) }).lean();
      const checksByCard = new Map(checks.map((check) => [String(check.cardId), check]));
      updateData.cardProgress = [...incomingByCardId.entries()].map(([cardId, item]) => {
          const checked = checksByCard.get(cardId);
          return checked ? { cardId, studentAnswer: checked.studentAnswer,
            isChecked: true, isCorrect: checked.isCorrect, gradingMethod: checked.gradingMethod,
            checkedAt: checked.checkedAt, completedAt: checked.checkedAt }
            : { cardId, studentAnswer: String(item.studentAnswer || '').slice(0, 4000),
              isChecked: false, isCorrect: null, gradingMethod: null, checkedAt: null,
              selfRating: null, completedAt: null };
        });
      updateData.cardResults = new Map();
    } else {
      const legacyRatings = new Map();
      for (const [key, value] of Object.entries(cardResults && typeof cardResults === 'object' ? cardResults : {})) {
        if (value !== 'knew' && value !== 'didnt_know') continue;
        const numericIndex = /^\d+$/u.test(key) ? Number(key) : -1;
        const cardId = canonicalCardIds.has(key) ? key
          : String(flashcardSet.cards?.[numericIndex]?._id || '');
        if (canonicalCardIds.has(cardId)) legacyRatings.set(cardId, value);
      }
      const existingByCardId = new Map((existingProgress?.cardProgress || [])
        .map((item) => [String(item.cardId), item]));
      const normalized = new Map();
      for (const card of flashcardSet.cards || []) {
        const cardId = String(card._id);
        const incoming = incomingByCardId.get(cardId);
        const existing = existingByCardId.get(cardId);
        const rating = incoming?.selfRating === 'knew' || incoming?.selfRating === 'didnt_know'
          ? incoming.selfRating : legacyRatings.get(cardId) || existing?.selfRating;
        if (rating !== 'knew' && rating !== 'didnt_know') continue;
        normalized.set(cardId, { cardId, studentAnswer: '', selfRating: rating,
          isChecked: false, isCorrect: null, gradingMethod: null, checkedAt: null,
          completedAt: existing?.completedAt || new Date() });
      }
      updateData.cardProgress = [...normalized.values()];
      updateData.cardResults = new Map([...normalized.entries()].map(([cardId, item]) => [cardId, item.selfRating]));
    }

    const completedIds = new Set(updateData.cardProgress
      .filter((item) => resolvedTemplate === 'qa' ? item.isChecked === true : Boolean(item.selfRating))
      .map((item) => String(item.cardId)));
    updateData.cardsViewed = (flashcardSet.cards || []).map((card, index) =>
      completedIds.has(String(card._id)) ? index : null).filter((index) => index !== null);
    updateData.completedCards = Math.min(completedIds.size, resolvedTotalCards);
    
    // Auto-calculate status based on progress
    const completedCount = updateData.completedCards;
    if (resolvedTotalCards > 0 && completedCount >= resolvedTotalCards) {
      updateData.status = 'completed';
      updateData.completedAt = new Date();
      updateData.currentCardId = null;
    } else if (completedCount > 0 || updateData.cardProgress?.some((item) => item.studentAnswer)) {
      updateData.status = 'in_progress';
      updateData.completedAt = null;
      if (!await StudentFlashcardProgress.exists({ ...query, startedAt: { $ne: null } })) {
        updateData.startedAt = new Date();
      }
      if (currentCardId && canonicalCardIds.has(String(currentCardId))) updateData.currentCardId = currentCardId;
    } else {
      updateData.status = 'not_started';
      updateData.completedAt = null;
      updateData.currentCardId = currentCardId && canonicalCardIds.has(String(currentCardId)) ? currentCardId : null;
    }
    
    if (classId) {
      updateData.classId = classId;
    }
    
    // Upsert progress record
    const expectedRevisionNumber = Number(expectedRevision);
    const revisionCondition = expectedRevisionNumber === 0
      ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
      : { revision: expectedRevisionNumber };
    const updateQuery = existingProgress && expectedRevision !== undefined
      ? { ...query, ...revisionCondition }
      : query;
    const progress = await StudentFlashcardProgress.findOneAndUpdate(
      updateQuery,
      { $set: updateData, $inc: { revision: 1 } },
      { 
        new: true, 
        upsert: !existingProgress,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );
    if (!progress) {
      const latest = await StudentFlashcardProgress.findOne(query).select('revision').lean();
      return revisionConflict(res, latest?.revision);
    }
    logger.debug({ event: 'FLASHCARD_PROGRESS_SAVE', setId: String(setId),
      assignmentId: assignmentId ? String(assignmentId) : null,
      currentCardId: progress.currentCardId ? String(progress.currentCardId) : null,
      revision: progress.revision || 0,
      cardProgress: (progress.cardProgress || []).map((item) => ({ cardId: String(item.cardId),
        isChecked: item.isChecked === true,
        isCorrect: typeof item.isCorrect === 'boolean' ? item.isCorrect : null })) });
    logger.metric({ event: existingProgress ? (progress.status === 'completed' ? 'flashcard.progress.completed' : 'flashcard.progress.saved') : 'flashcard.progress.created',
      userId: String(studentId), flashcardSetId: String(setId), status: progress.status });
    
    return sendSuccess(res, {
      progressId: progress._id,
      status: progress.status,
      lastCardIndex: progress.lastCardIndex,
      completedCards: progress.completedCards,
      totalCards: progress.totalCards,
      cardsRemaining: progress.cardsRemaining,
      progressPercentage: progress.progressPercentage,
      startedAt: progress.startedAt,
      lastActivityAt: progress.lastActivityAt,
      completedAt: progress.completedAt
      ,revision: progress.revision
    });
    
  } catch (err) {
    logger.error(progressSaveErrorDetails(err));
    return sendError(res, 500, 'Unable to save flashcard progress.', 'FLASHCARD_PROGRESS_SAVE_FAILED');
  }
}

/**
 * GET /api/flashcards/:setId/progress
 * Get current student's progress for a flashcard set.
 * Used to resume study from where the student left off.
 */
async function getProgress(req, res) {
  try {
    const { setId } = req.params;
    const studentId = req.user && req.user._id;
    const assignmentId = req.query?.assignmentId ? String(req.query.assignmentId).trim() : '';
    
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }
    
    if (!mongoose.Types.ObjectId.isValid(setId)) {
      return invalidProgressPayload(req, res, 'Invalid flashcard set ID', 'setId');
    }
    
    // Build the query
    const query = {
      studentId: new mongoose.Types.ObjectId(studentId),
      flashcardSetId: new mongoose.Types.ObjectId(setId)
    };
    
    if (assignmentId && !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return invalidProgressPayload(req, res, 'Invalid assignment ID', 'assignmentId');
    }

    const flashcardSet = await FlashcardSet.findById(setId).lean();
    if (!flashcardSet) return sendError(res, 404, 'Flashcard set not found');
    if (assignmentId) {
      const assignment = await Assignment.findOne({ _id: assignmentId, resourceType: 'flashcard',
        resourceId: setId, isActive: true }).lean();
      if (!assignment) return sendError(res, 404, 'Assignment not found or inactive');
      const membership = await Membership.findOne({ student: studentId, class: assignment.class, status: 'active' }).lean();
      if (!membership) return sendError(res, 403, 'Not enrolled in this class');
    } else if (flashcardSet.visibility === 'private') {
      return sendError(res, 403, 'Forbidden');
    }

    if (assignmentId) {
      query.assignmentId = new mongoose.Types.ObjectId(assignmentId);
    } else {
      query.assignmentId = null;
    }
    
    const progress = await StudentFlashcardProgress.findOne(query).lean();
    
    if (!progress) {
      // Return default "not started" state
      return sendSuccess(res, {
        status: 'not_started',
        lastCardIndex: 0,
        completedCards: 0,
        totalCards: 0,
        cardsViewed: [],
        cardResults: {},
        cardsRemaining: 0,
        progressPercentage: 0,
        startedAt: null,
        lastActivityAt: null,
        completedAt: null
        ,currentCardId: null
        ,cardProgress: []
        ,revision: 0
      });
    }
    logger.debug({ event: 'FLASHCARD_PROGRESS_LOAD', setId: String(setId),
      assignmentId: assignmentId || null,
      currentCardId: progress.currentCardId ? String(progress.currentCardId) : null,
      revision: progress.revision || 0,
      cardProgress: (progress.cardProgress || []).map((item) => ({ cardId: String(item.cardId),
        isChecked: item.isChecked === true,
        isCorrect: typeof item.isCorrect === 'boolean' ? item.isCorrect : null })) });
    logger.metric({ event: 'flashcard.progress.resumed', userId: String(studentId),
      flashcardSetId: String(setId), status: progress.status });
    
    // Convert Map to plain object for JSON response
    const cardResultsObj = progress.cardResults instanceof Map
      ? Object.fromEntries(progress.cardResults)
      : progress.cardResults && typeof progress.cardResults === 'object'
        ? { ...progress.cardResults }
        : {};
    
    return sendSuccess(res, {
      status: progress.status,
      lastCardIndex: progress.lastCardIndex,
      completedCards: progress.completedCards,
      totalCards: progress.totalCards,
      cardsViewed: progress.cardsViewed || [],
      cardResults: cardResultsObj,
      cardsRemaining: progress.totalCards - progress.completedCards,
      progressPercentage: progress.totalCards > 0 
        ? Math.round((progress.completedCards / progress.totalCards) * 100) 
        : 0,
      startedAt: progress.startedAt,
      lastActivityAt: progress.lastActivityAt,
      completedAt: progress.completedAt,
      template: progress.template
      ,currentCardId: progress.currentCardId || null
      ,cardProgress: progress.cardProgress || []
      ,revision: progress.revision || 0
    });
    
  } catch (err) {
    logger.error({ event: 'flashcard.progress.load_failed', name: err?.name,
      message: err?.message, ...(process.env.NODE_ENV !== 'production' && err?.stack ? { stack: err.stack } : {}) });
    return sendError(res, 500, 'Failed to fetch progress');
  }
}

/**
 * DELETE /api/flashcards/:setId/progress
 * Reset progress for a flashcard set (Start Over functionality).
 */
async function resetProgress(req, res) {
  try {
    const { setId } = req.params;
    const studentId = req.user && req.user._id;
    const assignmentId = req.query?.assignmentId ? String(req.query.assignmentId).trim() : '';
    
    if (!studentId) {
      return sendError(res, 401, 'Unauthorized');
    }
    
    if (!mongoose.Types.ObjectId.isValid(setId)) {
      return invalidProgressPayload(req, res, 'Invalid flashcard set ID', 'setId');
    }
    
    // Build the query
    const query = {
      studentId: new mongoose.Types.ObjectId(studentId),
      flashcardSetId: new mongoose.Types.ObjectId(setId)
    };
    
    if (assignmentId && mongoose.Types.ObjectId.isValid(assignmentId)) {
      query.assignmentId = new mongoose.Types.ObjectId(assignmentId);
    } else {
      query.assignmentId = null;
    }
    
    // Delete the progress record (it will be recreated fresh on next save)
    await StudentFlashcardProgress.deleteOne(query);
    
    return sendSuccess(res, { 
      message: 'Progress reset successfully',
      status: 'not_started'
    });
    
  } catch (err) {
    logger.error('resetProgress error:', err);
    return sendError(res, 500, 'Failed to reset progress');
  }
}

/**
 * GET /api/reports/assignments/:assignmentId/progress
 * Teacher only — Get all students' progress for a flashcard assignment.
 * Returns enrollment list with progress data for each student.
 */
async function getAssignmentProgress(req, res) {
  try {
    const { assignmentId } = req.params;
    const teacherId = req.user && req.user._id;
    
    if (!teacherId) {
      return sendError(res, 401, 'Unauthorized');
    }
    
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment ID');
    }
    
    // Verify the assignment exists and belongs to this teacher
    const assignment = await Assignment.findOne({
      _id: assignmentId,
      teacher: teacherId,
      resourceType: 'flashcard',
      isActive: true
    }).lean();
    
    if (!assignment) {
      return sendError(res, 404, 'Assignment not found');
    }
    
    // Get all active students enrolled in the class
    const memberships = await Membership.find({
      class: assignment.class,
      status: 'active'
    }).populate('student', '_id displayName email photoURL').lean();
    
    const enrolledStudentIds = memberships.map(m => String(m.student?._id));
    
    // Get progress for all students in this assignment
    const progressRecords = await StudentFlashcardProgress.find({
      assignmentId: new mongoose.Types.ObjectId(assignmentId)
    }).lean();
    
    // Get completed submissions for score data
    const submissions = await FlashcardSubmission.find({
      assignmentId: new mongoose.Types.ObjectId(assignmentId)
    }).lean();
    
    // Build a map for quick lookup
    const progressMap = new Map();
    progressRecords.forEach(p => {
      progressMap.set(String(p.studentId), p);
    });
    
    const submissionMap = new Map();
    submissions.forEach(s => {
      submissionMap.set(String(s.userId), s);
    });
    
    // Build the result for all enrolled students
    const studentsProgress = memberships.map(membership => {
      const student = membership.student;
      const studentId = String(student?._id);
      const progress = progressMap.get(studentId);
      const submission = submissionMap.get(studentId);
      
      // Determine status
      let status = 'not_started';
      let completedCards = 0;
      let lastActivityAt = null;
      let completedAt = null;
      let score = null;
      let timeTaken = null;
      
      if (progress) {
        status = progress.status;
        completedCards = progress.completedCards || 0;
        lastActivityAt = progress.lastActivityAt;
        completedAt = progress.completedAt;
      }
      
      // If there's a submission, use its data for score/time
      if (submission) {
        score = submission.score ?? null;
        timeTaken = submission.timeTaken ?? null;
        if (!completedAt) {
          completedAt = submission.submittedAt;
        }
        // Override status if submission exists
        if (status !== 'completed') {
          status = 'completed';
        }
      }
      
      return {
        studentId,
        studentName: student?.displayName || student?.email || 'Unknown',
        studentPhoto: student?.photoURL || null,
        status,
        completedCards,
        totalCards: assignment.totalCards || progress?.totalCards || 0,
        cardsRemaining: (assignment.totalCards || progress?.totalCards || 0) - completedCards,
        score,
        timeTaken,
        lastActivityAt,
        completedAt,
        progressPercentage: progress?.progressPercentage || 0
      };
    });
    
    return sendSuccess(res, {
      assignmentId,
      assignmentTitle: assignment.title,
      flashcardSetId: assignment.resourceId,
      totalStudents: studentsProgress.length,
      completedCount: studentsProgress.filter(s => s.status === 'completed').length,
      inProgressCount: studentsProgress.filter(s => s.status === 'in_progress').length,
      notStartedCount: studentsProgress.filter(s => s.status === 'not_started').length,
      students: studentsProgress
    });
    
  } catch (err) {
    logger.error('getAssignmentProgress error:', err);
    return sendError(res, 500, 'Failed to fetch assignment progress');
  }
}

module.exports = {
  saveProgress,
  getProgress,
  resetProgress,
  getAssignmentProgress
};
