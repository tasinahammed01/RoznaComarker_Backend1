'use strict';
// Similarity caps per UTC day, reserved atomically: a conditional $inc that only matches while under the cap, with upsert for the first use
// of the day (a duplicate-key error means the day's document exists and is at the cap). Given back with a guarded $inc.
const SimilarityUsage = require('../../models/SimilarityUsage');

const dayOf = date => new Date(date).toISOString().slice(0, 10);
const teacherScope = teacherId => `teacher:${teacherId}`;
const GLOBAL = 'global';
const isDuplicate = error => error?.code === 11000;
const round = value => Math.round(value * 10000) / 10000;

/** Reserves one check for this teacher today; false at the cap. */
async function reserveCheck(teacherId, cap, now) {
  try {
    await SimilarityUsage.findOneAndUpdate({ scope: teacherScope(teacherId), day: dayOf(now), checks: { $lt: cap } }, { $inc: { checks: 1 } }, { upsert: true });
    return true;
  } catch (error) { if (isDuplicate(error)) return false; throw error; }
}

async function releaseCheck(teacherId, day) {
  await SimilarityUsage.updateOne({ scope: teacherScope(teacherId), day, checks: { $gt: 0 } }, { $inc: { checks: -1 } });
}

async function checksUsed(teacherId, now) {
  const doc = await SimilarityUsage.findOne({ scope: teacherScope(teacherId), day: dayOf(now) }).select('checks').lean();
  return doc?.checks || 0;
}

/** Reserves an estimated provider spend in today's global total; false when it would pass the daily stop. */
async function reserveSpend(usd, capUsd, now) {
  if (!(usd > 0)) return true;
  if (usd > capUsd) return false;
  try {
    await SimilarityUsage.findOneAndUpdate({ scope: GLOBAL, day: dayOf(now), spendUsd: { $lte: round(capUsd - usd) } }, { $inc: { spendUsd: usd } }, { upsert: true });
    return true;
  } catch (error) { if (isDuplicate(error)) return false; throw error; }
}

/** Adds (or, negative, gives back) spend for a day; never below zero. */
async function adjustSpend(deltaUsd, day) {
  if (!deltaUsd) return;
  if (deltaUsd > 0) { await SimilarityUsage.updateOne({ scope: GLOBAL, day }, { $inc: { spendUsd: round(deltaUsd) } }, { upsert: true }); return; }
  await SimilarityUsage.updateOne({ scope: GLOBAL, day, spendUsd: { $gte: round(-deltaUsd) } }, { $inc: { spendUsd: round(deltaUsd) } });
}

module.exports = { dayOf, reserveCheck, releaseCheck, checksUsed, reserveSpend, adjustSpend };
