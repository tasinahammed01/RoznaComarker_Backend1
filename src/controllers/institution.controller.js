const crypto = require('crypto');
const Institution = require('../models/Institution');
const InstitutionMember = require('../models/InstitutionMember');
const InstitutionInvite = require('../models/InstitutionInvite');
const InstitutionCreditWallet = require('../models/InstitutionCreditWallet');
const InstitutionCreditTransaction = require('../models/InstitutionCreditTransaction');
const InstitutionAuditLog = require('../models/InstitutionAuditLog');
const User = require('../models/user.model');
const Class = require('../models/class.model');
const credit = require('../services/institutionCredit.service');
const notifications = require('../services/notification.service');
const { publishInstitutionUpdated } = require('../services/institutionRealtime.service');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message, code) => res.status(status).json({ success: false, message, code });
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const email = (value) => String(value || '').trim().toLowerCase();
const isAdmin = (member) => member && ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'].includes(member.role);
const audit = (institutionId, actorUserId, action, extra = {}) => InstitutionAuditLog.create({ institutionId, actorUserId, action, ...extra });

async function activeMembership(userId) {
  return InstitutionMember.findOne({ userId, status: 'ACTIVE' }).populate('institutionId');
}
async function adminMembership(userId, institutionId) {
  const member = await InstitutionMember.findOne({ userId, institutionId, status: 'ACTIVE' });
  return isAdmin(member) ? member : null;
}

async function provision(req, res) {
  try {
    const owner = await User.findById(req.body.ownerUserId);
    if (!owner || owner.role !== 'teacher') return fail(res, 400, 'Owner must be an existing teacher.', 'INVALID_OWNER');
    if (await activeMembership(owner._id)) return fail(res, 409, 'Owner already has an active institution.', 'ACTIVE_INSTITUTION_EXISTS');
    const start = req.body.cycleStart ? new Date(req.body.cycleStart) : new Date();
    const end = req.body.cycleEnd ? new Date(req.body.cycleEnd) : credit.addUtcMonthsClamped(start);
    if (!(end > start)) return fail(res, 400, 'A valid institution billing cycle is required.', 'INVALID_CYCLE');
    const institution = await Institution.create({ name: req.body.name, slug: req.body.slug || undefined,
      ownerUserId: owner._id, seatLimit: req.body.seatLimit || undefined, status: req.body.status || 'ACTIVE',
      plan: { provider: 'MANUAL', planKey: req.body.planKey || undefined, status: req.body.status || 'ACTIVE', billingCycleStart: start, billingCycleEnd: end } });
    try {
      await Promise.all([
        InstitutionMember.create({ institutionId: institution._id, userId: owner._id, role: 'INSTITUTION_OWNER', status: 'ACTIVE', joinedAt: new Date() }),
        InstitutionCreditWallet.create({ institutionId: institution._id, monthlyCredits: req.body.monthlyCredits,
          cycleStart: start, cycleEnd: end, cycleAnchorDay: start.getUTCDate() })
      ]);
    } catch (cause) {
      await Promise.allSettled([
        InstitutionMember.deleteMany({ institutionId: institution._id }),
        InstitutionCreditWallet.deleteMany({ institutionId: institution._id }),
        InstitutionInvite.deleteMany({ institutionId: institution._id }),
        InstitutionAuditLog.deleteMany({ institutionId: institution._id })
      ]);
      await Institution.deleteOne({ _id: institution._id }); throw cause;
    }
    await audit(institution._id, req.user._id, 'INSTITUTION_PROVISIONED', { targetUserId: owner._id,
      metadata: { seatLimit: institution.seatLimit || null, monthlyCredits: req.body.monthlyCredits } });
    await publishInstitutionUpdated({ institutionId: institution._id, reason: 'INSTITUTION_PROVISIONED', affectedUserIds: [owner._id] });
    return ok(res, institution, 201);
  } catch (cause) { return fail(res, cause?.code === 11000 ? 409 : 500, cause?.code === 11000 ? 'Institution configuration conflicts with an existing record.' : 'Failed to provision institution.', 'PROVISION_FAILED'); }
}

async function me(req, res) {
  try {
    const member = await activeMembership(req.user._id);
    if (!member?.institutionId) return ok(res, null);
    const institution = member.institutionId;
    const wallet = await InstitutionCreditWallet.findOne({ institutionId: institution._id });
    const state = wallet ? await credit.canRunAssessment({ institutionId: institution._id, teacherUserId: req.user._id }) : null;
    return ok(res, { id: institution._id, name: institution.name, status: institution.status, role: member.role,
      managedByInstitution: true, sharedCreditRemaining: state?.availableCredits ?? 0, myUsage: state?.myUsage ?? 0,
      myLimit: state?.myLimit ?? null, cycleStart: wallet?.cycleStart, cycleEnd: wallet?.cycleEnd });
  } catch (cause) { return fail(res, cause.statusCode || 500, cause.message || 'Failed to load institution.', cause.code); }
}

