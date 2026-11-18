'use strict';
// Stage 9: the email a student receives when the teacher uploaded a recording for them and marking is complete ("Save and send"). Its own
// template: the essay wording (teacherUploadEmailTemplate.js) is not touched. Rubrilo branding only; nothing from the recording.
const { buildTeacherUploadSpeakingFeedbackEmail } = require('../src/services/teacherUploadSpeakingEmailTemplate');
const essay = require('../src/services/teacherUploadEmailTemplate');

const input = over => ({ studentName: 'Ana Lima', teacherName: 'Ms Rahman', assignmentTitle: 'Describe your town', needsLogin: true,
  link: 'https://app.example.test/student/my-classes/detail/my-speaking/a1?classId=c1', ...over });

describe('teacher-uploaded recording: the feedback email (speaking)', () => {
  test('the agreed wording, the assignment, the sign-in line and the link; branded Rubrilo only', () => {
    const { subject, text, html } = buildTeacherUploadSpeakingFeedbackEmail(input());
    expect(subject).toBe('Your feedback is ready: Describe your town');
    expect(text).toContain('Hi Ana Lima,');
    expect(text).toContain('Your teacher uploaded a recording for this assignment. It was marked like your own recording, and your feedback is ready.');
    expect(text).toContain('Sign in to Rubrilo with this email address to see it.');
    expect(text).toContain('https://app.example.test/student/my-classes/detail/my-speaking/a1?classId=c1');
    expect(text).toContain('Sent by Rubrilo on behalf of Ms Rahman.');
    expect(html).toContain('Your teacher uploaded a recording for this assignment.');
    expect(html).toContain('Describe your town');
    expect(`${subject}\n${text}\n${html}`).not.toMatch(/handwrit|pages|RoznaComarker|Comarker/i);
  });

  test('every inserted value is escaped (HTML) and kept on one line (subject): no injection', () => {
    const { subject, text, html } = buildTeacherUploadSpeakingFeedbackEmail(input({ studentName: '<script>x</script>', assignmentTitle: 'Talk\r\nBcc: someone@example.com',
      teacherName: '"><img src=x>' }));
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(text).not.toContain('\r');
  });

  test('a missing or non-web link is refused (TEMPLATE_FAILURE), as for essays', () => {
    expect(() => buildTeacherUploadSpeakingFeedbackEmail(input({ link: 'javascript:alert(1)' }))).toThrow(expect.objectContaining({ code: 'TEMPLATE_FAILURE' }));
    expect(() => buildTeacherUploadSpeakingFeedbackEmail(input({ link: '' }))).toThrow(expect.objectContaining({ code: 'TEMPLATE_FAILURE' }));
  });

  test('only the given fields are used: anything else (a transcript, a score, a file name) never appears', () => {
    const { text, html } = buildTeacherUploadSpeakingFeedbackEmail({ ...input(), transcript: 'SECRET TRANSCRIPT', overallScore: 87, fileName: 'answer.wav' });
    expect(`${text}${html}`).not.toMatch(/SECRET TRANSCRIPT|87|answer\.wav/);
  });

  test('a guest (stage 10): the private link with its expiry and the "keep it private" note; no sign-in line', () => {
    const { text, html } = buildTeacherUploadSpeakingFeedbackEmail(input({ needsLogin: false, expiresAt: new Date('2026-12-16T00:00:00Z'),
      link: 'https://app.example.test/guest/speaking/s1#token' }));
    expect(text).toContain('Your teacher uploaded a recording for this assignment. It was marked like your own recording, and your feedback is ready.');
    expect(text).toContain('This private link opens your feedback without an account until 16 December 2026.');
    expect(text).toContain('Keep this link private');
    expect(text).not.toContain('Sign in to Rubrilo');
    expect(html).toContain('Keep this link private.');
  });

  test('a member\'s email is unchanged by the guest variant (no private-link note)', () => {
    const { text, html } = buildTeacherUploadSpeakingFeedbackEmail(input());
    expect(text).not.toContain('Keep this link private');
    expect(html).not.toContain('Keep this link private');
  });

  test('the essay email is unchanged', () => {
    const { text } = essay.buildTeacherUploadFeedbackEmail(input({ link: 'https://app.example.test/x' }));
    expect(text).toContain('uploaded your handwritten work for "Describe your town" and your feedback is ready.');
  });
});
