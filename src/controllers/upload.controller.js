const logger = require('../utils/logger');

const uploadService = require('../services/upload.service');

async function uploadOriginal(req, res, next) {
  try {
    const studentId = req.user && req.user._id;
    const { assignmentId, submissionId } = req.body || {};

    const doc = await uploadService.upsertOriginal({
      studentId,
      assignmentId,
      submissionId,
      file: req.file
    });

    return res.json({
      success: true,
      data: doc
    });
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

async function uploadProcessed(req, res, next) {
  try {
    const teacherId = req.user && req.user._id;
    const { submissionId } = req.body || {};

    const doc = await uploadService.upsertProcessed({
      teacherId,
      submissionId,
      file: req.file
    });

    return res.json({
      success: true,
      data: doc
    });
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

async function saveTranscript(req, res, next) {
  try {
    const { submissionId, transcriptText } = req.body || {};

    const teacherId = req.user && req.user._id;
    const doc = await uploadService.setSubmissionTranscript({
      teacherId,
      submissionId,
      transcriptText
    });

    return res.json({
      success: true,
      data: doc
    });
  } catch (err) {
    logger.warn(err);
    return next(err);
  }
}

module.exports = {
  uploadOriginal,
  uploadProcessed,
  saveTranscript
};
