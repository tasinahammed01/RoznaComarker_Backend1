const Institution = require('../models/Institution');
const InstitutionMember = require('../models/InstitutionMember');
const InstitutionCreditWallet = require('../models/InstitutionCreditWallet');
const InstitutionCreditTransaction = require('../models/InstitutionCreditTransaction');

const error = (message, code, statusCode = 403) => Object.assign(new Error(message), { code, statusCode });
const cycleKey = (wallet) => `${new Date(wallet.cycleStart).toISOString()}_${new Date(wallet.cycleEnd).toISOString()}`;
const remaining = (wallet) => Math.max(Number(wallet.monthlyCredits) - Number(wallet.monthlyCreditsUsed), 0);
function addUtcMonthsClamped(value, months = 1, anchorDay) {
  const date = new Date(value); const intended = anchorDay || date.getUTCDate();
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(intended, lastDay)); return first;
}

async function resetIfNeeded(institution, wallet, now = new Date()) {
  if (new Date(wallet.cycleEnd) > now) return wallet;
  const anchorDay = wallet.cycleAnchorDay || new Date(wallet.cycleStart).getUTCDate();
  let start = new Date(wallet.cycleEnd); let end = addUtcMonthsClamped(start, 1, anchorDay);
  while (end <= now) { start = end; end = addUtcMonthsClamped(start, 1, anchorDay); }
  const updated = await InstitutionCreditWallet.findOneAndUpdate(
    { _id: wallet._id, cycleEnd: wallet.cycleEnd },
    { $set: { monthlyCreditsUsed: 0, cycleStart: start, cycleEnd: end, appliedDebitKeys: [] } }, { new: true }
  );
  if (!updated) return InstitutionCreditWallet.findById(wallet._id);
  await InstitutionMember.updateMany({ institutionId: institution._id }, { $set: { cycleKey: cycleKey(updated), cycleCreditsUsed: 0, appliedDebitKeys: [] } });
  return updated;
}

async function context(institutionId, teacherUserId) {
  const [institution, member, initialWallet] = await Promise.all([
    Institution.findById(institutionId),
    InstitutionMember.findOne({ institutionId, userId: teacherUserId, status: 'ACTIVE' }),
    InstitutionCreditWallet.findOne({ institutionId })
  ]);
  if (!institution || !member || !initialWallet) throw error('Institution credit context is unavailable.', 'INSTITUTION_CONTEXT_UNAVAILABLE');
  if (institution.status !== 'ACTIVE' || (institution.plan?.status && !['ACTIVE', 'active'].includes(institution.plan.status))) {
    throw error('Institution billing is not active.', 'INSTITUTION_BILLING_INACTIVE');
  }
  return { institution, member, wallet: await resetIfNeeded(institution, initialWallet) };
}

async function canRunAssessment({ institutionId, teacherUserId }) {
  const state = await context(institutionId, teacherUserId); const key = cycleKey(state.wallet);
  const used = state.member.cycleKey === key ? Number(state.member.cycleCreditsUsed || 0) : 0;
  const capOkay = state.member.monthlyCreditLimit == null || used < state.member.monthlyCreditLimit;
  return { ...state, availableCredits: remaining(state.wallet), myUsage: used,
    myLimit: state.member.monthlyCreditLimit ?? null, allowed: remaining(state.wallet) > 0 && capOkay };
}

