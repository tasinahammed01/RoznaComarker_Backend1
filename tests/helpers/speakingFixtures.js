'use strict';
// Synthetic people, a class and a speaking assignment for the speaking/audio suites, plus an audio submission made directly in the database
// (for the guard inventory and playback tests). No real names, recordings or credentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const User = require('../../src/models/user.model');
const Class = require('../../src/models/class.model');
const Membership = require('../../src/models/membership.model');
const Assignment = require('../../src/models/assignment.model');
const Submission = require('../../src/models/Submission');
const AudioRecording = require('../../src/models/AudioRecording');
const File = require('../../src/models/File');
const storage = require('../../src/services/audio/storage');
const { signTestJwt } = require('./auth');
const samples = require('./audioSamples');

const rid = () => crypto.randomUUID();
const person = async (role, label, extra = {}) => {
  const user = await User.create({ firebaseUid: rid(), email: `${label}@example.com`, role, displayName: label, ...extra });
  return { user, token: signTestJwt({ id: user._id, role, firebaseUid: user.firebaseUid }) };
};

/** teacher, otherTeacher, student, otherStudent (not in the class), klass, speaking (assignment), essay (assignment in the same class). */
async function seedSpeaking({ deadline = new Date(Date.now() + 7 * 86400000), speaking = {}, classExtra = {} } = {}) {
  const teacher = await person('teacher', 'speaking-teacher');
  const otherTeacher = await person('teacher', 'other-teacher');
  const student = await person('student', 'speaking-student');
  const otherStudent = await person('student', 'other-student');
  const klass = await Class.create({ name: 'Speaking 9B', teacher: teacher.user._id, joinCode: `S${rid().slice(0, 8)}`, ...classExtra });
  await Membership.create({ student: student.user._id, class: klass._id, status: 'active' });
  const assignment = await Assignment.create({ title: 'Describe your town', writingType: 'speaking', resourceType: 'speaking', class: klass._id,
    teacher: teacher.user._id, deadline, qrToken: rid(), speaking: { maxRecordingSeconds: null, rubricRef: null, ...speaking } });
  const essay = await Assignment.create({ title: 'River essay', writingType: 'essay', resourceType: 'essay', class: klass._id, teacher: teacher.user._id,
    deadline, qrToken: rid() });
  return { teacher, otherTeacher, student, otherStudent, klass, assignment, essay };
}

/** An audio submission stored directly (no HTTP): File on disk + AudioRecording + Submission. */
async function makeAudioSubmission(f, { status = 'ready', seconds = 8, mode = 'registered', bytes = samples.wav(seconds), contentType = 'audio/wav' } = {}) {
  fs.mkdirSync(storage.audioRoot(), { recursive: true });
  const filename = `${rid()}.wav`;
  fs.writeFileSync(path.join(storage.audioRoot(), filename), bytes);
  const file = await File.create({ originalName: 'recording.wav', filename, path: storage.storedPathFor(filename), url: `internal:audio/${filename}`,
    uploadedBy: f.student.user._id, role: 'student', type: 'audio', sizeBytes: bytes.length });
  const recording = await AudioRecording.create({ owner: f.student.user._id, requestId: rid(), audioFileId: file._id, contentType, sizeBytes: bytes.length,
    durationSeconds: seconds, storageChargedTo: f.student.user._id, storageChargedMB: Number((bytes.length / 1048576).toFixed(4)),
    minutesChargedTo: f.teacher.user._id, status });
  const submission = await Submission.create({ ...(mode === 'guest' ? { submissionMode: 'guest', guest: { displayName: 'Guest Speaker', normalizedEmail: 'guest.speaker@example.com' } }
    : { student: f.student.user._id }), assignment: f.assignment._id, class: f.klass._id, sourceKind: 'audio', audioRecording: recording._id,
  status: 'submitted', submittedAt: new Date(), isLate: false, files: [] });
  await AudioRecording.updateOne({ _id: recording._id }, { $set: { submissionId: submission._id } });
  return { submission, recording, file, bytes, absolute: path.join(storage.audioRoot(), filename) };
}

module.exports = { seedSpeaking, makeAudioSubmission, person, rid };
