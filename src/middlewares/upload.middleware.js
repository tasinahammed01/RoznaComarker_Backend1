const multer = require('multer');

const fs = require('fs');
const path = require('path');

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

  return path.join(uploadsRoot, 'uploads');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeOriginalName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length ? cleaned : 'file';
}

function chooseSafeFilename({ userId, originalName, destination }) {
  const ts = Date.now();
  const safeName = sanitizeOriginalName(originalName);
  const baseCandidate = `${userId}_${ts}_${safeName}`;

  const candidatePath = path.join(destination, baseCandidate);
  if (!fs.existsSync(candidatePath)) return baseCandidate;

  const random = Math.random().toString(16).slice(2, 10);
  return `${userId}_${ts}_${random}_${safeName}`;
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
      const userId = req && req.user && req.user._id ? String(req.user._id) : 'anonymous';
      const type = req && req.uploadType;
      const destination = resolveUploadFolder(type);
      const filename = chooseSafeFilename({
        userId,
        originalName: file && file.originalname,
        destination
      });
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
    const ext = path.extname(String(file && file.originalname)).toLowerCase();

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

function handleUploadError(err, req, res, next) {
  if (!err) return next();

  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'File too large. Max size is 10 MB.'
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
  handleUploadError
};
