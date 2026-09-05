'use strict';
const mongoose = require('mongoose');
const QRCode = require('qrcode'); const { v4: uuidv4 } = require('uuid');
const Class = require('../models/class.model'); const Assignment = require('../models/assignment.model');
const Membership = require('../models/membership.model'); const FlashcardSet = require('../models/FlashcardSet');
const Worksheet = require('../models/Worksheet'); const Operation = require('../models/SemesterCopyOperation');
const { generateShortJoinCode } = require('../utils/joinCode'); const logger = require('../utils/logger');
const MAX_ASSIGNMENTS = 200;
const copyRubrics = (value) => value == null ? undefined : JSON.parse(JSON.stringify(value));
const fail = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });

async function ownedSource(teacherId, sourceClassId) {
  if (!mongoose.Types.ObjectId.isValid(sourceClassId)) throw fail(400, 'Invalid source class ID', 'INVALID_SOURCE_ID');
  const source = await Class.findOne({ _id: sourceClassId, teacher: teacherId, isActive: { $ne: false } });
  if (!source) throw fail(404, 'Source class not found', 'SOURCE_NOT_FOUND'); return source;
}
async function preview(teacherId, sourceClassId) {
  const source = await ownedSource(teacherId, sourceClassId);
  const assignments = await Assignment.find({ class: source._id, teacher: teacherId, isActive: true }).sort({ createdAt: 1, _id: 1 }).lean();
  return { sourceClass: { id: String(source._id), name: source.name, status: source.status || 'active',
    description: source.description || '', subjectLevel: source.subjectLevel || '' }, assignments: assignments.map((x) => ({
    id: String(x._id), title: x.title, type: x.resourceType || 'essay', hasRubric: Boolean(x.rubric || x.rubrics), hasDeadline: Boolean(x.deadline)
  })) };
}
async function copyable(teacherId, search = '') {
  const filter = { teacher: teacherId, isActive: { $ne: false } }; if (String(search).trim()) filter.name = { $regex: String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return Class.find(filter).select('_id name status description subjectLevel startDate endDate').sort({ updatedAt: -1 }).limit(100).lean();
}
async function uniqueClassData(source, teacherId, values, frontendUrl) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const joinCode = generateShortJoinCode();
    try { return await Class.create({ name: String(values.name).trim(), teacher: teacherId, joinCode,
      qrCodeUrl: await QRCode.toDataURL(`${frontendUrl}/student/join-class?joinCode=${joinCode}`),
      description: values.description == null ? source.description : String(values.description).trim(),
      subjectLevel: values.subjectLevel == null ? source.subjectLevel : String(values.subjectLevel).trim(),
      startDate: values.startDate || undefined, endDate: values.endDate || undefined,
      gradingScale: source.gradingScale, lateSubmissionPenaltyPercent: source.lateSubmissionPenaltyPercent,
      autoPublishGrades: source.autoPublishGrades, isActive: true, status: 'active' }); }
    catch (error) { if (error?.code === 11000 && error?.keyPattern?.joinCode) continue; throw error; }
  } throw fail(500, 'Failed to generate unique class code', 'JOIN_CODE_FAILED');
}
async function waitForReplay(teacherId, requestId) {
  for (let i = 0; i < 30; i += 1) { const op = await Operation.findOne({ teacherId, requestId }).lean();
    if (op?.status === 'completed') return op; if (op?.status === 'failed') throw fail(409, 'Previous copy attempt failed; use a new request ID', 'REPLAY_FAILED');
    await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw fail(409, 'Semester copy is already processing', 'COPY_PROCESSING');
}
async function copySemester({ teacherId, sourceClassId, requestId, newClass, assignmentIds, deadlineMode, frontendUrl }) {
  if (!mongoose.Types.ObjectId.isValid(sourceClassId)) throw fail(400, 'Invalid source class ID', 'INVALID_SOURCE_ID');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(requestId || ''))) throw fail(400, 'Valid requestId is required', 'INVALID_REQUEST_ID');
  if (!String(newClass?.name || '').trim()) throw fail(400, 'New class name is required', 'INVALID_NAME');
  if (!Array.isArray(assignmentIds) || assignmentIds.length > MAX_ASSIGNMENTS || new Set(assignmentIds.map(String)).size !== assignmentIds.length)
    throw fail(400, 'Assignment selection is invalid', 'INVALID_ASSIGNMENTS');
  if (assignmentIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw fail(400, 'Assignment selection is invalid', 'INVALID_ASSIGNMENTS');
  if (deadlineMode !== 'unset') throw fail(400, 'Only unset deadline mode is currently supported', 'INVALID_DEADLINE_MODE');
  let operation;
  try { operation = await Operation.create({ teacherId, sourceClassId, requestId, status: 'processing', selectedAssignmentIds: assignmentIds }); }
  catch (error) { if (error?.code !== 11000) throw error; const replay = await waitForReplay(teacherId, requestId);
    logger.info({ event: 'semester_copy_replayed', teacherId: String(teacherId), sourceClassId: String(sourceClassId), targetClassId: String(replay.targetClassId), requestId });
    return { class: await Class.findById(replay.targetClassId).lean(), assignments: await Assignment.find({ _id: { $in: replay.completedAssignmentIds } }).lean(), replayed: true }; }
  let target;
  logger.info({ event: 'semester_copy_started', teacherId: String(teacherId), sourceClassId: String(sourceClassId), assignmentCount: assignmentIds.length, requestId });
  try {
    const source = await ownedSource(teacherId, sourceClassId);
    const sources = await Assignment.find({ _id: { $in: assignmentIds }, class: source._id, teacher: teacherId, isActive: true }).lean();
    if (sources.length !== assignmentIds.length) throw fail(400, 'Every selected assignment must belong to the source class', 'INVALID_ASSIGNMENT_SCOPE');
    const flashIds = [...new Set(sources.filter((x) => x.resourceType === 'flashcard').map((x) => String(x.resourceId)))];
    const worksheetIds = [...new Set(sources.filter((x) => x.resourceType === 'worksheet').map((x) => String(x.resourceId)))];
    const [flashcards, worksheets] = await Promise.all([FlashcardSet.find({ _id: { $in: flashIds }, ownerId: teacherId }).select('_id').lean(),
      Worksheet.find({ _id: { $in: worksheetIds }, createdBy: teacherId }).select('_id').lean()]);
    if (flashcards.length !== flashIds.length || worksheets.length !== worksheetIds.length) throw fail(409, 'A selected reusable resource is unavailable', 'RESOURCE_UNAVAILABLE');
    target = await uniqueClassData(source, teacherId, newClass, frontendUrl);
    const docs = sources.sort((a, b) => assignmentIds.map(String).indexOf(String(a._id)) - assignmentIds.map(String).indexOf(String(b._id))).map((x) => ({
      title: x.title, writingType: x.writingType, resourceType: x.resourceType || 'essay', resourceId: x.resourceId || null,
      instructions: x.instructions, rubric: x.rubric, rubrics: copyRubrics(x.rubrics), deadline: undefined,
      class: target._id, teacher: teacherId, qrToken: uuidv4(), allowLateResubmission: x.allowLateResubmission === true,
      showMarksToStudent: x.showMarksToStudent !== false, allowResubmission: (x.resourceType || 'essay') === 'essay' && x.allowResubmission === true,
      requireAdaptiveBeforeResubmission: (x.resourceType || 'essay') === 'essay' && x.allowResubmission === true && x.requireAdaptiveBeforeResubmission === true, isActive: true }));
    const created = docs.length ? await Assignment.insertMany(docs, { ordered: true }) : [];
    if (flashIds.length) await FlashcardSet.updateMany({ _id: { $in: flashIds }, ownerId: teacherId }, { $addToSet: { assignedClasses: target._id } });
    operation.targetClassId = target._id; operation.completedAssignmentIds = created.map((x) => x._id); operation.status = 'completed'; operation.completedAt = new Date(); await operation.save();
    logger.info({ event: 'semester_copy_completed', teacherId: String(teacherId), sourceClassId: String(sourceClassId), targetClassId: String(target._id), assignmentCount: created.length, requestId });
    return { class: target.toObject(), assignments: created.map((x) => x.toObject()), replayed: false };
  } catch (error) {
    if (target) {
      await FlashcardSet.updateMany({ assignedClasses: target._id }, { $pull: { assignedClasses: target._id } });
      await Assignment.deleteMany({ class: target._id, teacher: teacherId });
      await Class.deleteOne({ _id: target._id, teacher: teacherId });
    }
    operation.status = 'failed'; operation.errorCode = error?.code || 'COPY_FAILED'; await operation.save().catch(() => {});
    logger.error({ event: 'semester_copy_failed', teacherId: String(teacherId), sourceClassId: String(sourceClassId), targetClassId: target ? String(target._id) : null, assignmentCount: assignmentIds.length, requestId, errorCode: operation.errorCode }); throw error;
  }
}
module.exports = { MAX_ASSIGNMENTS, preview, copyable, copySemester };
