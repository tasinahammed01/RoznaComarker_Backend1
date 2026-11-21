'use strict';
// The teacher PDF of the assignment report shows the same "Common mistakes" examples as the page: the first three per type, with the
// student's sentence (mistake and correction marked) and the reason; every text escaped. Tested on the HTML directly. Synthetic data only.
const { renderAssignmentReportHtml } = require('../src/pdf/assignmentReportTemplate');

describe('the teacher PDF', () => {
  const section = examples => ({ basis: 'visible_corrections', totalStudents: 4, minStudents: 2, state: 'ok', partial: false,
    types: [{ typeCode: 'SP', label: 'Spelling', category: 'MECHANICS', studentCount: 3, totalStudents: 4, occurrenceCount: 6, isCommon: true, examples }] });
  const sentence = (before, error, corrected, after) => ({ cutStart: false, cutEnd: false, parts: [{ text: before }, { text: error, error: true, corrected }, { text: after }] });
  const html = commonMistakes => renderAssignmentReportHtml({
    version: 'assignment-report-v1', generatedAt: '2026-11-14T10:00:00.000Z', timeZone: 'UTC',
    assignment: { id: '5f0000000000000000000001', title: 'Synthetic essay', className: 'Class 1', deadline: null, writingType: null },
    counts: { total: 4, bySource: { class: 4, guest: 0, teacherUpload: 0 }, scored: 4, inProgress: 0, notScored: 0, reviewed: 0, late: 0, skippedRows: 0, capped: false },
    scores: { average: 70, median: 70, highest: 80, lowest: 60, onTrack: 1, needsRevision: 3, needsAttention: 0, needsRevisionPct: 75, needsAttentionPct: 0, reviewedPct: 0, bands: [] },
    rubric: { kind: 'builtin', strongestKey: null, weakestKey: null, criteria: [] },
    errors: { basis: 'ai_analysis', total: 0, symbolTotal: 0, submissionsWithCorrections: 0, categories: [], symbols: [] },
    commonMistakes, timeline: { granularity: 'day', points: [] }, students: [], insights: [], smallData: { distributionHidden: true, timelineHidden: true }
  }, { generatedAt: new Date('2026-11-14T20:30:00.000Z') });

  test('shows the first three examples with the sentence (mistake and correction marked) and the reason', () => {
    const ex = n => ({ original: `wrd${'abcde'[n]}`, corrected: 'word', explanation: `Reason ${'abcde'[n]}.`, sentence: sentence('I wrote a ', `wrd${'abcde'[n]}`, 'word', ' here.') });
    const out = html(section([0, 1, 2, 3, 4].map(ex)));
    expect(out).toContain('I wrote a <mark class="err">wrda</mark> here.');
    expect(out).toContain('I wrote a <mark class="fix">word</mark> here.');
    expect(out).toContain('Reason c.');
    expect(out).not.toContain('wrdd');
    expect(out).not.toContain('Reason e.');
  });

  test('a sentence with markup in it is escaped; a gap and cut edges show an ellipsis', () => {
    const out = html(section([{ original: '<img src=x onerror=alert(1)>', corrected: 'fixed', explanation: '<b>why</b>',
      sentence: { cutStart: true, cutEnd: true, parts: [{ text: '<script>x</script> a ' }, { text: '<img src=x onerror=alert(1)>', error: true, corrected: '<i>fixed</i>' }, { gap: true }, { text: ' end &' }] } }]));
    // Only the section's own text is checked (the template's logo image and readiness script are not student text).
    const common = out.slice(out.indexOf('data-section="common-errors"'), out.indexOf('<h2>Students</h2>'));
    expect(common.length).toBeGreaterThan(0);
    expect(common).not.toMatch(/<img|<script|<i>|<b>why/u);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('… &lt;script&gt;x&lt;/script&gt; a ');
    expect(out).toContain(' … ');
    expect(out).toContain('end &amp;…');
  });

  test('an example without a sentence still shows the word pair as before', () => {
    const out = html(section([{ original: 'cub', corrected: 'cup', explanation: 'Wrong word.' }]));
    expect(out).toMatch(/<del>cub<\/del>.*<ins>cup<\/ins>/su);
    expect(out).not.toContain('class="err"');
  });
});
