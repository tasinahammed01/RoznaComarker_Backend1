const Class = require('../models/class.model');
const User = require('../models/user.model');
const { ensureActivePlan, getLimit } = require('../middlewares/usage.middleware');
const logger = require('../utils/logger');

const activeStatusFilter = {
  $or: [{ status: 'active' }, { status: { $exists: false } }]
};

function withActiveStatus(query = {}) {
  return { ...query, ...activeStatusFilter };
}

function isArchivedClass(classDoc) {
  return classDoc?.status === 'archived';
}

async function countActiveClasses(teacherId) {
  return Class.countDocuments(withActiveStatus({ teacher: teacherId, isActive: true }));
}

async function syncClassUsage(teacherId, activeCount) {
  await User.updateOne(
    { _id: teacherId },
    { $set: { 'usage.classes': Math.max(0, Number(activeCount) || 0) } }
  );
}

async function archiveClass({ classId, teacherId }) {
  const classDoc = await Class.findOne({ _id: classId, teacher: teacherId, isActive: true });
  if (!classDoc) return null;

  if (!isArchivedClass(classDoc)) {
    classDoc.status = 'archived';
    classDoc.archivedAt = new Date();
    classDoc.archivedBy = teacherId;
    await classDoc.save();
    const activeCount = await countActiveClasses(teacherId);
    await syncClassUsage(teacherId, activeCount);
    logger.info({ event: 'class.archived', classId: String(classDoc._id), teacherId: String(teacherId), timestamp: new Date().toISOString() });
  }
  return classDoc;
}

async function unarchiveClass({ classId, teacher }) {
  const classDoc = await Class.findOne({ _id: classId, teacher: teacher._id, isActive: true });
  if (!classDoc) return { classDoc: null };

  if (!isArchivedClass(classDoc)) return { classDoc };

  const plan = await ensureActivePlan(teacher);
  const limit = getLimit(plan, 'classes');
  const activeCount = await countActiveClasses(teacher._id);
  if (typeof limit === 'number' && activeCount >= limit) {
    return { classDoc, limitReached: true, activeCount, limit };
  }

  classDoc.status = 'active';
  classDoc.archivedAt = null;
  classDoc.archivedBy = null;
  await classDoc.save();
  await syncClassUsage(teacher._id, activeCount + 1);
  logger.info({ event: 'class.unarchived', classId: String(classDoc._id), teacherId: String(teacher._id), timestamp: new Date().toISOString() });
  return { classDoc };
}

module.exports = {
  activeStatusFilter,
  withActiveStatus,
  isArchivedClass,
  countActiveClasses,
  archiveClass,
  unarchiveClass
};