async function dashboard(req, res) {
  try {
    const member = await activeMembership(req.user._id); const institution = member?.institutionId;
    if (!institution || !isAdmin(member)) return fail(res, 403, 'Institution administrator access is required.', 'INSTITUTION_ADMIN_REQUIRED');
    const wallet = await InstitutionCreditWallet.findOne({ institutionId: institution._id });
    const key = credit.cycleKey(wallet);
    const [members, usage, classes] = await Promise.all([
      InstitutionMember.find({ institutionId: institution._id, status: 'ACTIVE' }).populate('userId', 'displayName email').lean(),
      InstitutionCreditTransaction.aggregate([{ $match: { institutionId: institution._id, cycleKey: key, status: 'committed', type: 'ASSESSMENT_DEBIT' } },
        { $group: { _id: '$teacherUserId', used: { $sum: { $abs: '$amount' } } } }]),
      Class.find({ institutionId: institution._id }).select('_id name teacher status').lean()
    ]);
    const usageBy = new Map(usage.map((x) => [String(x._id), x.used]));
    return ok(res, { institution: { id: institution._id, name: institution.name, status: institution.status, plan: institution.plan },
      seats: { used: members.length, limit: institution.seatLimit ?? null },
      credits: { monthly: wallet.monthlyCredits, used: wallet.monthlyCreditsUsed, remaining: credit.remaining(wallet), cycleStart: wallet.cycleStart, cycleEnd: wallet.cycleEnd },
      teachers: members.map((m) => ({ memberId: m._id, userId: m.userId?._id, name: m.userId?.displayName || m.userId?.email,
        email: m.userId?.email, role: m.role, creditsUsed: usageBy.get(String(m.userId?._id)) || 0, limit: m.monthlyCreditLimit ?? null })), classes });
  } catch (cause) { return fail(res, 500, 'Failed to load institution dashboard.', 'DASHBOARD_FAILED'); }
}

async function invite(req, res) {
  try {
    const member = await activeMembership(req.user._id); const institution = member?.institutionId;
    if (!institution || !isAdmin(member)) return fail(res, 403, 'Institution administrator access is required.', 'INSTITUTION_ADMIN_REQUIRED');
    const targetEmail = email(req.body.email); const role = req.body.role || 'TEACHER';
    const token = crypto.randomBytes(32).toString('base64url');
    const doc = await InstitutionInvite.create({ institutionId: institution._id, emailNormalized: targetEmail, role,
      tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: req.user._id });
    await audit(institution._id, req.user._id, 'INVITE_SENT', { metadata: { inviteId: String(doc._id), email: targetEmail, role } });
    const user = await User.findOne({ email: targetEmail });
    if (user) await notifications.createNotification({ recipientId: user._id, actorId: req.user._id, type: 'institution_invite',
      title: `${institution.name} invited you`, description: 'Review and accept your institution invitation.',
      data: { route: { path: `/institution/invites/${token}` } }, idempotencyKey: `institution-invite:${doc._id}` });
    return ok(res, { inviteId: doc._id, token, expiresAt: doc.expiresAt }, 201);
  } catch (cause) { return fail(res, 500, 'Failed to create invitation.', 'INVITE_FAILED'); }
}

async function accept(req, res) {
  const tokenHash = hash(req.params.token);
  try {
    const invitation = await InstitutionInvite.findOne({ tokenHash }).select('+tokenHash');
    if (!invitation || invitation.status !== 'PENDING') return fail(res, 409, 'Invitation is invalid or has already been used.', 'INVITE_INVALID');
    if (invitation.expiresAt <= new Date()) { await InstitutionInvite.updateOne({ _id: invitation._id }, { $set: { status: 'EXPIRED' } }); return fail(res, 410, 'Invitation has expired.', 'INVITE_EXPIRED'); }
    if (email(req.user.email) !== invitation.emailNormalized) return fail(res, 403, 'Invitation email does not match this account.', 'INVITE_EMAIL_MISMATCH');
    if (req.user.role !== 'teacher') return fail(res, 403, 'Only teacher accounts can join an institution.', 'TEACHER_REQUIRED');
    if (await activeMembership(req.user._id)) return fail(res, 409, 'Account already has an active institution.', 'ACTIVE_INSTITUTION_EXISTS');
    const institution = await Institution.findOneAndUpdate({ _id: invitation.institutionId, status: 'ACTIVE',
      $expr: { $or: [{ $eq: [{ $type: '$seatLimit' }, 'missing'] }, { $lt: ['$activeSeatCount', '$seatLimit'] }] } },
      { $inc: { activeSeatCount: 1 } }, { new: true });
    if (!institution) return fail(res, 409, 'No institution seat is available.', 'SEAT_LIMIT_REACHED');
    try {
      await InstitutionMember.findOneAndUpdate({ institutionId: invitation.institutionId, userId: req.user._id }, { $set: {
        role: invitation.role, status: 'ACTIVE', invitedBy: invitation.invitedBy, joinedAt: new Date(), removedAt: null } }, { upsert: true, new: true });
      const claimed = await InstitutionInvite.findOneAndUpdate({ _id: invitation._id, status: 'PENDING' }, { $set: { status: 'ACCEPTED', acceptedAt: new Date() } });
      if (!claimed) throw Object.assign(new Error('Invitation already used'), { code: 'INVITE_REPLAY' });
    } catch (cause) { await Institution.updateOne({ _id: institution._id, activeSeatCount: { $gt: 0 } }, { $inc: { activeSeatCount: -1 } }); throw cause; }
    await audit(institution._id, req.user._id, 'INVITE_ACCEPTED', { targetUserId: req.user._id });
    await publishInstitutionUpdated({ institutionId: institution._id, reason: 'INVITE_ACCEPTED', affectedUserIds: [req.user._id] });
    return ok(res, { institutionId: institution._id, institutionName: institution.name });
  } catch (cause) { return fail(res, cause.code === 'INVITE_REPLAY' ? 409 : 500, cause.code === 'INVITE_REPLAY' ? 'Invitation has already been used.' : 'Failed to accept invitation.', cause.code || 'INVITE_ACCEPT_FAILED'); }
}

