'use strict';

const Membership = require('../models/membership.model');

async function activeStudentIdsForClass(classId) {
  return Membership.distinct('student', { class: classId, status: 'active' });
}

async function aggregateCurrentRosterCounts(model, assignmentField, studentField, assignmentIds, activeStudentIds) {
  if (!assignmentIds.length || !activeStudentIds.length) return [];
  return model.aggregate([
    { $match: { [assignmentField]: { $in: assignmentIds }, [studentField]: { $in: activeStudentIds } } },
    { $group: { _id: { assignment: `$${assignmentField}`, student: `$${studentField}` } } },
    { $group: { _id: '$_id.assignment', count: { $sum: 1 } } }
  ]);
}

async function currentRosterAssignmentCounts(assignments, contracts) {
  const list = Array.isArray(assignments) ? assignments : [];
  if (!list.length) return { activeStudentIds: [], countsByAssignment: new Map() };
  const classId = list[0].class?._id || list[0].class;
  const activeStudentIds = await activeStudentIdsForClass(classId);
  const rows = await Promise.all(contracts.map(async ({ type, model, assignmentField, studentField }) => {
    const assignmentIds = list.filter(item => item.resourceType === type).map(item => item._id);
    return aggregateCurrentRosterCounts(model, assignmentField, studentField, assignmentIds, activeStudentIds);
  }));
  return {
    activeStudentIds,
    countsByAssignment: new Map(rows.flat().map(item => [String(item._id), item.count]))
  };
}

module.exports = { activeStudentIdsForClass, currentRosterAssignmentCounts };
