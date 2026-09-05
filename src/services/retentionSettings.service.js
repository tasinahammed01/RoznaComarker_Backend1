'use strict';
const RetentionSettings = require('../models/RetentionSettings');
const { referralConfig } = require('../config/referral');
const { bonusRewardConfig, DEFINITIONS: BONUS_DEFINITIONS } = require('../config/bonusRewards');
const { milestoneDefinitions } = require('../config/professionalMilestones');

const TTL_MS = 3000; let cache = null; let cachedAt = 0;
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const enabled = (v) => String(v || '').trim().toLowerCase() === 'true';
function weeklyFallback(env = process.env) { const rawHour = Number(env.WEEKLY_SUMMARY_HOUR);
  return { enabled: enabled(env.WEEKLY_SUMMARY_ENABLED), day: env.WEEKLY_SUMMARY_DAY || null,
    hour: Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : null,
    timezone: env.WEEKLY_SUMMARY_TIMEZONE || null }; }
function nudgeFallback() { return { thresholds: [50, 80, 100], configurable: true }; }
async function document(force = false) { if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = await RetentionSettings.findOne({ singletonKey: 'global' }).lean(); cachedAt = Date.now(); return cache; }
function invalidate() { cache = null; cachedAt = 0; }
const merge = (base, override) => ({ ...base, ...(override || {}) });
async function getReferralConfig() { const db = (await document())?.referral; return merge(referralConfig(), db); }
async function getBonusRewardConfig() { const db = (await document())?.bonusRewards || {}; const base = bonusRewardConfig();
  return Object.fromEntries(Object.keys(BONUS_DEFINITIONS).map((key) => [key, merge(base[key], db[key])])); }
async function getMilestoneConfig() { const db = (await document())?.milestones || {};
  const overrides = Array.isArray(db) ? new Map(db.map((item) => [item.key, item])) : new Map(Object.entries(db));
  return milestoneDefinitions().map((item) => merge(item, overrides.get(item.key))); }
async function getWeeklySummaryConfig() { return merge(weeklyFallback(), (await document())?.weeklySummary); }
async function getCreditNudgeConfig() { return merge(nudgeFallback(), (await document())?.creditNudges); }
async function getInstitutionCommercialConfig() { return clone((await document())?.institution || {}); }
async function getRetentionSettings(force = false) { const db = await document(force); return { version: db?.version || 0,
  referral: await getReferralConfig(), bonusRewards: await getBonusRewardConfig(), milestones: await getMilestoneConfig(),
  weeklySummary: await getWeeklySummaryConfig(), creditNudges: await getCreditNudgeConfig(), institution: await getInstitutionCommercialConfig(),
  explicitOverrides: db ? clone({ referral: db.referral, bonusRewards: db.bonusRewards, milestones: db.milestones,
    weeklySummary: db.weeklySummary, creditNudges: db.creditNudges, institution: db.institution }) : null } }
module.exports = { TTL_MS, invalidate, getRetentionSettings, getReferralConfig, getBonusRewardConfig, getMilestoneConfig,
  getWeeklySummaryConfig, getCreditNudgeConfig, getInstitutionCommercialConfig, weeklyFallback };
