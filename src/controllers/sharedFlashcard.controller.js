/**
 * sharedFlashcard.controller.js — PART 2 (Public share link access)
 *
 * Public routes (no auth) serve flashcard set data via shareToken.
 * Submit route requires auth and checks class enrollment.
 */
const mongoose = require('mongoose');
const FlashcardSet      = require('../models/FlashcardSet');
const FlashcardSubmission = require('../models/FlashcardSubmission');
const Assignment        = require('../models/assignment.model');
const Membership        = require('../models/membership.model');

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message, extra = {}) {
  return res.status(statusCode).json({ success: false, message, ...extra });
}

/**
 * GET /api/shared/flashcards/:shareToken — public, no auth required.
 * Returns card data (title + cards) if set is public. Strips internal IDs from response.
 * @param {string} req.params.shareToken — uuid v4 token stored on FlashcardSet
 * @returns {{ title, description, cards, shareToken }}
 */
async function getSharedSet(req, res) {
  try {
    const { shareToken } = req.params;
    if (!shareToken || typeof shareToken !== 'string') {
      return sendError(res, 400, 'Invalid share token');
    }

    const set = await FlashcardSet.findOne({ shareToken, isPublic: true })
      .select('title description cards shareToken')
      .lean();

    if (!set) {
      return sendError(res, 404, 'This flashcard set is no longer available');
    }

    return sendSuccess(res, {
      title:       set.title,
      description: set.description,
      cards:       set.cards,
      shareToken:  set.shareToken
    });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /api/shared/flashcards/:shareToken/submit — auth required.
 * Records the study result. Checks whether the user is enrolled in any class
 * that has this flashcard set assigned.
 * @param {string}  req.params.shareToken
 * @param {number}  req.body.score       — 0-100
 * @param {number}  req.body.timeTaken   — seconds
 * @param {Array}   req.body.results     — array of { cardId, status }
 * @returns {{ success, assignmentId? }} or 403 NOT_ENROLLED
 */
async function submitSharedSession(req, res) {
  try {
    const { shareToken } = req.params;
    const userId = req.user && req.user._id;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const set = await FlashcardSet.findOne({ shareToken, isPublic: true }).lean();
    if (!set) return sendError(res, 404, 'Flashcard set not found');

    const setId = set._id;

    /** Find if this student is enrolled in a class that has this set assigned */
    const memberships = await Membership.find({ student: userId, status: 'active' }).select('class');
    const classIds = (memberships || []).map((m) => m.class).filter(Boolean);

    let assignmentId = null;
    if (classIds.length > 0) {
      const assignment = await Assignment.findOne({
        resourceType: 'flashcard',
        resourceId:   String(setId),
        class:        { $in: classIds },
        isActive:     true
      }).select('_id');

      if (assignment) {
        assignmentId = assignment._id;

        /** Save submission tied to the assignment */
        const existing = await FlashcardSubmission.findOne({ assignmentId, userId });
        if (!existing) {
          const { score, timeTaken, results } = req.body || {};
          await FlashcardSubmission.create({
            flashcardSetId: setId,
            userId,
            assignmentId,
            score:     typeof score === 'number' ? score : 0,
            timeTaken: typeof timeTaken === 'number' ? timeTaken : 0,
            results:   Array.isArray(results) ? results : []
          });
        }

        return sendSuccess(res, { success: true, assignmentId });
      }
    }

    /** User is authenticated but not enrolled in any matching class */
    return sendError(res, 403, 'Join the class to save your progress.', { error: 'NOT_ENROLLED' });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = { getSharedSet, submitSharedSession };
