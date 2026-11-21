'use strict';
// "Common mistakes" in the assignment report PDF (Stage B): the same section as the page, from the same payload. Placed after "Most common
// errors" and before "Students"; one block per common type ("4 of 6 students", a bar, up to 3 examples: the original struck through, then
// the correction, then the explanation); the two empty states; the partial note; every text escaped; page-break safe (a type's block never
// splits; the section may break between types). Tested on the HTML directly (no browser). Synthetic data only.
const { renderAssignmentReportHtml, ERRORS_NOTE, COMMON_MISTAKES_NOTE } = require('../src/pdf/assignmentReportTemplate');

const report = (commonMistakes, overrides = {}) => ({
  version: 'assignment-report-v1', generatedAt: '2026-11-14T10:00:00.000Z', timeZone: 'UTC',
  assignment: { id: '5f0000000000000000000001', title: 'Persuasive essay', className: 'Writing 7B', deadline: null, writingType: null },
  counts: { total: 6, bySource: { class: 5, guest: 1, teacherUpload: 0 }, scored: 6, inProgress: 0, notScored: 0, reviewed: 0, late: 0, skippedRows: 0, capped: false },
  scores: { average: 70, median: 70, highest: 80, lowest: 60, onTrack: 1, needsRevision: 5, needsAttention: 0, needsRevisionPct: 83, needsAttentionPct: 0, reviewedPct: 0,
    bands: [] },
  rubric: { kind: 'builtin', strongestKey: null, weakestKey: null, criteria: [] },
  errors: { basis: 'ai_analysis', total: 3, symbolTotal: 3, submissionsWithCorrections: 2, categories: [{ key: 'GRAMMAR', label: 'Grammar', color: null, count: 3, pct: 100 }],
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
const section = h => h.slice(h.indexOf('data-section="common-mistakes"'), h.indexOf('<h2>Students</h2>'));

describe('the Common mistakes section in the report PDF', () => {
  test('after "Most common errors" and before "Students"; its note; one block per common type with "4 of 6 students", a bar and the examples', () => {
    const h = html(report(ok()));
    const errorsAt = h.indexOf('<h2>Most common errors</h2>'), commonAt = h.indexOf('<h2>Common mistakes</h2>'), studentsAt = h.indexOf('<h2>Students</h2>');
    expect(errorsAt).toBeGreaterThan(-1);
    expect(commonAt).toBeGreaterThan(errorsAt);
    expect(studentsAt).toBeGreaterThan(commonAt);
    const t = textOf(section(h));
    expect(COMMON_MISTAKES_NOTE).toBe('Based on the corrections students can see. Corrections you removed are not counted.');
    expect(t).toContain(COMMON_MISTAKES_NOTE);
    expect(t).toContain('VF · Verb Form');
    expect(t).toContain('4 of 6 students');
    expect(t).toContain('SP · Spelling');
    expect(t).toContain('2 of 6 students');
    expect(t).not.toContain('Word Choice');   // a type only one student made is not shown
    expect((section(h).match(/class="mistake"/g) || [])).toHaveLength(2);
    expect(section(h)).toContain('style="width:67%');   // 4 of 6
    expect(section(h)).toContain('<del>He go</del>');
    expect(section(h)).toContain('<ins>He goes</ins>');
    expect(t).toContain('Third person singular.');
    // No replacement: the original and the explanation only, no arrow.
    expect(section(h)).toMatch(/<del>a apple<\/del>(?!\s*<span class="arrow")/);
    expect(t).toContain('Use "an" before a vowel sound.');
  });

  test('page-break safe: a type\'s block never splits; the section may break between types; the heading stays with what follows', () => {
    const h = html(report(ok()));
    expect(h).toMatch(/\.mistake\{[^}]*break-inside:avoid[^}]*page-break-inside:avoid/);
    expect(h).toMatch(/\.panel\.common\{[^}]*break-inside:auto/);
    expect(h).toContain('<section class="panel common" data-section="common-mistakes">');
  });

  test('the empty states: fewer than 2 students; nothing shared by 2 or more', () => {
    expect(textOf(section(html(report({ ...ok(), state: 'not_enough_students', totalStudents: 1, types: [] })))))
      .toContain('Not enough submissions yet to find common mistakes');
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

  test('an older payload without the section, and the empty report: no section, no error; the errors card and its note are unchanged', () => {
    const old = report(undefined);
    delete old.commonMistakes;
    const h = html(old);
    expect(h).not.toContain('Common mistakes');
    expect(textOf(h)).toContain(ERRORS_NOTE);
    expect(html(report(ok(), { counts: { ...report(ok()).counts, total: 0 } }))).not.toContain('Common mistakes');
  });
});
