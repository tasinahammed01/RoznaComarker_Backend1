'use strict';
// AI summary (Stage 4), pure parts: the model input (aggregates only), its fingerprint, output validation (numbers must come from the input)
// and the gateway request profile for the new feature. No real AI calls: the gateway test uses a mocked fetch.
const summary = require('../src/services/assignmentReportSummary.service');
const gateway = require('../src/services/aiGateway.service');

const NAMES = ['Ana Ray', 'Gus Guest', 'Uma Upload'];
const EMAILS = ['ana.ray@example.com', 'gus@example.com', 'teacher@example.com'];
const IDS = ['5f0000000000000000000001', '5f00000000000000000000aa', '5f00000000000000000000bb'];
function hostileReport(overrides = {}) {
  return {
    version: 'assignment-report-v1', generatedAt: '2026-11-14T10:00:00.000Z', timeZone: 'Asia/Dhaka',
    assignment: { id: IDS[0], title: 'Essay about Ana Ray and ana.ray@example.com', className: 'Class of Gus Guest', deadline: '2026-11-20T00:00:00.000Z', writingType: 'Letter to Uma' },
    counts: { total: 6, bySource: { class: 3, guest: 2, teacherUpload: 1 }, scored: 5, inProgress: 1, notScored: 0, reviewed: 2, late: 1, skippedRows: 0, capped: false },
    scores: { average: 68.7, median: 66, highest: 85, lowest: 55, onTrack: 1, needsRevision: 3, needsAttention: 1, needsRevisionPct: 80, needsAttentionPct: 20, reviewedPct: 33,
      bands: [[0, 49, 0], [50, 59, 1], [60, 69, 2], [70, 79, 1], [80, 89, 1], [90, 100, 0]].map(([min, max, count]) => ({ key: `${min}-${max}`, label: `${min}-${max}`, min, max, count })) },
    rubric: { kind: 'custom', strongestKey: IDS[1], weakestKey: IDS[2], criteria: [
      { key: IDS[1], label: 'Thesis (see Ana Ray example)', averagePct: 82, count: 5 },
      { key: IDS[2], label: 'Evidence from gus@example.com', averagePct: 54, count: 5 }] },
    errors: { basis: 'ai_analysis', total: 40, symbolTotal: 40, submissionsWithCorrections: 5, categories: [
      { key: 'CONTENT', label: 'Content', color: null, count: 4, pct: 10 }, { key: 'ORGANIZATION', label: 'Organization', color: null, count: 6, pct: 15 },
      { key: 'GRAMMAR', label: 'Grammar', color: null, count: 17, pct: 43 }, { key: 'VOCABULARY', label: 'Vocabulary', color: null, count: 5, pct: 13 },
      { key: 'MECHANICS', label: 'Mechanics', color: null, count: 8, pct: 20 }],
      symbols: [{ symbol: 'AGR', label: 'Agreement', category: 'GRAMMAR', count: 9, pct: 23 }, { symbol: 'SP', label: 'Spelling', category: 'MECHANICS', count: 6, pct: 15 }] },
    timeline: { granularity: 'day', points: [{ date: '2026-11-10', count: 2 }, { date: '2026-11-11', count: 4 }] },
    students: NAMES.map((name, i) => ({ submissionId: IDS[i], name, source: 'class', score: 60 + i, band: 'needs_revision', assessment: 'scored', notScoredReason: null,
      reviewed: false, topIssue: { symbol: 'SP', label: 'Spelling', count: 2 }, submittedAt: '2026-11-10T09:00:00.000Z', isLate: false, draftNumber: 1, needsAttention: false, attentionReasons: [],
      email: EMAILS[i], comment: 'SECRET TEACHER COMMENT', transcript: 'SECRET OCR ESSAY TEXT' })),
    insights: [{ code: 'AVERAGE', text: `Ana Ray wrote the best essay; contact ${EMAILS[0]}` }],
    smallData: { distributionHidden: false, timelineHidden: false },
    teacherEmail: EMAILS[2],
    ...overrides
  };
}
const goodOutput = (patch = {}) => JSON.stringify({
  headline: 'The class average is 68.7% across 5 scored submissions.',
  findings: ['Grammar errors are the most common issue at 43% of 40 corrections.', 'Criterion A is the strongest area at 82%.',
    '4 of 5 scored submissions are below 80%.'],
  nextSteps: ['Run a short lesson on subject-verb agreement.', 'Model how to support claims for Criterion B.'],
  caution: 'Counts come from the AI analysis and may include items the teacher removed.',
  ...patch
});

