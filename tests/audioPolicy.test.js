'use strict';
// Audio + speech-to-text, stage 0: the feature switch and the limits read from the environment (services/audio/policy.js).
// Pure: no database, no network. Every value has a safe default; a value that is not a whole number, or is outside its range, is ignored
// (the default is used) and reported by name only, never by value.
const policy = require('../src/services/audio/policy');

describe('audio feature switch', () => {
  test.each([
    [undefined, false], ['', false], ['false', false], ['0', false], ['yes', false], ['TRUE ', true], ['true', true], [' True', true]
  ])('AUDIO_STT_ENABLED=%p is %p', (value, expected) => {
    expect(policy.audioSttEnabled(value === undefined ? {} : { AUDIO_STT_ENABLED: value })).toBe(expected);
  });
});

describe('audio limits', () => {
  test('defaults when nothing is set', () => {
    const { limits, issues } = policy.readLimits({});
    expect(issues).toEqual([]);
    expect(limits).toEqual({
      maxFileBytes: 41943040,
      maxDurationSeconds: 420,
      durationToleranceSeconds: 1,
      minDurationSeconds: 5,
      dailyMinutesPerTeacher: 120,
      monthlyMinutesPerTeacher: 1500,
      sttTimeoutMs: 300000,
      sttMaxAttempts: 3,
      sttProvider: 'deepgram',
      sttFallbackProvider: null
    });
    expect(Object.isFrozen(limits)).toBe(true);
  });

  test('valid values are used', () => {
    const { limits, issues } = policy.readLimits({ AUDIO_MAX_FILE_BYTES: '10485760', AUDIO_MAX_DURATION_SECONDS: '300',
      AUDIO_DAILY_MINUTES_PER_TEACHER: '60', AUDIO_MONTHLY_MINUTES_PER_TEACHER: '900', AUDIO_STT_TIMEOUT_MS: '120000',
      AUDIO_STT_MAX_ATTEMPTS: '2', AUDIO_STT_PROVIDER: 'OpenAI', AUDIO_STT_FALLBACK_PROVIDER: 'deepgram' });
    expect(issues).toEqual([]);
    expect(limits).toMatchObject({ maxFileBytes: 10485760, maxDurationSeconds: 300, dailyMinutesPerTeacher: 60, monthlyMinutesPerTeacher: 900,
      sttTimeoutMs: 120000, sttMaxAttempts: 2, sttProvider: 'openai', sttFallbackProvider: 'deepgram' });
  });

  test('a fallback equal to the primary provider is dropped (no loop to the same provider)', () => {
    const { limits, issues } = policy.readLimits({ AUDIO_STT_PROVIDER: 'deepgram', AUDIO_STT_FALLBACK_PROVIDER: 'deepgram' });
    expect(limits.sttFallbackProvider).toBeNull();
    expect(issues).toEqual(['AUDIO_STT_FALLBACK_PROVIDER']);
  });

  test('deepgram primary with openai fallback', () => {
    expect(policy.readLimits({ AUDIO_STT_FALLBACK_PROVIDER: ' openai ' }).limits.sttFallbackProvider).toBe('openai');
    expect(policy.readLimits({ AUDIO_STT_FALLBACK_PROVIDER: 'none' }).limits.sttFallbackProvider).toBeNull();
    expect(policy.readLimits({ AUDIO_STT_FALLBACK_PROVIDER: '' }).limits.sttFallbackProvider).toBeNull();
  });

  test.each([
    ['AUDIO_MAX_FILE_BYTES', 'abc', 'maxFileBytes', 41943040],
    ['AUDIO_MAX_FILE_BYTES', '12.5', 'maxFileBytes', 41943040],
    ['AUDIO_MAX_FILE_BYTES', '1e7', 'maxFileBytes', 41943040],
    ['AUDIO_MAX_FILE_BYTES', '-5', 'maxFileBytes', 41943040],
    ['AUDIO_MAX_FILE_BYTES', '1023', 'maxFileBytes', 41943040],            // under the 1 MB floor
    ['AUDIO_MAX_FILE_BYTES', '60000000', 'maxFileBytes', 41943040],        // over the 50 MB ceiling (proxy allows 52 MB per request)
    ['AUDIO_MAX_DURATION_SECONDS', '4', 'maxDurationSeconds', 420],         // must be above the 5 s minimum
    ['AUDIO_MAX_DURATION_SECONDS', '7200', 'maxDurationSeconds', 420],
    ['AUDIO_DAILY_MINUTES_PER_TEACHER', '0', 'dailyMinutesPerTeacher', 120],
    ['AUDIO_MONTHLY_MINUTES_PER_TEACHER', 'lots', 'monthlyMinutesPerTeacher', 1500],
    ['AUDIO_STT_TIMEOUT_MS', '500', 'sttTimeoutMs', 300000],
    ['AUDIO_STT_TIMEOUT_MS', '3600000', 'sttTimeoutMs', 300000],
    ['AUDIO_STT_MAX_ATTEMPTS', '0', 'sttMaxAttempts', 3],
    ['AUDIO_STT_MAX_ATTEMPTS', '4', 'sttMaxAttempts', 3],
    ['AUDIO_STT_PROVIDER', 'whisper', 'sttProvider', 'deepgram'],
    ['AUDIO_STT_FALLBACK_PROVIDER', 'google', 'sttFallbackProvider', null]
  ])('%s=%p is ignored (default used) and reported by name', (name, value, key, fallback) => {
    const { limits, issues } = policy.readLimits({ [name]: value });
    expect(limits[key]).toBe(fallback);
    expect(issues).toEqual([name]);
    expect(JSON.stringify(issues)).not.toContain(String(value));
  });

  test('a monthly cap below the daily cap is reported and both defaults are kept', () => {
    const { limits, issues } = policy.readLimits({ AUDIO_DAILY_MINUTES_PER_TEACHER: '200', AUDIO_MONTHLY_MINUTES_PER_TEACHER: '100' });
    expect(limits.dailyMinutesPerTeacher).toBe(120);
    expect(limits.monthlyMinutesPerTeacher).toBe(1500);
    expect(issues).toEqual(['AUDIO_MONTHLY_MINUTES_PER_TEACHER']);
  });

  test('limits are read at call time, not frozen at module load', () => {
    expect(policy.readLimits({ AUDIO_MAX_DURATION_SECONDS: '200' }).limits.maxDurationSeconds).toBe(200);
    expect(policy.readLimits({}).limits.maxDurationSeconds).toBe(420);
  });

  test('maximum accepted duration includes the 1 s tolerance', () => {
    expect(policy.maxAcceptedDurationSeconds(policy.readLimits({}).limits)).toBe(421);
  });

  test('the public config exposes limits only, never provider names or keys', () => {
    const env = { AUDIO_STT_ENABLED: 'true', AUDIO_STT_FALLBACK_PROVIDER: 'openai', DEEPGRAM_API_KEY: 'dg-secret-value', OPENAI_API_KEY: 'sk-secret-value' };
    const config = policy.publicConfig(env, { role: 'teacher' });
    expect(config).toEqual({ enabled: true, maxFileBytes: 41943040, maxDurationSeconds: 420, minDurationSeconds: 5,
      dailyMinutesPerTeacher: 120, monthlyMinutesPerTeacher: 1500 });
    const text = JSON.stringify(config);
    for (const hidden of ['deepgram', 'openai', 'secret', 'sttTimeoutMs', 'sttProvider']) expect(text.toLowerCase()).not.toContain(hidden.toLowerCase());
  });

  test('teacher minute caps are shown to teachers only', () => {
    expect(policy.publicConfig({ AUDIO_STT_ENABLED: 'true' }, { role: 'student' })).toEqual({ enabled: true, maxFileBytes: 41943040,
      maxDurationSeconds: 420, minDurationSeconds: 5 });
  });

  test('the public config is { enabled: false } while the feature is off', () => {
    expect(policy.publicConfig({}, { role: 'teacher' })).toEqual({ enabled: false });
  });
});
