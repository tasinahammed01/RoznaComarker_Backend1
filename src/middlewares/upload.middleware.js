const multer = require('multer');

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const logger = require('../utils/logger');

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png'
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

function getMaxFileSizeBytes() {
  const parsed = Number(process.env.MAX_FILE_SIZE);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_SIZE_BYTES;
  return parsed;
}

function getUploadsRoot() {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.join(__dirname, '..', '..', basePath);
}

function resolveUploadFolder(type) {
  const uploadsRoot = getUploadsRoot();

  if (type === 'assignments') return path.join(uploadsRoot, 'assignments');
  if (type === 'submissions') return path.join(uploadsRoot, 'submissions');
  if (type === 'feedback') return path.join(uploadsRoot, 'feedback');

  if (type === 'original') return path.join(uploadsRoot, 'original');
  if (type === 'processed') return path.join(uploadsRoot, 'processed');
  if (type === 'transcripts') return path.join(uploadsRoot, 'transcripts');

  if (type === 'avatars') return path.join(uploadsRoot, 'avatars');

  return path.join(uploadsRoot, 'uploads');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getExtensionForMime(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  return null;
}

function normalizeExtension(ext) {
  const lower = String(ext || '').toLowerCase();
  if (lower === '.jpeg') return '.jpg';
  return lower;
}

function chooseSafeFilename(file) {
  const extFromName = normalizeExtension(path.extname(String(file && file.originalname)));
  const extFromMime = getExtensionForMime(file && file.mimetype);
  const ext = ALLOWED_EXTENSIONS.has(extFromName) ? extFromName : extFromMime;
  const normalized = normalizeExtension(ext);
  return `${uuidv4()}${normalized || ''}`;
}

function detectSignatureKind(buf) {
  if (!buf || buf.length < 4) return null;

  // PDF: 25 50 44 46 2D => %PDF-
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  return null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const type = req && req.uploadType;
      const destination = resolveUploadFolder(type);
      ensureDir(destination);
      return cb(null, destination);
    } catch (err) {
      err.statusCode = 500;
      return cb(err);
    }
  },
  filename: (req, file, cb) => {
    try {
      const type = req && req.uploadType;
      const destination = resolveUploadFolder(type);
      ensureDir(destination);
      const filename = chooseSafeFilename(file);
      return cb(null, filename);
    } catch (err) {
      err.statusCode = 500;
      return cb(err);
    }
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: getMaxFileSizeBytes()
  },
  fileFilter: (req, file, cb) => {
    const ext = normalizeExtension(path.extname(String(file && file.originalname)));

    if (!file || !file.mimetype || !ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
      const err = new Error('Invalid file type. Only PDF, JPG, JPEG, and PNG are allowed.');
      err.statusCode = 400;
      return cb(err);
    }

    return cb(null, true);
  }
});

function setUploadType(type) {
  return function uploadTypeMiddleware(req, res, next) {
    req.uploadType = type;
    return next();
  };
}

function validateUploadedFileSignature(req, res, next) {
  const file = req && req.file;
  if (!file || !file.path) return next();

  try {
    const fd = fs.openSync(file.path, 'r');
    try {
      const buf = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const snippet = buf.subarray(0, bytesRead);

      const detectedMime = detectSignatureKind(snippet);
      if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
        try {
          fs.unlinkSync(file.path);
        } catch (unlinkErr) {
          logger.warn(unlinkErr);
        }

        logger.warn({
          message: 'Rejected upload: invalid file signature',
          userId: req.user && req.user._id ? String(req.user._id) : undefined,
          originalName: file.originalname,
          storedName: file.filename,
          detectedMime
        });

        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Only PDF, JPG, JPEG, and PNG are allowed.'
        });
      }

      return next();
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try {
      if (file && file.path) {
        fs.unlink(file.path, () => {});
      }
    } catch {
      // ignore
    }

    logger.warn({
      message: 'Upload signature validation failed',
      error: err && err.message ? err.message : err,
      userId: req.user && req.user._id ? String(req.user._id) : undefined,
      storedName: file && file.filename
    });

    return res.status(400).json({
      success: false,
      message: 'File upload failed'
    });
  }
}

function handleUploadError(err, req, res, next) {
  if (!err) return next();

  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = Math.max(1, Math.ceil(getMaxFileSizeBytes() / (1024 * 1024)));
    return res.status(413).json({
      success: false,
      message: `File too large. Max size is ${maxMB} MB.`
    });
  }

  if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
    const statusCode = err.code === 'EACCES' ? 403 : 500;
    return res.status(statusCode).json({
      success: false,
      message: err.code === 'EACCES' ? 'Permission denied' : 'Upload folder missing'
    });
  }

  const statusCode = err.statusCode || 400;

  return res.status(statusCode).json({
    success: false,
    message: err.message || 'File upload failed'
  });
}

module.exports = {
  upload,
  setUploadType,
  validateUploadedFileSignature,
  handleUploadError
};
