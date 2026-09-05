'use strict';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function referralConfig(environment = process.env) {
  return Object.freeze({
    referrerRewardCredits: positiveInteger(environment.REFERRAL_REFERRER_REWARD_CREDITS, 5),
    referredRewardCredits: positiveInteger(environment.REFERRAL_REFERRED_REWARD_CREDITS, 5),
    maxRewardedReferralsPerReferrer: optionalPositiveInteger(environment.REFERRAL_MAX_REWARDED_LIFETIME),
    qualificationType: 'FIRST_SUCCESSFUL_AI_ASSESSMENT'
  });
}

module.exports = { referralConfig };
