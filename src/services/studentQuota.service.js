'use strict';

const mongoose = require('mongoose');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Plan = require('../models/Plan');
const User = require('../models/user.model');

async function effectivePlanReadOnly(teacher) {
  const status = String(teacher.paypalSubscriptionStatus || '').toUpperCase();
  const paidThrough = teacher.paypalCurrentPeriodEnd || teacher.planExpiresAt;
  const entitled = status === 'ACTIVE' || (status === 'CANCELLED' && paidThrough && new Date(paidThrough) > new Date());
  if (entitled && teacher.paypalPlanId) {
    try { return await require('./paypal/paypalPlanMapping.service').getPlanByPayPalPlanId(teacher.paypalPlanId); }
    catch { /* unknown provider mapping must not grant a plan in diagnostics */ }
  }
  const assigned = teacher.plan ? await Plan.findById(teacher.plan).lean() : null;
  const expired = teacher.planExpiresAt && new Date(teacher.planExpiresAt) <= new Date();
  if (assigned?.isActive === true && !expired) return assigned;
  return Plan.findOne({ slug: 'free', isActive: true }).lean();
}

async function countActiveEnrollmentSeats(teacherId) {
  const [row] = await Membership.aggregate([
    { $match: { status: 'active' } },
    { $lookup: { from: Class.collection.name, localField: 'class', foreignField: '_id', as: 'classDoc' } },
    { $unwind: '$classDoc' },
    { $match: { 'classDoc.teacher': new mongoose.Types.ObjectId(String(teacherId)), 'classDoc.isActive': true } },
    { $count: 'count' }
  ]);
  return row?.count || 0;
}

async function reserveStudentSeat(teacherId, limit) {
  if (typeof limit === 'number' && limit <= 0) return false;
  const filter = { _id: teacherId };
  if (typeof limit === 'number') {
    filter.$or = [
      { 'usage.students': { $lt: limit } },
      { 'usage.students': { $exists: false } }
    ];
  }
  const result = await User.updateOne(filter, { $inc: { 'usage.students': 1 } });
  return result.modifiedCount === 1;
}

async function releaseStudentSeats(teacherId, amount = 1) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (!requested) return 0;
  const decremented = await User.updateOne(
    { _id: teacherId, 'usage.students': { $gte: requested } },
    { $inc: { 'usage.students': -requested } }
  );
  if (decremented.modifiedCount) return requested;
  const floored = await User.updateOne(
    { _id: teacherId, 'usage.students': { $gt: 0, $lt: requested } },
    { $set: { 'usage.students': 0 } }
  );
  return floored.modifiedCount ? requested : 0;
}

async function diagnoseTeacherStudentUsage(teacherId, { classId = null } = {}) {
  const teacher = await User.findById(teacherId)
    .select('_id plan planExpiresAt paypalPlanId paypalSubscriptionStatus paypalCurrentPeriodEnd usage.students').lean();
  if (!teacher) throw Object.assign(new Error('TEACHER_NOT_FOUND'), { code: 'TEACHER_NOT_FOUND' });
  const classes = await Class.find({ teacher: teacher._id }).select('_id isActive').lean();
  const allClassIds = classes.map(item => item._id);
  const activeClassIds = classes.filter(item => item.isActive === true).map(item => item._id);
  const inactiveClassIds = classes.filter(item => item.isActive !== true).map(item => item._id);
  const affectedClass = classId
    ? classes.find(item => String(item._id) === String(classId))
    : null;
  if (classId && !affectedClass) throw Object.assign(new Error('CLASS_NOT_OWNED'), { code: 'CLASS_NOT_OWNED' });
  const plan = await effectivePlanReadOnly(teacher);
  const [activeAcrossOwnedClasses, activeInActiveClasses, distinctActiveStudents, leftMemberships,
    inactiveClassMemberships, activeInAffectedClass] = await Promise.all([
    Membership.countDocuments({ class: { $in: allClassIds }, status: 'active' }),
    Membership.countDocuments({ class: { $in: activeClassIds }, status: 'active' }),
    Membership.distinct('student', { class: { $in: activeClassIds }, status: 'active' }).then(values => values.length),
    Membership.countDocuments({ class: { $in: allClassIds }, status: 'left' }),
    Membership.countDocuments({ class: { $in: inactiveClassIds } }),
    affectedClass ? Membership.countDocuments({ class: affectedClass._id, status: 'active' }) : null
  ]);
  return {
    teacherId: String(teacher._id),
    effectivePlanSlug: plan?.slug || null,
    maxStudents: plan?.features?.maxStudents ?? plan?.limits?.students ?? null,
    storedUsageStudents: Math.max(0, Number(teacher.usage?.students) || 0),
    activeMembershipsAcrossOwnedClasses: activeAcrossOwnedClasses,
    activeMembershipsInActiveClasses: activeInActiveClasses,
    distinctActiveStudentIds: distinctActiveStudents,
    affectedClassId: affectedClass ? String(affectedClass._id) : null,
    activeMembershipsInAffectedClass: activeInAffectedClass,
    leftMemberships,
    membershipsInInactiveClasses: inactiveClassMemberships,
    drift: (Math.max(0, Number(teacher.usage?.students) || 0) - activeInActiveClasses)
  };
}

async function reconcileTeacherStudentUsage(teacherId, { apply = false } = {}) {
  const diagnosis = await diagnoseTeacherStudentUsage(teacherId);
  if (apply && diagnosis.storedUsageStudents !== diagnosis.activeMembershipsInActiveClasses) {
    await User.updateOne({ _id: teacherId }, { $set: { 'usage.students': diagnosis.activeMembershipsInActiveClasses } });
  }
  return { ...diagnosis, applied: apply, nextUsageStudents: diagnosis.activeMembershipsInActiveClasses };
}

module.exports = {
  countActiveEnrollmentSeats,
  reserveStudentSeat,
  releaseStudentSeats,
  diagnoseTeacherStudentUsage,
  reconcileTeacherStudentUsage
};