async function updateMember(req, res) {
  try {
    const actor = await activeMembership(req.user._id); const institution = actor?.institutionId;
    if (!institution || !isAdmin(actor)) return fail(res, 403, 'Institution administrator access is required.', 'INSTITUTION_ADMIN_REQUIRED');
    const target = await InstitutionMember.findOne({ _id: req.params.memberId, institutionId: institution._id });
    if (!target) return fail(res, 404, 'Member not found.', 'MEMBER_NOT_FOUND');
    if (target.status === 'REMOVED') return ok(res, { removed: true, alreadyRemoved: true });
    if (target.role === 'INSTITUTION_OWNER') return fail(res, 409, 'Owner transfer is required before changing or removing the owner.', 'OWNER_TRANSFER_REQUIRED');
    if (String(target.userId) === String(req.user._id)) return fail(res, 403, 'Administrators cannot elevate or remove themselves.', 'SELF_ADMIN_CHANGE_FORBIDDEN');
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'monthlyCreditLimit')) updates.monthlyCreditLimit = req.body.monthlyCreditLimit == null ? null : req.body.monthlyCreditLimit;
    if (req.body.role) updates.role = req.body.role;
    const changed = await InstitutionMember.findByIdAndUpdate(target._id, { $set: updates }, { new: true });
    await audit(institution._id, req.user._id, updates.role ? 'MEMBER_ROLE_CHANGED' : 'MEMBER_LIMIT_CHANGED', { targetUserId: target.userId, metadata: updates });
    await publishInstitutionUpdated({ institutionId: institution._id, reason: updates.role ? 'MEMBER_ROLE_CHANGED' : 'MEMBER_LIMIT_CHANGED', affectedUserIds: [target.userId] });
    return ok(res, changed);
  } catch { return fail(res, 500, 'Failed to update member.', 'MEMBER_UPDATE_FAILED'); }
}

async function remove(req, res) {
  try {
    const actor = await activeMembership(req.user._id); const institution = actor?.institutionId;
    if (!institution || !isAdmin(actor)) return fail(res, 403, 'Institution administrator access is required.', 'INSTITUTION_ADMIN_REQUIRED');
    const target = await InstitutionMember.findOne({ _id: req.params.memberId, institutionId: institution._id, status: 'ACTIVE' });
    if (!target) return fail(res, 404, 'Member not found.', 'MEMBER_NOT_FOUND');
    if (target.role === 'INSTITUTION_OWNER') return fail(res, 409, 'Owner transfer is required before removing the owner.', 'OWNER_TRANSFER_REQUIRED');
    const claimed = await InstitutionMember.findOneAndUpdate({ _id: target._id, institutionId: institution._id, status: 'ACTIVE' },
      { $set: { status: 'REMOVED', removedAt: new Date() } }, { new: true });
    if (!claimed) return ok(res, { removed: true, alreadyRemoved: true });
    await Institution.updateOne({ _id: institution._id, activeSeatCount: { $gt: 0 } }, { $inc: { activeSeatCount: -1 } });
    await audit(institution._id, req.user._id, 'MEMBER_REMOVED', { targetUserId: target.userId });
    await publishInstitutionUpdated({ institutionId: institution._id, reason: 'MEMBER_REMOVED', affectedUserIds: [target.userId] });
    return ok(res, { removed: true });
  } catch { return fail(res, 500, 'Failed to remove member.', 'MEMBER_REMOVE_FAILED'); }
}

module.exports = { provision, me, dashboard, invite, accept, updateMember, remove, activeMembership, adminMembership };
