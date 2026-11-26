'use strict';
// Speaking Coach settings (services/speakingCoach/policy.js): the feature switch (off by default, and only with AUDIO_STT_ENABLED), the
// settings read from the environment with safe defaults and ranges, and the pass rule (D3): a practised area passes at passPercent or above;
// when no level of the criterion falls in [passPercent, 100), the second-highest level passes too (criteria with three or more levels).
process.env.NODE_ENV = 'test';
const policy = require('../src/services/speakingCoach/policy');

const levels = percents => percents.map((percent, index) => ({ title: `L${index}`, percent }));

describe('the feature switch', () => {
  test.each([
    [{}, false],
    [{ SPEAKING_COACH_ENABLED: 'true' }, false],
    [{ AUDIO_STT_ENABLED: 'true' }, false],
    [{ AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'false' }, false],
    [{ AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'yes' }, false],
    [{ AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: ' TRUE ' }, true]
  ])('%j -> %s', (env, expected) => expect(policy.speakingCoachEnabled(env)).toBe(expected));
});

describe('settings', () => {
  test('defaults: room for the model\'s thinking (the real trial truncated at 1200: 581 of 719 and 932 of 1027 output tokens were thinking)', () => {
    expect(policy.readSettings({})).toEqual({ settings: { passPercent: 70, maxAttemptsPerSubmission: 20, maxRecordingSeconds: 90, minWords: 15,
      dailyMinutesPerTeacher: 30, monthlyMinutesPerTeacher: 300, checkMaxOutputTokens: 3000, tasksMaxOutputTokens: 2500 }, issues: [] });
  });

  test('valid values are used', () => {
    const { settings, issues } = policy.readSettings({ SPEAKING_COACH_PASS_PERCENT: '80', SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION: '5',
      SPEAKING_COACH_MAX_RECORDING_SECONDS: '60', SPEAKING_COACH_MIN_WORDS: '10', SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER: '15',
      SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER: '100', SPEAKING_COACH_CHECK_MAX_OUTPUT_TOKENS: '4000', SPEAKING_COACH_TASKS_MAX_OUTPUT_TOKENS: '3500' });
    expect(issues).toEqual([]);
    expect(settings).toEqual({ passPercent: 80, maxAttemptsPerSubmission: 5, maxRecordingSeconds: 60, minWords: 10, dailyMinutesPerTeacher: 15,
      monthlyMinutesPerTeacher: 100, checkMaxOutputTokens: 4000, tasksMaxOutputTokens: 3500 });
  });

  test.each([['SPEAKING_COACH_CHECK_MAX_OUTPUT_TOKENS', 'checkMaxOutputTokens', 3000], ['SPEAKING_COACH_TASKS_MAX_OUTPUT_TOKENS', 'tasksMaxOutputTokens', 2500]])(
    '%s: 256 to 8000, anything else ignored', (name, key, fallback) => {
      expect(policy.readSettings({ [name]: '256' }).settings[key]).toBe(256);
      expect(policy.readSettings({ [name]: '8000' }).settings[key]).toBe(8000);
      for (const bad of ['255', '8001', 'many', '2500.5']) expect(policy.readSettings({ [name]: bad })).toMatchObject({ settings: { [key]: fallback }, issues: [name] });
    });

  test('the retired single limit (SPEAKING_COACH_AI_MAX_OUTPUT_TOKENS, 1200) no longer lowers either call', () => {
    expect(policy.readSettings({ SPEAKING_COACH_AI_MAX_OUTPUT_TOKENS: '1200' }).settings).toMatchObject({ checkMaxOutputTokens: 3000, tasksMaxOutputTokens: 2500 });
  });

  test('the retry after a truncated reply: twice the limit, never above 8000', () => {
    expect(policy.truncationRetryLimit(3000)).toBe(6000);
    expect(policy.truncationRetryLimit(2500)).toBe(5000);
    expect(policy.truncationRetryLimit(5000)).toBe(8000);
    expect(policy.truncationRetryLimit(8000)).toBe(8000);
  });

  test.each([[{}, 'low'], [{ SPEAKING_COACH_REASONING_EFFORT: 'medium' }, 'medium'], [{ SPEAKING_COACH_REASONING_EFFORT: ' HIGH ' }, 'high'],
    [{ SPEAKING_COACH_REASONING_EFFORT: 'none' }, 'low'], [{ SPEAKING_COACH_REASONING_EFFORT: 'max' }, 'low']])(
    'the reasoning effort %j -> %s (low, medium or high; anything else is low)', (env, effort) => {
      expect(policy.reasoningEffort(env)).toBe(effort);
    });

  test.each([
    ['SPEAKING_COACH_PASS_PERCENT', '49', 'passPercent', 70],
    ['SPEAKING_COACH_PASS_PERCENT', '101', 'passPercent', 70],
    ['SPEAKING_COACH_PASS_PERCENT', '70.5', 'passPercent', 70],
    ['SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION', '0', 'maxAttemptsPerSubmission', 20],
    ['SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION', '51', 'maxAttemptsPerSubmission', 20],
    ['SPEAKING_COACH_MAX_RECORDING_SECONDS', '14', 'maxRecordingSeconds', 90],
    ['SPEAKING_COACH_MAX_RECORDING_SECONDS', '181', 'maxRecordingSeconds', 90],
    ['SPEAKING_COACH_MIN_WORDS', '4', 'minWords', 15],
    ['SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER', 'abc', 'dailyMinutesPerTeacher', 30]
  ])('%s=%s is ignored (reported by name only)', (name, value, key, fallback) => {
    const { settings, issues } = policy.readSettings({ [name]: value });
    expect(settings[key]).toBe(fallback);
    expect(issues).toEqual([name]);
  });

  test('a monthly cap below the daily cap resets both to the defaults', () => {
    const { settings, issues } = policy.readSettings({ SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER: '50', SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER: '40' });
    expect(settings).toMatchObject({ dailyMinutesPerTeacher: 30, monthlyMinutesPerTeacher: 300 });
    expect(issues).toEqual(['SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER']);
  });
});

