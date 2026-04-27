const FlashcardSet = require('../models/FlashcardSet');
const FlashcardSubmission = require('../models/FlashcardSubmission');

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

    const participants = submissions.map((s) => ({
      userId: s.userId && s.userId._id ? String(s.userId._id) : String(s.userId),
      userName:
        s.userId && (s.userId.displayName || s.userId.email)
          ? s.userId.displayName || s.userId.email
          : 'Unknown',
      score: s.score || 0,
      timeTaken: s.timeTaken || 0,
      submittedAt: s.submittedAt,
      status: 'completed',
    }));

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
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = {
  getReport,
};
