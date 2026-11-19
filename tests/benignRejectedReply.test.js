'use strict';

process.env.NODE_ENV = 'test';

const logger = require('../src/utils/logger');
const semantic = require('../src/services/semanticWritingCorrections.service');
const wire = require('../src/services/compactCorrectionWire.service');
const { fallbackLegend } = require('../src/services/correctionLegendResolver.service');
const { reviewPayload, finding: reviewFinding } = require('./helpers/astraAssessmentFixtures.cjs');

const legend = semantic.compactSemanticLegend(fallbackLegend());
const finding = (overrides = {}) => ({ category: 'MECHANICS', symbol: 'CAP', quotedText: 'monday', suggestedText: 'Monday', occurrence: 0,
  confidence: 0.95, message: 'Capitalise the day.', correctionKind: 'localized', severity: 'low', stylePreference: false, ...overrides });
const transcript = 'We met on monday at the park.';
const validate = items => semantic.validateCorrections(items, { transcript, legend, spans: [], policy: {}, transcriptComplete: true });
let warn;
beforeEach(() => { warn = jest.spyOn(logger, 'warn').mockImplementation(() => {}); jest.spyOn(logger, 'info').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());
const logged = event => warn.mock.calls.map(([entry]) => entry).filter(entry => entry?.event === event);

describe('a reply whose findings are all rejected for benign reasons', () => {
  test.each([
    ['low confidence', [finding({ confidence: 0.5 })], { LOW_CONFIDENCE: 1 }],
    ['no-op', [finding({ suggestedText: 'monday' })], { NO_OP_CORRECTION: 1 }],
    ['both', [finding({ confidence: 0.5 }), finding({ symbol: 'P', quotedText: 'park.', suggestedText: 'park.' })], { LOW_CONFIDENCE: 1, NO_OP_CORRECTION: 1 }]
  ])('%s: kept as zero findings, marked and logged with codes and counts only', (_label, items, reasons) => {
    const result = validate(items);
    expect(result.corrections).toEqual([]);
    expect(result.diagnostics.rejectionReasons).toEqual(reasons);
    expect(result.diagnostics.allFindingsRejected).toEqual({ benign: true, reasons });
    const [entry] = logged('correction_reply_all_findings_rejected');
    expect(entry).toEqual({ event: 'correction_reply_all_findings_rejected', outcome: 'kept_as_zero_findings', provider: null, model: null,
      attemptIndex: null, rejectedCount: items.length, reasons });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/monday|park|Capitalise/u);
  });
});

describe('a reply with any structural rejection still fails as before', () => {
  test.each([
    ['quote not found', [finding({ confidence: 0.5 }), finding({ quotedText: 'tuesday', suggestedText: 'Tuesday' })], 'QUOTE_NOT_FOUND'],
    ['occurrence not found', [finding({ quotedText: 'e', suggestedText: 'E', occurrence: 9 })], 'OCCURRENCE_NOT_FOUND'],
    ['schema invalid', [finding({ suggestedText: 'Monday', message: '' })], 'INVALID_SCHEMA'],
    ['wrong symbol', [finding({ symbol: 'XYZ' })], 'LEGEND_MISMATCH'],
    ['unsupported kind', [finding({ correctionKind: 'global' })], 'UNSUPPORTED_CORRECTION_KIND'],
    ['style preference is not benign', [finding({ stylePreference: true })], 'STYLE_PREFERENCE']
  ])('%s', (_label, items, code) => {
    let error; try { validate(items); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'canonical_validation' });
    expect(error.rejectionReasons[code]).toBeGreaterThanOrEqual(1);
    const [entry] = logged('correction_reply_all_findings_rejected');
    expect(entry).toMatchObject({ outcome: 'failed_structural', rejectedCount: items.length, reasons: error.rejectionReasons });
  });

  test('an empty reply and a reply with a valid finding are unchanged and not logged', () => {
    expect(validate([]).corrections).toEqual([]);
    const mixed = validate([finding(), finding({ confidence: 0.5, quotedText: 'park', suggestedText: 'Park' })]);
    expect(mixed.corrections).toHaveLength(1);
    expect(mixed.diagnostics.allFindingsRejected).toBeUndefined();
    expect(logged('correction_reply_all_findings_rejected')).toEqual([]);
  });
});

describe('end to end through the production analysis and retry path', () => {
  const model = 'google/gemini-3.8-flash';
  const env = { OPENROUTER_API_KEY: 'mock-only', CORRECTION_DETECTION_MODEL: model, ASSESSMENT_AI_PRIMARY_RETRIES: '1' };
  const payload = findings => { const v = reviewPayload('synthetic', undefined, findings); return { reviewContract: wire.EXPLANATION_VERSION, transcriptHash: 'synthetic',
    categories: Object.fromEntries(Object.entries(v.categories).map(([k, r]) => [k, { reviewed: true, reviewedSymbols: Object.fromEntries(r.reviewedSymbols.map(s => [s, true])),
      corrections: r.corrections.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'stylePreference'))) }])) }; };
  const response = value => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) });
  // The coordinator is the production entry point: it owns the single same-request retry and compact recovery.
  const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
  const run = findings => { const fetchImpl = jest.fn(async () => response(payload(findings)));
    return { fetchImpl, result: coordinator.analyze({ transcript, transcriptHash: 'synthetic', transcriptComplete: true, spans: [],
      deadlineAt: Date.now() + 120000, submissionId: 'benign-test' }, { env, fetchImpl }) }; };

  test('benign: one request, completed review, zero findings with the reason kept in the diagnostics', async () => {
    const { fetchImpl, result } = run([reviewFinding('MECHANICS', 'CAP', 'monday', { suggestedText: 'Monday', confidence: 0.5 })]);
    const value = await result;
    expect(value.status).not.toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(value.corrections).toEqual([]);
    expect(value.diagnostics.allFindingsRejected).toEqual({ benign: true, reasons: { LOW_CONFIDENCE: 1 } });
    expect(logged('correction_reply_all_findings_rejected').map(entry => entry.outcome)).toEqual(['kept_as_zero_findings']);
  });

  test('structural: retried once, then the analysis fails; nothing is reported as a clean essay', async () => {
    const { fetchImpl, result } = run([reviewFinding('MECHANICS', 'CAP', 'tuesday', { suggestedText: 'Tuesday' })]);
    let value = null, error = null;
    try { value = await result; } catch (caught) { error = caught; }
    expect(error || value?.status === 'failed').toBeTruthy();
    expect(value?.corrections?.length ?? 0).toBe(0);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const outcomes = logged('correction_reply_all_findings_rejected').map(entry => entry.outcome);
    expect(outcomes.length).toBe(fetchImpl.mock.calls.length);
    expect(new Set(outcomes)).toEqual(new Set(['failed_structural']));
  });
});
