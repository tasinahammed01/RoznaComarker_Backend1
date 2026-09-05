'use strict';
const fs = require('fs');
const path = require('path');
const Class = require('../models/class.model');
const Submission = require('../models/Submission');
const File = require('../models/File');

const id = (value) => String(value?._id || value || '').trim();
async function bytesFor(file) {
  if (Number.isFinite(Number(file?.sizeBytes))) return Math.max(0, Number(file.sizeBytes));
  const stored = String(file?.path || '');
  if (!stored) return 0;
  const absolute = path.isAbsolute(stored) ? stored : path.resolve(__dirname, '..', '..', stored);
  try { return (await fs.promises.stat(absolute)).size; } catch { return 0; }
}
async function calculateOwnedStorageUsage(userId) {
  const classIds = await Class.find({ teacher: userId }).distinct('_id');
  const submissions = classIds.length ? await Submission.find({ class: { $in: classIds } }).select('file files').lean() : [];
  const referenced = new Set(submissions.flatMap((submission) => [submission.file, ...(submission.files || [])]).map(id).filter(Boolean));
  const query = referenced.size ? { $or: [{ uploadedBy: userId }, { _id: { $in: [...referenced] } }] } : { uploadedBy: userId };
  const files = await File.find(query).select('_id path sizeBytes').lean();
  const unique = [...new Map(files.map((file) => [id(file._id), file])).values()];
  const sizes = await Promise.all(unique.map(bytesFor));
  return { usedBytes: sizes.reduce((sum, value) => sum + value, 0), fileCount: unique.length };
}
function buildStorageContract(usedBytes, planDoc) {
  const normalizedUsed = Math.max(0, Number(usedBytes) || 0);
  const limitMB = Number(planDoc?.features?.storageMB ?? planDoc?.limits?.storageMB);
  const limitBytes = Number.isFinite(limitMB) ? Math.round(limitMB * 1024 * 1024) : null;
  return { usedBytes: normalizedUsed, limitBytes, usedMb: normalizedUsed / (1024 * 1024),
    limitMb: Number.isFinite(limitMB) ? limitMB : null,
    percent: limitBytes && limitBytes > 0 ? Math.min(100, Math.round(normalizedUsed * 10000 / limitBytes) / 100) : null };
}
module.exports = { calculateOwnedStorageUsage, buildStorageContract };
