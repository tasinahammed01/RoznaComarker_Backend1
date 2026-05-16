const mongoose = require('mongoose');
const StudentFlashcardProgress = require('../models/StudentFlashcardProgress');
const FlashcardSet = require('../models/FlashcardSet');
const Assignment = require('../models/assignment.model');
const Membership = require('../models/membership.model');
const User = require('../models/user.model');
const logger = require('../utils/logger');

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
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
      return sendError(res, 400, 'Invalid flashcard set ID');
    }
    
    const { 
      lastCardIndex, 
      cardsViewed, 
      cardResults, 
      assignmentId,
      template,
      totalCards 
    } = req.body || {};
    
    // Validate required fields
    if (typeof lastCardIndex !== 'number' || !Array.isArray(cardsViewed)) {
      return sendError(res, 400, 'lastCardIndex (number) and cardsViewed (array) are required');
    }
    
    // Get flashcard set to verify it exists and get totalCards if not provided
    const flashcardSet = await FlashcardSet.findById(setId).lean();
    if (!flashcardSet) {
      return sendError(res, 404, 'Flashcard set not found');
    }
    
    const resolvedTotalCards = totalCards || (flashcardSet.cards?.length) || 0;
    
    // Verify assignment access if assignmentId provided
    let classId = null;
    if (assignmentId) {
      if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
        return sendError(res, 400, 'Invalid assignment ID');
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
    }
    
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
    
    // Build update data
    const updateData = {
      lastCardIndex: Math.max(0, lastCardIndex),
      cardsViewed: [...new Set(cardsViewed)], // Ensure unique values
      completedCards: cardsViewed.length,
      lastActivityAt: new Date(),
      template: template || flashcardSet.template || 'term-def',
      totalCards: resolvedTotalCards
    };
    
    // Add cardResults if provided
    if (cardResults && typeof cardResults === 'object') {
      updateData.cardResults = new Map(Object.entries(cardResults));
    }
    
    // Auto-calculate status based on progress
    if (resolvedTotalCards > 0 && cardsViewed.length >= resolvedTotalCards) {
      updateData.status = 'completed';
      updateData.completedAt = new Date();
    } else if (cardsViewed.length > 0) {
      updateData.status = 'in_progress';
      if (!await StudentFlashcardProgress.exists({ ...query, startedAt: { $ne: null } })) {
        updateData.startedAt = new Date();
      }
    }
    
    if (classId) {
      updateData.classId = classId;
    }
    
    // Upsert progress record
    const progress = await StudentFlashcardProgress.findOneAndUpdate(
      query,
      { $set: updateData },
      { 
        new: true, 
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );
    
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
    });
    
  } catch (err) {
    logger.error('saveProgress error:', err);
    return sendError(res, 500, 'Failed to save progress');
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
      return sendError(res, 400, 'Invalid flashcard set ID');
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
      });
    }
    
    // Convert Map to plain object for JSON response
    const cardResultsObj = progress.cardResults 
      ? Object.fromEntries(progress.cardResults) 
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
    });
    
  } catch (err) {
    logger.error('getProgress error:', err);
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
      return sendError(res, 400, 'Invalid flashcard set ID');
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
