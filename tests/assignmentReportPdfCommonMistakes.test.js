'use strict';
// "Common errors" in the assignment report PDF: the page's one card (it replaced "Most common errors" and "Common mistakes"), from the same
// payload, placed where the page has it (after the overview, before "Students"): category chips from the AI analysis with its note, then
// one row per correction type from the corrections students see ("4 of 6 students · 7 times"), with up to 3 examples (the original struck
// through, then the correction, then the explanation) for a type 2 or more students made; the AI type counts for an older payload or too
// few students; the two empty states; the partial note; every text escaped; page-break safe (a type's block never splits; the section may
// break between types). Tested on the HTML directly (no browser). Synthetic data only.
const { renderAssignmentReportHtml, ERRORS_NOTE, COMMON_MISTAKES_NOTE } = require('../src/pdf/assignmentReportTemplate');

const report = (commonMistakes, overrides = {}) => ({
  version: 'assignment-report-v1', generatedAt: '2026-11-14T10:00:00.000Z', timeZone: 'UTC',
  assignment: { id: '5f0000000000000000000001', title: 'Persuasive essay', className: 'Writing 7B', deadline: null, writingType: null },
  counts: { total: 6, bySource: { class: 5, guest: 1, teacherUpload: 0 }, scored: 6, inProgress: 0, notScored: 0, reviewed: 0, late: 0, skippedRows: 0, capped: false },
  scores: { average: 70, median: 70, highest: 80, lowest: 60, onTrack: 1, needsRevision: 5, needsAttention: 0, needsRevisionPct: 83, needsAttentionPct: 0, reviewedPct: 0,
    bands: [] },
  rubric: { kind: 'builtin', strongestKey: null, weakestKey: null, criteria: [] },
  errors: { basis: 'ai_analysis', total: 3, symbolTotal: 3, submissionsWithCorrections: 2, categories: [{ key: 'GRAMMAR', label: 'Grammar', color: null, count: 3, pct: 100 },
    { key: 'MECHANICS', label: 'Mechanics', color: null, count: 0, pct: 0 }],
    symbols: [{ symbol: 'VF', label: 'Verb Form', category: 'GRAMMAR', count: 3, pct: 100 }] },
  commonMistakes,
  timeline: { granularity: 'day', points: [] },
  students: [{ submissionId: '5f0000000000000000000009', name: 'Ana Ray', source: 'class', score: 70, band: 'needs_revision', assessment: 'scored', notScoredReason: null,
    reviewed: false, topIssue: null, submittedAt: null, isLate: false, draftNumber: 1, needsAttention: false, attentionReasons: [] }],
  insights: [], smallData: { distributionHidden: true, timelineHidden: true }, ...overrides
});
const ok = (over = {}) => ({ basis: 'visible_corrections', totalStudents: 6, minStudents: 2, state: 'ok', partial: false, types: [
  { typeCode: 'VF', label: 'Verb Form', category: 'GRAMMAR', studentCount: 4, totalStudents: 6, occurrenceCount: 7, isCommon: true, examples: [
    { original: 'He go', corrected: 'He goes', explanation: 'Third person singular.' }, { original: 'builded', corrected: 'built', explanation: '' },
    { original: 'a apple', corrected: '', explanation: 'Use "an" before a vowel sound.' }] },
  { typeCode: 'SP', label: 'Spelling', category: 'MECHANICS', studentCount: 2, totalStudents: 6, occurrenceCount: 2, isCommon: true, examples: [
    { original: 'teh', corrected: 'the', explanation: 'Spelling.' }] },
  { typeCode: 'WC', label: 'Word Choice', category: 'VOCABULARY', studentCount: 1, totalStudents: 6, occurrenceCount: 1, isCommon: false, examples: [] }], ...over });
const html = r => renderAssignmentReportHtml(r, { generatedAt: new Date('2026-11-14T20:30:00.000Z') });
const textOf = h => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const section = h => h.slice(h.indexOf('data-section="common-errors"'), h.indexOf('<h2>Students</h2>'));
const rows = h => [...section(h).matchAll(/<div class="mistake"><div class="bar-head"><span class="bar-label">([^<]*)<\/span><span class="bar-value">([^<]*)<\/span>/g)]
  .map(m => `${m[1]} | ${m[2]}`);

