const crypto = require('crypto');
const mongoose = require('mongoose');
const CreditTransaction = require('../models/CreditTransaction');
const User = require('../models/user.model');
const CreditService = require('../services/credit.service');
const logger = require('../utils/logger');

const fail = (res, error) => res.status(error?.statusCode || 500).json({ success: false,
  ...(error?.code ? { code: error.code } : {}), message: error?.message || 'Credit operation failed' });

async function wallet(req, res) {
  try { return res.json({ success: true, wallet: CreditService.toDto(await CreditService.getOrCreateWallet(req.user)) }); }
  catch (error) { return fail(res, error); }
}
async function acknowledgeNudge(req, res) {
  try { return res.json({ success: true, wallet: CreditService.toDto(await CreditService.acknowledgeNudge(req.user, req.body?.threshold)) }); }
  catch (error) { return fail(res, error); }
}

async function transactions(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { userId: req.user._id }; const [items, total] = await Promise.all([
      CreditTransaction.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-metadata').lean(),
      CreditTransaction.countDocuments(filter)
    ]);
    return res.json({ success: true, transactions: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return fail(res, error); }
}

async function adminWallet(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    const user = await User.findById(req.params.userId); if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const state = await CreditService.getOrCreateWallet(user);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { userId: user._id };
    const [history, total] = await Promise.all([CreditTransaction.find(filter).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean(), CreditTransaction.countDocuments(filter)]);
    return res.json({ success: true, teacher: { _id: user._id, displayName: user.displayName, email: user.email },
      wallet: CreditService.toDto(state), transactions: history,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return fail(res, error); }
}

async function adminTeachers(req, res) {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = { role: 'teacher', isActive: { $ne: false }, ...(q ? { $or: [
      { email: { $regex: escaped, $options: 'i' } }, { displayName: { $regex: escaped, $options: 'i' } }
    ] } : {}) };
    const teachers = await User.find(filter).sort({ displayName: 1, email: 1 }).limit(25).select('_id displayName email').lean();
    return res.json({ success: true, teachers });
  } catch (error) { return fail(res, error); }
}

async function adminAdjust(req, res) {
  try {
    const amount = Number(req.body?.amount); const reason = String(req.body?.reason || '').trim();
    const key = String(req.body?.idempotencyKey || `admin:${req.user._id}:${req.params.userId}:${crypto.randomUUID()}`);
    const transaction = await CreditService.adjustBonusCredits({ userId: req.params.userId, amount, reason,
      idempotencyKey: key, actorId: req.user._id, metadata: { source: 'admin_api' } });
    const state = await CreditService.getOrCreateWallet(req.params.userId);
    logger.info({ event: 'credit.admin_adjustment', userId: req.params.userId, adminActorId: String(req.user._id), amount, transactionId: String(transaction._id) });
    return res.json({ success: true, wallet: CreditService.toDto(state), transaction });
  } catch (error) { return fail(res, error); }
}

module.exports = { wallet, acknowledgeNudge, transactions, adminTeachers, adminWallet, adminAdjust };