async function consumeAssessmentCredit({ institutionId, teacherUserId, classId, submissionId, assignmentId, assessmentId, reason }) {
  const idempotencyKey = `institution-assessment:${submissionId}:${assessmentId}`;
  const waitForCommitted = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const item = await InstitutionCreditTransaction.findOne({ idempotencyKey });
      if (item?.status === 'committed') return item;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  let existing = await InstitutionCreditTransaction.findOne({ idempotencyKey });
  if (existing?.status === 'committed') return { charged: false, transaction: existing, availableCredits: existing.balanceAfter };
  try {
    if (!existing) await InstitutionCreditTransaction.create({ institutionId, teacherUserId, classId, submissionId,
      assignmentId, assessmentId: String(assessmentId), cycleKey: 'pending', type: 'ASSESSMENT_DEBIT', status: 'pending',
      amount: -1, balanceAfter: 0, idempotencyKey, reason });
  } catch (cause) {
    if (cause?.code !== 11000) throw cause;
    const winner = await waitForCommitted();
    if (winner?.status === 'committed') return { charged: false, transaction: winner, availableCredits: winner.balanceAfter };
    throw error('Institution debit is still processing.', 'CREDIT_DEBIT_PROCESSING', 409);
  }
  let transaction = await InstitutionCreditTransaction.findOneAndUpdate({ idempotencyKey, status: 'pending' },
    { $set: { status: 'applying' } }, { new: true }) || await InstitutionCreditTransaction.findOne({ idempotencyKey });
  const state = await context(institutionId, teacherUserId); const key = cycleKey(state.wallet);
  if (transaction.cycleKey === 'pending') transaction = await InstitutionCreditTransaction.findOneAndUpdate(
    { _id: transaction._id, cycleKey: 'pending' }, { $set: { cycleKey: key } }, { new: true }) || transaction;
  const memberCondition = { _id: state.member._id, status: 'ACTIVE',
    appliedDebitKeys: { $ne: idempotencyKey }, ...(state.member.monthlyCreditLimit == null ? {} : { $or: [{ cycleKey: { $ne: key } },
      { cycleCreditsUsed: { $lt: state.member.monthlyCreditLimit } }] }) };
  const member = await InstitutionMember.findOneAndUpdate(memberCondition,
    [{ $set: { cycleCreditsUsed: { $cond: [{ $eq: ['$cycleKey', key] }, { $add: ['$cycleCreditsUsed', 1] }, 1] }, cycleKey: key,
      appliedDebitKeys: { $concatArrays: [{ $cond: [{ $eq: ['$cycleKey', key] }, '$appliedDebitKeys', []] }, [idempotencyKey]] } } }],
    { new: true, updatePipeline: true });
  const memberAlreadyApplied = !member && await InstitutionMember.exists({ _id: state.member._id, appliedDebitKeys: idempotencyKey });
  if (!member && !memberAlreadyApplied) { await InstitutionCreditTransaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed' } }); throw error('Your institution usage limit has been reached.', 'INSTITUTION_TEACHER_CAP_REACHED'); }
  await InstitutionCreditTransaction.updateOne({ _id: transaction._id }, { $set: { memberUsageApplied: true } });
  const wallet = await InstitutionCreditWallet.findOneAndUpdate({ _id: state.wallet._id,
    appliedDebitKeys: { $ne: idempotencyKey }, monthlyCreditsUsed: { $lt: state.wallet.monthlyCredits }, cycleStart: state.wallet.cycleStart },
    { $inc: { monthlyCreditsUsed: 1 }, $addToSet: { appliedDebitKeys: idempotencyKey } }, { new: true });
  const walletAlreadyApplied = !wallet && await InstitutionCreditWallet.findOne({ _id: state.wallet._id, appliedDebitKeys: idempotencyKey }).select('+appliedDebitKeys');
  if (!wallet && !walletAlreadyApplied) {
    await InstitutionMember.updateOne({ _id: state.member._id, cycleKey: key, appliedDebitKeys: idempotencyKey },
      { $inc: { cycleCreditsUsed: -1 }, $pull: { appliedDebitKeys: idempotencyKey } });
    await InstitutionCreditTransaction.updateOne({ _id: transaction._id }, { $set: { status: 'failed', memberUsageApplied: false } });
    throw error('The institution has used all assessment credits for this billing cycle.', 'INSUFFICIENT_INSTITUTION_CREDITS');
  }
  const finalWallet = wallet || walletAlreadyApplied;
  transaction = await InstitutionCreditTransaction.findOneAndUpdate({ _id: transaction._id, status: { $ne: 'committed' } },
    { $set: { status: 'committed', memberUsageApplied: true, walletApplied: true, cycleKey: key,
      balanceAfter: remaining(finalWallet) } }, { new: true }) || await InstitutionCreditTransaction.findById(transaction._id);
  return { charged: true, transaction, availableCredits: transaction.balanceAfter };
}

module.exports = { cycleKey, remaining, addUtcMonthsClamped, resetIfNeeded, context, canRunAssessment, consumeAssessmentCredit };
