'use strict';

const DEFINITIONS = Object.freeze({
  ONBOARDING_COMPLETION: { prefix: 'BONUS_REWARD_ONBOARDING', repeatPolicy: 'ONCE_PER_ACCOUNT' },
  FIRST_SUCCESSFUL_ASSESSMENT: { prefix: 'BONUS_REWARD_FIRST_ASSESSMENT', repeatPolicy: 'ONCE_PER_ACCOUNT' },
  SUBSCRIPTION_RENEWAL: { prefix: 'BONUS_REWARD_RENEWAL', repeatPolicy: 'ONCE_PER_BILLING_PERIOD' },
  ANNUAL_UPGRADE: { prefix: 'BONUS_REWARD_ANNUAL_UPGRADE', repeatPolicy: 'ONCE_PER_ELIGIBLE_TRANSITION' },
  PROFESSIONAL_MILESTONE: { prefix: 'BONUS_REWARD_PROFESSIONAL_MILESTONE', repeatPolicy: 'ONCE_PER_EVENT_KEY' }
});

function enabled(value) { return String(value || '').trim().toLowerCase() === 'true'; }

function bonusRewardConfig(environment = process.env) {
  const rules = {};
  for (const [eventType, definition] of Object.entries(DEFINITIONS)) {
    const isEnabled = enabled(environment[`${definition.prefix}_ENABLED`]);
    const rawAmount = environment[`${definition.prefix}_AMOUNT`];
    const amount = rawAmount == null || String(rawAmount).trim() === '' ? null : Number(rawAmount);
    if (isEnabled && (!Number.isInteger(amount) || amount <= 0)) {
      const error = new Error(`${definition.prefix}_AMOUNT must be a positive integer when ${definition.prefix}_ENABLED=true`);
      error.code = 'BONUS_REWARD_CONFIG_INVALID'; throw error;
    }
    rules[eventType] = Object.freeze({ eventType, enabled: isEnabled, amount: isEnabled ? amount : null,
      repeatPolicy: definition.repeatPolicy });
  }
  return Object.freeze(rules);
}

module.exports = { DEFINITIONS, bonusRewardConfig };
