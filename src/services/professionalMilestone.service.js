'use strict';
const User = require('../models/user.model'); const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model'); const AssessmentRun = require('../models/AssessmentRun');
const SavedRubric = require('../models/savedRubric.model'); const AdaptiveSession = require('../models/AdaptivePracticeSession');
const Membership = require('../models/membership.model'); const Referral = require('../models/Referral');
const ProfessionalMilestone = require('../models/ProfessionalMilestone');
const BonusRewardService = require('./bonusReward.service'); const NotificationService = require('./notification.service');
const { publishToUser } = require('./notificationRealtime.service'); const RetentionSettings = require('./retentionSettings.service');
const logger = require('../utils/logger');

async function metricValues(userId, requested) {
  const wanted = new Set(requested || (await RetentionSettings.getMilestoneConfig()).filter((d) => d.enabled).map((d) => d.metricType));
  const values = {}; const jobs = [];
  const add = (type, work) => { if (wanted.has(type)) jobs.push(Promise.resolve(work()).then((v) => { values[type] = Number(v || 0); })); };
  add('CLASSES_CREATED', () => Class.countDocuments({ teacher: userId, status: { $ne: 'archived' }, isActive: { $ne: false } }));
  add('ASSIGNMENTS_CREATED', () => Assignment.countDocuments({ teacher: userId }));
  add('SUCCESSFUL_ASSESSMENTS', () => AssessmentRun.countDocuments({ teacherId: userId, status: 'complete' }));
  add('SAVED_RUBRICS', () => SavedRubric.countDocuments({ teacher: userId, isActive: true }));
  add('QUALIFIED_REFERRALS', () => Referral.countDocuments({ referrerUserId: userId, status: { $in: ['QUALIFIED', 'REWARDED'] } }));
  add('ADAPTIVE_COMPLETIONS', async () => { const ids = await Assignment.find({ teacher: userId }).distinct('_id'); return AdaptiveSession.countDocuments({ assignmentId: { $in: ids }, completedAt: { $type: 'date' } }); });
  add('ACTIVE_STUDENTS', async () => { const ids = await Class.find({ teacher: userId, status: 'active', isActive: { $ne: false } }).distinct('_id'); return (await Membership.distinct('student', { class: { $in: ids }, status: 'active' })).length; });
  // Draft Comparison outcomes are not persisted today; never infer this metric.
  add('STUDENT_IMPROVEMENTS', () => 0);
  await Promise.all(jobs); return values;
}

async function deliver(milestone, definition, { notify }) {
  try {
    const reward = await BonusRewardService.grantConfiguredBonus({ eventType: 'PROFESSIONAL_MILESTONE',
      eventKey: definition.rewardEventKey, userId: milestone.userId, sourceId: milestone._id });
    await ProfessionalMilestone.updateOne({ _id: milestone._id }, { $set: { rewardStatus: reward.granted ? 'GRANTED' : 'DISABLED' } });
  } catch (error) { await ProfessionalMilestone.updateOne({ _id: milestone._id }, { $set: { rewardStatus: 'FAILED' } });
    logger.error({ event: 'professional_milestone_reward_failed', userId: String(milestone.userId), milestoneKey: definition.key, error: error?.message }); }
  if (!notify) return;
  try { await NotificationService.createNotification({ recipientId: milestone.userId, type: 'professional_milestone',
    title: 'Professional milestone reached', description: definition.description,
    idempotencyKey: `professional-milestone-notification:${milestone.userId}:${definition.key}`,
    data: { milestoneKey: definition.key, route: { path: '/teacher/dashboard' } } });
    await ProfessionalMilestone.updateOne({ _id: milestone._id }, { $set: { notificationStatus: 'SENT' } });
    publishToUser({ userId: milestone.userId, event: 'professional_milestone_updated', payload: { milestoneKey: definition.key } });
  } catch (error) { logger.error({ event: 'professional_milestone_notification_failed', userId: String(milestone.userId), milestoneKey: definition.key, error: error?.message }); }
}

async function evaluateProfessionalMilestonesForUser(userId, metricTypes, options = {}) {
  const user = await User.findOne({ _id: userId, role: 'teacher', isActive: { $ne: false } }).select('_id').lean();
  if (!user) return [];
  const definitions = (await RetentionSettings.getMilestoneConfig()).filter((d) => d.enabled && (!metricTypes?.length || metricTypes.includes(d.metricType)));
  const values = await metricValues(userId, definitions.map((d) => d.metricType)); const achieved = [];
  for (const definition of definitions) {
    if ((values[definition.metricType] || 0) < definition.threshold) continue;
    let milestone; let created = false;
    try { milestone = await ProfessionalMilestone.create({ userId, milestoneKey: definition.key, metricType: definition.metricType,
      threshold: definition.threshold, sourceValue: values[definition.metricType] }); created = true; }
    catch (error) { if (error?.code !== 11000) throw error; milestone = await ProfessionalMilestone.findOne({ userId, milestoneKey: definition.key }); }
    if (created || milestone.rewardStatus === 'FAILED' || (options.notify !== false && milestone.notificationStatus === 'PENDING'))
      await deliver(milestone, definition, { notify: options.notify !== false && options.backfill !== true });
    achieved.push(milestone);
  }
  return achieved;
}

async function milestoneSummary(userId) {
  await evaluateProfessionalMilestonesForUser(userId, undefined, { backfill: true, notify: false });
  const definitions = (await RetentionSettings.getMilestoneConfig()).filter((d) => d.enabled); const values = await metricValues(userId, [...new Set(definitions.map((d) => d.metricType))]);
  const records = await ProfessionalMilestone.find({ userId }).lean(); const byKey = new Map(records.map((r) => [r.milestoneKey, r]));
  const items = definitions.map((d) => { const record = byKey.get(d.key); const current = Math.min(values[d.metricType] || 0, d.threshold);
    return { key: d.key, title: d.title, description: d.description, achieved: !!record, achievedAt: record?.achievedAt || null,
      rewardGranted: record?.rewardStatus === 'GRANTED', current, target: d.threshold, percent: Math.min(100, Math.round(current * 100 / d.threshold)) }; });
  const achieved = items.filter((i) => i.achieved); const inProgress = items.filter((i) => !i.achieved);
  return { achieved, inProgress, nextMilestone: inProgress.sort((a, b) => b.percent - a.percent)[0] || null };
}
async function evaluateProfessionalMilestonesSafely(userId, metricTypes) {
  try { return await evaluateProfessionalMilestonesForUser(userId, metricTypes); }
  catch (error) { logger.error({ event: 'professional_milestone_evaluation_failed', userId: String(userId),
    metricTypes, error: error?.message }); return []; }
}
module.exports = { metricValues, evaluateProfessionalMilestonesForUser, evaluateProfessionalMilestonesSafely, milestoneSummary };
