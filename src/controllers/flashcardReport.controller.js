const FlashcardSet = require('../models/FlashcardSet');
const FlashcardSubmission = require('../models/FlashcardSubmission');
const StudentFlashcardProgress = require('../models/StudentFlashcardProgress');

function sendSuccess(res, data) {
  return res.json({ success: true, data });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

async function getReport(req, res) {
  try {
    const { id } = req.params;
    const assignmentId = req.query?.assignmentId ? String(req.query.assignmentId).trim() : '';
    const ownerId = req.user && req.user._id;

    const set = await FlashcardSet.findOne({ _id: id, ownerId });
    if (!set) {
      return sendError(res, 404, 'Flashcard set not found or not authorised');
    }

    const submissionFilter = { flashcardSetId: id };
    if (assignmentId) {
      submissionFilter.assignmentId = assignmentId;
    }

    const submissions = await FlashcardSubmission.find(submissionFilter)
      .populate('userId', 'displayName email')
      .lean();

    // Also fetch progress records for real-time status
    const progressFilter = { flashcardSetId: id };
    if (assignmentId) {
      progressFilter.assignmentId = assignmentId;
    }
    const progressRecords = await StudentFlashcardProgress.find(progressFilter)
      .populate('studentId', 'displayName email')
      .lean();

    // Create a map of progress by student ID
    const progressMap = new Map();
    progressRecords.forEach(p => {
      const studentId = String(p.studentId?._id || p.studentId);
      progressMap.set(studentId, p);
    });

    const totalSubmissions = submissions.length;

    const averageScore =
      totalSubmissions > 0
        ? Math.round(submissions.reduce((sum, s) => sum + (s.score || 0), 0) / totalSubmissions)
        : 0;

    const sortedTimes = submissions.map((s) => s.timeTaken || 0).sort((a, b) => a - b);
    const mid = Math.floor(sortedTimes.length / 2);
    const medianTimeTaken =
      sortedTimes.length === 0
        ? 0
        : sortedTimes.length % 2 !== 0
        ? sortedTimes[mid]
        : Math.round((sortedTimes[mid - 1] + sortedTimes[mid]) / 2);

    const participants = submissions.map((s) => {
      const userId = s.userId && s.userId._id ? String(s.userId._id) : String(s.userId);
      const progress = progressMap.get(userId);

      // Determine status - use progress record if available, otherwise derive from submission
      let status = 'completed'; // submissions mean completed
      if (progress) {
        status = progress.status;
      }

      return {
        userId,
        userName:
          s.userId && (s.userId.displayName || s.userId.email)
            ? s.userId.displayName || s.userId.email
            : 'Unknown',
        score: s.score || 0,
        timeTaken: s.timeTaken || 0,
        submittedAt: s.submittedAt,
        status,
        completedCards: progress?.completedCards || s.totalCards || 0,
        totalCards: progress?.totalCards || s.totalCards || 0,
      };
    });

    const cards = set.cards.map((card) => {
      const cardIdStr = String(card._id);
      const correctCount = submissions.filter((s) =>
        Array.isArray(s.results) &&
        s.results.some(
          (r) => r.cardId && String(r.cardId) === cardIdStr && r.status === 'know'
        )
      ).length;
      return {
        cardId: cardIdStr,
        front: card.front,
        correctPercentage: totalSubmissions > 0
          ? Math.round((correctCount / totalSubmissions) * 100)
          : 0,
      };
    });

    const report = {
      totalSubmissions,
      averageScore,
      medianTimeTaken,
      participants,
      cards,
    };

    return sendSuccess(res, report);
  } catch (err) {
    // If the flashcard set was deleted during report generation, return 404
    if (err.name === 'CastError' || err.message?.includes('Cast to ObjectId failed')) {
      return sendError(res, 404, 'Flashcard set not found');
    }
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = {
  getReport,
};
