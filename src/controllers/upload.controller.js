const logger = require('../utils/logger');
const path = require('path');

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

async function uploadFlashcardImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const ext = path.extname(req.file.originalname);
    const filename = `flashcard-${timestamp}-${randomString}${ext}`;

    // Store file in flashcards directory
    const fs = require('fs');
    const uploadBasePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
    const flashcardsDir = path.join(__dirname, '..', '..', uploadBasePath, 'flashcards');
    
    // Ensure directory exists
    if (!fs.existsSync(flashcardsDir)) {
      fs.mkdirSync(flashcardsDir, { recursive: true });
    }

    const filepath = path.join(flashcardsDir, filename);
    fs.writeFileSync(filepath, req.file.buffer);

    // Return the URL
    const imageUrl = `/uploads/flashcards/${filename}`;
    
    logger.info(`[UPLOAD] Flashcard image uploaded: ${filename}`);

    res.json({
      success: true,
      data: {
        imageUrl
      }
    });
  } catch (error) {
    logger.error('[UPLOAD] Flashcard image upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image'
    });
  }
}

module.exports = {
  uploadOriginal,
  uploadProcessed,
  saveTranscript,
  uploadFlashcardImage
};