describe('model input: aggregated numbers only', () => {
  test('the serialized input contains no name, email, id or free text from a fixture full of them', () => {
    const { input } = summary.buildSummaryInput(hostileReport());
    const serialized = JSON.stringify(input);
    for (const value of [...NAMES, ...EMAILS, ...IDS, 'Ana', 'Gus', 'Uma', '@', 'SECRET', 'Essay about', 'Class of', 'Letter to', 'Thesis', 'Evidence', 'example', '2026-11'])
      expect(serialized).not.toContain(value);
    expect(serialized).not.toMatch(/[a-f0-9]{24}/);
    // Only these top-level keys exist: nothing about the assignment text, students or dates.
    expect(Object.keys(input).sort()).toEqual(['counts', 'errors', 'rubric', 'scale', 'scoreBands', 'scores', 'thresholds']);
  });

  test('it keeps the aggregated numbers: counts, scores, bands, criterion averages (custom titles as letters), error totals', () => {
    const { input, criterionLabels } = summary.buildSummaryInput(hostileReport());
    expect(input.counts).toEqual({ submissions: 6, scored: 5, inProgress: 1, notScored: 0, late: 1, reviewed: 2 });
    expect(input.scores).toMatchObject({ average: 68.7, median: 66, highest: 85, lowest: 55, needsRevisionPct: 80, needsAttentionPct: 20 });
    expect(input.scoreBands.find(b => b.band === '60-69')).toEqual({ band: '60-69', min: 60, max: 69, count: 2, pctOfScored: 40 });
    expect(input.rubric).toEqual({ kind: 'custom', criteria: [{ criterion: 'Criterion A', averagePct: 82 }, { criterion: 'Criterion B', averagePct: 54 }],
      strongest: 'Criterion A', weakest: 'Criterion B' });
    expect(criterionLabels).toEqual({ 'Criterion A': 'Thesis (see Ana Ray example)', 'Criterion B': 'Evidence from gus@example.com' });
    expect(input.errors.categories.find(c => c.category === 'Grammar')).toEqual({ category: 'Grammar', count: 17, pct: 43 });
    expect(input.errors.topTypes[0]).toEqual({ type: 'Agreement', count: 9, pct: 23 });
  });

  test('built-in rubric categories keep their fixed names', () => {
    const r = hostileReport({ rubric: { kind: 'builtin', strongestKey: 'CONTENT', weakestKey: 'GRAMMAR', criteria: [
      { key: 'CONTENT', label: 'Content', averagePct: 80, count: 5 }, { key: 'GRAMMAR', label: 'Grammar', averagePct: 60, count: 5 }] } });
    expect(summary.buildSummaryInput(r).input.rubric).toEqual({ kind: 'builtin', criteria: [{ criterion: 'Content', averagePct: 80 }, { criterion: 'Grammar', averagePct: 60 }],
      strongest: 'Content', weakest: 'Grammar' });
  });

  test('the fingerprint follows the input, the prompt version and the model, not names, dates or the time zone', () => {
    const a = summary.inputFingerprint(summary.buildSummaryInput(hostileReport()).input, 'anthropic/claude-haiku-5.5');
    const renamed = hostileReport({ timeZone: 'UTC', generatedAt: '2030-01-01T00:00:00.000Z' });
    renamed.students[0].name = 'Somebody Else';
    renamed.assignment.title = 'Another title';
    expect(summary.inputFingerprint(summary.buildSummaryInput(renamed).input, 'anthropic/claude-haiku-5.5')).toBe(a);
    const changed = hostileReport(); changed.scores = { ...changed.scores, average: 70.1 };
    expect(summary.inputFingerprint(summary.buildSummaryInput(changed).input, 'anthropic/claude-haiku-5.5')).not.toBe(a);
    expect(summary.inputFingerprint(summary.buildSummaryInput(hostileReport()).input, 'other/model')).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('output validation', () => {
  const { input } = summary.buildSummaryInput(hostileReport());
  test('a valid summary passes and is normalised', () => {
    expect(summary.validateSummary(goodOutput(), input)).toEqual(JSON.parse(goodOutput()));
  });
  test.each([
    ['an invented number', { headline: 'The class average is 72% across 5 scored submissions.' }, 'AI_SUMMARY_NUMBER'],
    ['an invented spelled number', { findings: ['Seven students struggled with grammar.', 'Grammar is 43% of corrections.', 'Criterion A is strongest.'] }, 'AI_SUMMARY_NUMBER'],
    ['too few findings', { findings: ['Grammar is 43% of 40 corrections.', 'Criterion A is strongest.'] }, 'AI_SUMMARY_SHAPE'],
    ['too many next steps', { nextSteps: ['a step one here', 'a step two here', 'a step three here', 'a step four here', 'a step five here'] }, 'AI_SUMMARY_SHAPE'],
    ['an over-long headline', { headline: 'x'.repeat(200) }, 'AI_SUMMARY_SHAPE'],
    ['markup', { caution: 'Review <b>before</b> sharing.' }, 'AI_SUMMARY_TEXT'],
    ['a link', { caution: 'See https://example.org for details.' }, 'AI_SUMMARY_TEXT'],
    ['an email address', { caution: 'Ask gus@example.com for details.' }, 'AI_SUMMARY_TEXT'],
    ['an extra field', { extra: 'x' }, 'AI_SUMMARY_SHAPE']
  ])('rejects %s', (_name, patch, code) => {
    expect(() => summary.validateSummary(goodOutput(patch), input)).toThrow(expect.objectContaining({ code }));
  });
  test('rounded and percent forms of input numbers are allowed', () => {
    expect(() => summary.validateSummary(goodOutput({ headline: 'The class average is about 69% (68.7 out of 100).' }), input)).not.toThrow();
    expect(() => summary.validateSummary(goodOutput({ headline: 'Two submissions sit in the 60-69 band.' }), input)).not.toThrow();
  });
  test('non-JSON output is rejected', () => {
    expect(() => summary.validateSummary('not json', input)).toThrow(expect.objectContaining({ code: 'AI_SUMMARY_SHAPE' }));
  });
});

describe('gateway request profile for assignment_report_summary', () => {
  const response = payload => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload) });
  test('one OpenRouter model, no fallback chain, no retries; no temperature and reasoning off (no billed thinking)', async () => {
    const env = { OPENROUTER_API_KEY: 'router-test-key', OPENROUTER_BASE_URL: 'https://router.test/v1' };
    const config = summary.aiConfig(env);
    expect(config.chain).toEqual([{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', fallbackIndex: 0 }]);
    expect(config).toMatchObject({ primaryRetries: 0, fallbackRetries: 0, attemptTimeoutMs: 15000, totalBudgetMs: 20000 });
    const fetchImpl = jest.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: goodOutput() } }], usage: { prompt_tokens: 900, completion_tokens: 250 } }));
    const { input } = summary.buildSummaryInput(hostileReport());
    await gateway.generate({ feature: summary.FEATURE, config, env, fetchImpl, messages: summary.messagesFor(input), maxOutputTokens: 700,
      responseFormat: 'json', responseSchema: summary.RESPONSE_SCHEMA, schemaName: summary.FEATURE, validate: raw => summary.validateSummary(raw, input) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('anthropic/claude-haiku-5.5');
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.max_tokens).toBe(700);
    expect(body.response_format.type).toBe('json_schema');
    // The model sees aggregates only.
    const sent = JSON.stringify(body.messages);
    for (const value of [...NAMES, ...EMAILS, ...IDS]) expect(sent).not.toContain(value);
  });

  test('the model comes from ASSIGNMENT_REPORT_SUMMARY_AI_MODEL when it is a well-formed slug; anything else uses the default', () => {
    expect(summary.modelOf({ ASSIGNMENT_REPORT_SUMMARY_AI_MODEL: 'anthropic/claude-sonnet-5.5' })).toBe('anthropic/claude-sonnet-5.5');
    for (const bad of [undefined, '', '  ', 'no-slash', 'a/b c', '../x/y']) expect(summary.modelOf({ ASSIGNMENT_REPORT_SUMMARY_AI_MODEL: bad })).toBe('anthropic/claude-haiku-5.5');
  });

  test('the flag is off unless ASSIGNMENT_REPORT_SUMMARY_ENABLED is exactly true', () => {
    expect(summary.enabled({})).toBe(false);
    for (const v of ['1', 'yes', 'TRUE ', 'false', '']) expect(summary.enabled({ ASSIGNMENT_REPORT_SUMMARY_ENABLED: v })).toBe(v.trim().toLowerCase() === 'true');
    expect(summary.enabled({ ASSIGNMENT_REPORT_SUMMARY_ENABLED: 'true' })).toBe(true);
  });

  test('other features are untouched by the profile (teacher_comment_draft and an unknown feature keep their bodies)', async () => {
    const env = { OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: 'https://router.test/v1' };
    const fetchImpl = jest.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
    await gateway.generate({ feature: 'flashcard_answer_check', config: { chain: [{ provider: 'openrouter', model: 'x/y', fallbackIndex: 0 }], attemptTimeoutMs: 1000, totalBudgetMs: 5000, primaryRetries: 0, fallbackRetries: 0, retryDelayMs: 0 },
      env, fetchImpl, messages: [{ role: 'user', content: 'q' }], temperature: 0, responseFormat: 'json' });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty('reasoning');
  });
});
