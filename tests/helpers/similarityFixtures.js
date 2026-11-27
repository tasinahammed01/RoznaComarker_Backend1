'use strict';
// Synthetic teachers, classes, students, essay assignments and essays for the similarity suites. Essay text is generated words only
// (no real writing): words(seed, n) gives n distinct words for a seed, so two essays share text only where a test splices it in.
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../../src/models/user.model');
const Class = require('../../src/models/class.model');
const Membership = require('../../src/models/membership.model');
const Assignment = require('../../src/models/assignment.model');
const Submission = require('../../src/models/Submission');
const { signTestJwt } = require('./auth');

const rid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const PAGE_SEPARATOR = '\n\n\f\n\n';

/** n generated words for a seed, e.g. words('a', 3) = 'qa0 qa1 qa2'. */
const words = (seed, n, from = 0) => Array.from({ length: n }, (_, i) => `q${seed}${from + i}`).join(' ');

const person = async (role, label, extra = {}) => {
  const user = await User.create({ firebaseUid: rid(), email: `${label}-${rid().slice(0, 6)}@example.com`, role, displayName: label, ...extra });
  return { user, token: signTestJwt({ id: user._id, role, firebaseUid: user.firebaseUid }) };
};

async function classWithEssay({ teacher, institutionId, instructions = 'Write about your weekend.', label = 'class' } = {}) {
  const owner = teacher || await person('teacher', `${label}-teacher`);
  const klass = await Class.create({ name: `Class ${label}`, teacher: owner.user._id, joinCode: `S${rid().slice(0, 8)}`,
    ...(institutionId ? { institutionId } : {}) });
  const assignment = await Assignment.create({ title: `Essay ${label}`, writingType: 'essay', resourceType: 'essay', class: klass._id,
    teacher: owner.user._id, deadline: new Date(Date.now() + 7 * 86400000), qrToken: rid(), instructions });
  return { teacher: owner, klass, assignment };
}

async function student(klass, label = 'student') {
  const s = await person('student', label);
  await Membership.create({ student: s.user._id, class: klass._id, status: 'active' });
  return s;
}

/** A typed (OCR, not exact) essay with this text, by a student (registered) or a guest email. */
async function essay({ klass, assignment, studentUser, guestEmail, text, extra = {} }) {
  const fileId = new mongoose.Types.ObjectId();
  const owner = guestEmail ? { submissionMode: 'guest', guest: { displayName: 'Guest', normalizedEmail: guestEmail } } : { student: studentUser._id };
  return Submission.create({ ...owner, class: klass._id, assignment: assignment._id, files: [fileId], status: 'submitted', submittedAt: new Date(),
    ocrPages: [{ fileId, fileOrder: 0, pageIndex: 0, pageNumber: 1, text, words: text.split(' ').map((w, i) => ({ id: `w${i}`, text: w, page: 1 })) }],
    ...extra });
}

/** An exact-source essay (two pages); eligible unless `eligible: false` (then the stored hash does not match). */
async function exactEssay({ klass, assignment, studentUser, pages, eligible = true }) {
  const fileId = new mongoose.Types.ObjectId();
  const text = pages.join(PAGE_SEPARATOR);
  return Submission.create({ student: studentUser._id, class: klass._id, assignment: assignment._id, files: [fileId], status: 'submitted', submittedAt: new Date(),
    sourceFidelityMode: 'astra_verified', sourceFidelityStatus: 'MODEL_AGREED', sourceFidelityVersion: 'astra-fable-exact-v1',
    sourceTranscriptExact: text, sourceTranscriptSha256: eligible ? sha(text) : sha('different'),
    ocrPages: pages.map((page, i) => ({ fileId, fileOrder: 0, pageIndex: i, pageNumber: i + 1, sourceFidelityMode: 'astra_verified',
      sourceFidelityStatus: 'MODEL_AGREED', sourceFidelityVersion: 'astra-fable-exact-v1', sourceTextExact: page, sourceTextSha256: sha(page) })) });
}

module.exports = { words, person, classWithEssay, student, essay, exactEssay, PAGE_SEPARATOR };