describe('the pass rule (D3)', () => {
  test('4 levels (the default speaking rubric: 100, 75, 50, 25): 70 is the threshold; 75 and 100 pass', () => {
    const l = levels([100, 75, 50, 25]);
    expect(policy.passRule(l, 70)).toEqual({ rule: 'threshold', minimumPercent: 70 });
    expect([100, 75, 50, 25].map(p => policy.isPassingLevel(p, l, 70))).toEqual([true, true, false, false]);
  });

  test('3 levels (100, 66.67, 33.33): no level in [70, 100), so the second-highest level passes', () => {
    const l = levels([100, 66.67, 33.33]);
    expect(policy.passRule(l, 70)).toEqual({ rule: 'second_highest', minimumPercent: 66.67 });
    expect([100, 66.67, 33.33].map(p => policy.isPassingLevel(p, l, 70))).toEqual([true, true, false]);
  });

  test('a custom 5-level rubric (100, 80, 60, 40, 20): 80 is in range, so the threshold applies', () => {
    const l = levels([100, 80, 60, 40, 20]);
    expect(policy.passRule(l, 70)).toEqual({ rule: 'threshold', minimumPercent: 70 });
    expect([100, 80, 60, 40, 20].map(p => policy.isPassingLevel(p, l, 70))).toEqual([true, true, false, false, false]);
  });

  test('a custom rubric with uneven levels (100, 90, 40, 10) and passPercent 95: 90 is not in [95, 100), so 90 passes', () => {
    const l = levels([10, 100, 40, 90]);           // order in the rubric does not matter
    expect(policy.passRule(l, 95)).toEqual({ rule: 'second_highest', minimumPercent: 90 });
    expect(policy.isPassingLevel(90, l, 95)).toBe(true);
    expect(policy.isPassingLevel(40, l, 95)).toBe(false);
  });

  test('a level exactly at passPercent (100, 70, 40) is in range: the threshold applies and 70 passes', () => {
    const l = levels([100, 70, 40]);
    expect(policy.passRule(l, 70)).toEqual({ rule: 'threshold', minimumPercent: 70 });
    expect([100, 70, 40].map(p => policy.isPassingLevel(p, l, 70))).toEqual([true, true, false]);
  });

  test('2 levels (100, 50): only the top level passes (the second-highest is the lowest, which would pass every attempt)', () => {
    const l = levels([100, 50]);
    expect(policy.passRule(l, 70)).toEqual({ rule: 'top_only', minimumPercent: 100 });
    expect([100, 50].map(p => policy.isPassingLevel(p, l, 70))).toEqual([true, false]);
  });

  test('passPercent 100: the range [100, 100) is empty, so the second-highest level passes', () => {
    const l = levels([100, 75, 50, 25]);
    expect(policy.passRule(l, 100)).toEqual({ rule: 'second_highest', minimumPercent: 75 });
  });

  test('a level percent that is not a number never passes', () => {
    expect(policy.isPassingLevel(undefined, levels([100, 75, 50, 25]), 70)).toBe(false);
    expect(policy.isPassingLevel(NaN, levels([100, 75, 50, 25]), 70)).toBe(false);
  });
});