describe('the Common errors section in the report PDF', () => {
  test('one section replaces the two, before "Students": chips with the AI-analysis note, then a row per type with students and total, and the examples', () => {
    const h = html(report(ok()));
    expect(h).not.toContain('<h2>Most common errors</h2>');
    expect(h).not.toContain('<h2>Common mistakes</h2>');
    const commonAt = h.indexOf('<h2>Common errors</h2>'), studentsAt = h.indexOf('<h2>Students</h2>');
    expect(commonAt).toBeGreaterThan(-1);
    expect(studentsAt).toBeGreaterThan(commonAt);
    const t = textOf(section(h));
    expect(COMMON_MISTAKES_NOTE).toBe('Based on the corrections students can see. Corrections you removed are not counted.');
    expect(t).toContain(COMMON_MISTAKES_NOTE);
    expect(t).toContain('By category Grammar 3');
    expect(t).not.toContain('Mechanics 0');
    expect(t).toContain(ERRORS_NOTE);
    expect(rows(h)).toEqual(['VF · Verb Form | 4 of 6 students · 7 times', 'SP · Spelling | 2 of 6 students · 2 times', 'WC · Word Choice | 1 student · 1 time']);
    expect(section(h)).toContain('<del>He go</del>');
    expect(section(h)).toContain('<ins>He goes</ins>');
    expect(t).toContain('Third person singular.');
    // No replacement: the original and the explanation only, no arrow.
    expect(section(h)).toMatch(/<del>a apple<\/del>(?!\s*<span class="arrow")/);
    expect(t).toContain('Use "an" before a vowel sound.');
    // A type only one student made has no examples (anonymity).
    expect(section(h).split('WC · Word Choice')[1]).not.toContain('class="example"');
  });

  test('page-break safe: a type\'s block never splits; the section may break between types', () => {
    const h = html(report(ok()));
    expect(h).toMatch(/\.mistake\{[^}]*break-inside:avoid[^}]*page-break-inside:avoid/);
    expect(h).toMatch(/\.panel\.common\{[^}]*break-inside:auto/);
    expect(h).toContain('<section class="panel common" data-section="common-errors">');
  });

  test('the empty states: fewer than 2 students (the AI type counts still listed); nothing shared by 2 or more', () => {
    const notEnough = html(report({ ...ok(), state: 'not_enough_students', totalStudents: 1, types: [] }));
    expect(textOf(section(notEnough))).toContain('Not enough submissions yet to find common mistakes');
    expect(rows(notEnough)).toEqual(['VF · Verb Form | 3 times']);
    expect(textOf(section(html(report({ ...ok(), state: 'none_shared', types: [] }))))).toContain('No mistake was shared by 2 or more students.');
  });

  test('partial: the note that some edited essays were left out', () => {
    expect(textOf(section(html(report(ok({ partial: true })))))).toContain('Some edited essays were left out of this section.');
    expect(textOf(section(html(report(ok()))))).not.toContain('left out');
  });

  test('every text is escaped; nothing but the three example fields of a type is printed', () => {
    const hostile = ok({ types: [{ typeCode: 'VF', label: '<b>Verb</b>', category: 'GRAMMAR', studentCount: 2, totalStudents: 2, occurrenceCount: 2, isCommon: true,
      examples: [{ original: '<script>x</script>', corrected: '"><img src=x>', explanation: '<i>why</i>', submissionId: 'SECRET-ID', name: 'SECRET NAME' }] }] });
    const s = section(html(report(hostile)));
    expect(s).not.toContain('<script>');
    expect(s).not.toContain('<img');
    expect(s).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(s).toContain('&lt;b&gt;Verb&lt;/b&gt;');
    expect(s).not.toContain('SECRET');
  });

  test('an older payload without commonMistakes: the AI type counts and the AI-analysis note, no students chip; the empty report has no section', () => {
    const old = report(undefined);
    delete old.commonMistakes;
    const h = html(old);
    expect(rows(h)).toEqual(['VF · Verb Form | 3 times']);
    expect(textOf(section(h))).toContain(ERRORS_NOTE);
    expect(textOf(section(h))).not.toContain(COMMON_MISTAKES_NOTE);
    expect(html(report(ok(), { counts: { ...report(ok()).counts, total: 0 } }))).not.toContain('Common errors');
  });

  test('no corrections at all: the section says so', () => {
    const none = report(undefined, { errors: { basis: 'ai_analysis', total: 0, symbolTotal: 0, submissionsWithCorrections: 0, categories: [], symbols: [] } });
    delete none.commonMistakes;
    expect(textOf(section(html(none)))).toContain('No corrections recorded yet.');
  });
});
