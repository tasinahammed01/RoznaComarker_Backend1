const path = require('path');

const mongoose = require('mongoose');

const Upload = require('../models/Upload');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');

const { ApiError } = require('../middlewares/error.middleware');

function getUploadsRoot() {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.join(__dirname, '..', '..', basePath);
}

function toStoredPath(folder, filename) {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.posix.join(basePath, folder, filename);
}

async function getAssignmentOrThrow(assignmentId) {
  if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
    throw new ApiError(400, 'Invalid assignment id');
  }

  const assignment = await Assignment.findOne({ _id: assignmentId, isActive: true });
  if (!assignment) {
    throw new ApiError(404, 'Assignment not found');
  }

  const classDoc = await Class.findOne({ _id: assignment.class, isActive: true });
  if (!classDoc) {
    throw new ApiError(404, 'Class not found');
  }

  return { assignment, classDoc };
}

async function assertStudentMembershipOrThrow(studentId, classId) {
  const membership = await Membership.findOne({
    student: studentId,
    class: classId,
    status: 'active'
  });

  if (!membership) {
    throw new ApiError(403, 'Not class member');
  }
}

async function getSubmissionOrThrow(submissionId) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    throw new ApiError(400, 'Invalid submission id');
  }

  const submission = await Submission.findById(submissionId);
  if (!submission) {
    throw new ApiError(404, 'Submission not found');
  }

  return submission;
}

async function assertTeacherOwnsClassOrThrow(teacherId, classId) {
  const classDoc = await Class.findOne({ _id: classId, teacher: teacherId, isActive: true });
  if (!classDoc) {
    throw new ApiError(403, 'Forbidden');
  }

  return classDoc;
}

async function upsertOriginal({ studentId, assignmentId, submissionId, file }) {
  if (!file || !file.filename) {
    throw new ApiError(400, 'No file provided');
  }

  const { assignment, classDoc } = await getAssignmentOrThrow(assignmentId);
  await assertStudentMembershipOrThrow(studentId, classDoc._id);

  let resolvedSubmissionId;
  if (submissionId) {
    const submission = await getSubmissionOrThrow(submissionId);

    if (String(submission.student) !== String(studentId)) {
      throw new ApiError(403, 'Forbidden');
    }

    if (String(submission.assignment) !== String(assignment._id)) {
      throw new ApiError(400, 'Submission does not belong to assignment');
    }

    resolvedSubmissionId = submission._id;
  }

  const storedPath = toStoredPath('original', file.filename);

  const doc = await Upload.findOneAndUpdate(
    {
      assignmentId: assignment._id,
      studentId,
      ...(resolvedSubmissionId ? { submissionId: resolvedSubmissionId } : {})
    },
    {
      $set: {
        assignmentId: assignment._id,
        studentId,
        ...(resolvedSubmissionId ? { submissionId: resolvedSubmissionId } : {}),
        uploadedBy: studentId,
        originalFilePath: storedPath,
        originalFilename: file.filename
      }
    },
    { new: true, upsert: true }
  );

  return doc;
}

async function upsertProcessed({ teacherId, submissionId, file }) {
  if (!file || !file.filename) {
    throw new ApiError(400, 'No file provided');
  }

  const submission = await getSubmissionOrThrow(submissionId);

  await assertTeacherOwnsClassOrThrow(teacherId, submission.class);

  const storedPath = toStoredPath('processed', file.filename);

  const doc = await Upload.findOneAndUpdate(
    {
      submissionId: submission._id
    },
    {
      $set: {
        assignmentId: submission.assignment,
        studentId: submission.student,
        submissionId: submission._id,
        uploadedBy: teacherId,
        processedFilePath: storedPath,
        processedFilename: file.filename
      }
    },
    { new: true, upsert: true }
  );

  return doc;
}

async function setSubmissionTranscript({ teacherId, submissionId, transcriptText }) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    throw new ApiError(400, 'Invalid submission id');
  }

  if (!transcriptText || typeof transcriptText !== 'string' || !transcriptText.trim()) {
    throw new ApiError(400, 'transcriptText is required');
  }

  const submission = await Submission.findById(submissionId);
  if (!submission) {
    throw new ApiError(404, 'Submission not found');
  }

  await assertTeacherOwnsClassOrThrow(teacherId, submission.class);

  submission.transcriptText = transcriptText.trim();
  const saved = await submission.save();

  return Submission.findById(saved._id)
    .populate('student', '_id email displayName photoURL role')
    .populate('assignment')
    .populate('class')
    .populate('file');
}

function getAbsolutePathForStoredFile(folder, filename) {
  const root = getUploadsRoot();
  return path.join(root, folder, filename);
}

module.exports = {
  getUploadsRoot,
  toStoredPath,
  getAbsolutePathForStoredFile,
  upsertOriginal,
  upsertProcessed,
  setSubmissionTranscript,
  getAssignmentOrThrow,
  getSubmissionOrThrow,
  assertTeacherOwnsClassOrThrow
};
