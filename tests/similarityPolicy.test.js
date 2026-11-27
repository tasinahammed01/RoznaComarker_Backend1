'use strict';
// Similarity Reporting: the feature switch, the provider choice and the settings (services/similarity/policy.js).
const policy = require('../src/services/similarity/policy');

describe('similarityEnabled', () => {
  test('off unless SIMILARITY_ENABLED is exactly true (any case, trimmed)', () => {
    expect(policy.similarityEnabled({})).toBe(false);
    expect(policy.similarityEnabled({ SIMILARITY_ENABLED: 'false' })).toBe(false);
    expect(policy.similarityEnabled({ SIMILARITY_ENABLED: '1' })).toBe(false);
    expect(policy.similarityEnabled({ SIMILARITY_ENABLED: 'yes' })).toBe(false);
    expect(policy.similarityEnabled({ SIMILARITY_ENABLED: ' TRUE ' })).toBe(true);
  });
});

describe('providerName', () => {
  test('copyscape, copyleaks, stub or none; anything else (or nothing) is none', () => {
    expect(policy.providerName({})).toBe('none');
    for (const name of ['copyscape', 'copyleaks', 'stub', 'none']) expect(policy.providerName({ SIMILARITY_PROVIDER: ` ${name.toUpperCase()} ` })).toBe(name);
    expect(policy.providerName({ SIMILARITY_PROVIDER: 'turnitin' })).toBe('none');
  });
  test('the old SIMILARITY_INTERNET_PROVIDER name is not read', () => {
    expect(policy.providerName({ SIMILARITY_INTERNET_PROVIDER: 'copyscape' })).toBe('none');
  });
});

describe('readSettings', () => {
  test('defaults', () => {
    const { settings, issues } = policy.readSettings({});
    expect(issues).toEqual([]);
    expect(settings).toEqual({
      dailyChecksPerTeacher: 20, checksPerSubmission: 3, maxWords: 2500, minMatchWords: 8, fullComparisons: 10, providerTimeoutMs: 30000,
      providerDeadlineMinutes: 60, copyleaksRetentionHours: 24, commonSharePercent: 30, commonMinEssays: 5,
      dailySpendUsd: 5, copyleaksUsdPerCredit: null, internalScope: 'all', excludeQuotes: true
    });
    expect(Object.isFrozen(settings)).toBe(true);
  });
  test('valid values are used', () => {
    const { settings, issues } = policy.readSettings({ SIMILARITY_DAILY_CHECKS_PER_TEACHER: '5', SIMILARITY_CHECKS_PER_SUBMISSION: '1',
      SIMILARITY_MAX_WORDS: '1000', SIMILARITY_DAILY_SPEND_USD: '0.5', SIMILARITY_COPYLEAKS_USD_PER_CREDIT: '0.04', SIMILARITY_INTERNAL_SCOPE: 'own',
      SIMILARITY_EXCLUDE_QUOTES: 'false' });
    expect(issues).toEqual([]);
    expect(settings).toMatchObject({ dailyChecksPerTeacher: 5, checksPerSubmission: 1, maxWords: 1000, dailySpendUsd: 0.5, copyleaksUsdPerCredit: 0.04,
      internalScope: 'own', excludeQuotes: false });
  });
  test('a bad or out-of-range value is ignored and reported by name only', () => {
    const { settings, issues } = policy.readSettings({ SIMILARITY_DAILY_CHECKS_PER_TEACHER: '0', SIMILARITY_MAX_WORDS: 'lots', SIMILARITY_DAILY_SPEND_USD: '-1',
      SIMILARITY_COPYLEAKS_USD_PER_CREDIT: 'abc', SIMILARITY_INTERNAL_SCOPE: 'world', SIMILARITY_EXCLUDE_QUOTES: 'maybe', SIMILARITY_FULL_COMPARISONS: '11' });
    expect(settings).toMatchObject({ dailyChecksPerTeacher: 20, maxWords: 2500, dailySpendUsd: 5, copyleaksUsdPerCredit: null, internalScope: 'all',
      excludeQuotes: true, fullComparisons: 10 });
    expect(issues.sort()).toEqual(['SIMILARITY_COPYLEAKS_USD_PER_CREDIT', 'SIMILARITY_DAILY_CHECKS_PER_TEACHER', 'SIMILARITY_DAILY_SPEND_USD',
      'SIMILARITY_EXCLUDE_QUOTES', 'SIMILARITY_FULL_COMPARISONS', 'SIMILARITY_INTERNAL_SCOPE', 'SIMILARITY_MAX_WORDS']);
    expect(JSON.stringify(issues)).not.toMatch(/lots|abc|world|maybe/);
  });
  test('boundaries: the minimum and maximum are accepted, one past them is not', () => {
    expect(policy.readSettings({ SIMILARITY_MIN_MATCH_WORDS: '3' }).settings.minMatchWords).toBe(3);
    expect(policy.readSettings({ SIMILARITY_MIN_MATCH_WORDS: '2' }).settings.minMatchWords).toBe(8);
    expect(policy.readSettings({ SIMILARITY_MIN_MATCH_WORDS: '50' }).settings.minMatchWords).toBe(50);
    expect(policy.readSettings({ SIMILARITY_MIN_MATCH_WORDS: '51' }).settings.minMatchWords).toBe(8);
    expect(policy.readSettings({ SIMILARITY_FULL_COMPARISONS: '0' }).settings.fullComparisons).toBe(0);
  });
});

describe('webhookConfig', () => {
  const secret = 's'.repeat(32);
  test('needs an https base URL and a secret of 32 characters or more', () => {
    expect(policy.webhookConfig({})).toBeNull();
    expect(policy.webhookConfig({ SIMILARITY_WEBHOOK_BASE_URL: 'https://api.example.test', SIMILARITY_WEBHOOK_SECRET: 's'.repeat(31) })).toBeNull();
    expect(policy.webhookConfig({ SIMILARITY_WEBHOOK_BASE_URL: 'http://api.example.test', SIMILARITY_WEBHOOK_SECRET: secret })).toBeNull();
    expect(policy.webhookConfig({ SIMILARITY_WEBHOOK_BASE_URL: 'not a url', SIMILARITY_WEBHOOK_SECRET: secret })).toBeNull();
    expect(policy.webhookConfig({ SIMILARITY_WEBHOOK_BASE_URL: 'https://api.example.test/', SIMILARITY_WEBHOOK_SECRET: secret }))
      .toEqual({ baseUrl: 'https://api.example.test', secret });
  });
});

test('the notice version is fixed and names no provider', () => {
  expect(policy.NOTICE_VERSION).toBe('essay-similarity-2026-11');
});
