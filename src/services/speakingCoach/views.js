'use strict';
// Speaking Coach DTOs, built field by field (never a stored document minus a denylist).
// - Student and guest (D4): task wording and progress, the attempt state, the short feedback, the target words used, the fluency change in
//   words. Never a level title or percent, a pass flag, the pass rule, a score, provider, model, prompt, hashes, ids of recordings or teachers.
//   Task statuses are current / done / locked; an attempt says what comes next (next_task, try_again, finished, practice_ended).
// - Teacher: the same plus the level reached, pass or not, the pass rule in words (D3), the original level and the answer text.

const STUDENT_TASK_STATUS = Object.freeze({ active: 'current', passed: 'done', locked: 'locked' });
const PROCESSING = new Set(['transcribing', 'assessing']);
const iso = value => (value ? new Date(value).toISOString() : null);
const studentState = status => (PROCESSING.has(status) ? 'processing' : status);

function studentTask(task) {
  return { taskId: task.taskId, order: task.order, type: task.type, area: task.areaLabel, prompt: task.prompt, tip: task.tip, targets: [...(task.targets || [])],
    maxSeconds: task.maxSeconds, status: STUDENT_TASK_STATUS[task.status] || 'locked', attemptCount: task.attemptCount || 0 };
}

/** What comes after this attempt, for the student (no pass flag): next_task, finished, try_again or practice_ended. */
function nextStepOf(attempt, session, isLatest) {
  if (PROCESSING.has(attempt.status)) return null;
  if (attempt.status === 'ready' && attempt.result?.passed) return isLatest && session.status === 'completed' ? 'finished' : 'next_task';
  return isLatest && session.status === 'capped' ? 'practice_ended' : 'try_again';
}

/** One attempt for its student or guest. latestId: the session's latest attempt (only it can be retried). */
function studentAttempt(attempt, session, latestId) {
  if (!attempt) return null;
  const isLatest = String(attempt._id) === String(latestId);
  const ready = attempt.status === 'ready';
  const out = { id: String(attempt._id), taskId: attempt.taskId, attemptNumber: attempt.attemptNumber, state: studentState(attempt.status),
    nextStep: nextStepOf(attempt, session, isLatest), createdAt: iso(attempt.createdAt) };
  if (ready) {
    out.feedback = { improved: [...(attempt.result?.feedback?.improved || [])], stillWeak: [...(attempt.result?.feedback?.stillWeak || [])],
      nextTip: attempt.result?.feedback?.nextTip || '' };
    if (attempt.result?.vocab) out.vocab = { used: [...(attempt.result.vocab.used || [])], missing: [...(attempt.result.vocab.missing || [])] };
    if (attempt.result?.fluencyChange) {
      const change = attempt.result.fluencyChange;
      out.fluencyChange = { fewerLongPauses: Boolean(change.fewerLongPauses), fewerFillers: Boolean(change.fewerFillers), shorterLongestPause: Boolean(change.shorterLongestPause) };
    }
  }
  if (attempt.status === 'not_assessable') out.reason = attempt.notAssessableReason || 'not_enough_speech';
  if (attempt.status === 'failed') {
    out.failure = attempt.errorCode === 'COACH_TRANSCRIPTION_FAILED' ? 'transcription' : 'check';
    out.canRetry = out.failure === 'check' && isLatest && session.status === 'ready' && !session.activeAttemptId && session.currentTaskId === attempt.taskId;
  }
  return out;
}

/** The session for its student or guest. attempts: the session's attempts (any order). */
function studentSession(session, attempts = []) {
  if (!session) return null;
  const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  const latest = sorted[sorted.length - 1] || null;
  const active = session.activeAttemptId ? sorted.find(item => String(item._id) === String(session.activeAttemptId)) : null;
  return { id: String(session._id), currentTaskId: session.currentTaskId || null, attemptsUsed: session.attemptsUsed || 0,
    attemptsLeft: Math.max(0, (session.settings?.attemptCap || 0) - (session.attemptsUsed || 0)), endedReason: session.endedReason || null,
    tasks: [...(session.tasks || [])].sort((a, b) => a.order - b.order).map(studentTask),
    activeAttempt: studentAttempt(active, session, latest?._id), lastAttempt: studentAttempt(latest, session, latest?._id) };
}

/** The pass rule in words, for the teacher card (D3). */
function passRuleText(passRule, passPercent) {
  const percent = value => `${Math.round(Number(value) * 100) / 100}%`;
  if (passRule?.rule === 'second_highest') {
    return `No level of this criterion falls between ${percent(passPercent)} and 100%, so the second-highest level (${percent(passRule.minimumPercent)}) and above passes.`;
  }
  if (passRule?.rule === 'top_only') return 'This criterion has only two levels, so only the top level passes.';
  return `Passes at ${percent(passPercent)} or above.`;
}

const TEACHER_STATE = Object.freeze({ generating: 'generating', ready: 'in-progress', completed: 'completed', capped: 'capped', failed: 'failed' });

/** The teacher's progress card. attempts: the session's attempts with status, taskId, result.levelTitle, result.passed, createdAt. */
function teacherProgress({ submissionId, session, attempts = [], sourceStatus = 'current' }) {
  if (!session) {
    return { state: 'not-started', sourceStatus: 'current', submissionId: String(submissionId), sessionId: null, settings: null,
      summary: { totalTasks: 0, passedTasks: 0, attemptsUsed: 0, attemptCap: null, lastPracticedAt: null }, tasks: [] };
  }
  const passPercent = session.settings?.passPercent;
  const original = new Map((session.sourceSnapshot?.criteria || []).map(c => [c.criterionId, c.levelTitle || null]));
  const tasks = [...(session.tasks || [])].sort((a, b) => a.order - b.order).map(task => {
    const own = attempts.filter(item => item.taskId === task.taskId).sort((a, b) => a.attemptNumber - b.attemptNumber);
    const checked = own.filter(item => item.status === 'ready');
    const latest = checked[checked.length - 1] || null;
    return { taskId: task.taskId, order: task.order, type: task.type, area: task.areaLabel, prompt: task.prompt, status: task.status, attemptCount: task.attemptCount || 0,
      originalLevel: original.get(task.criterionId) || null, latestLevel: latest?.result?.levelTitle || null, passed: task.status === 'passed',
      passRule: task.passRule ? { rule: task.passRule.rule, minimumPercent: task.passRule.minimumPercent } : null, passRuleText: passRuleText(task.passRule, passPercent),
      lastAttemptAt: iso(own[own.length - 1]?.createdAt) };
  });
  const last = [...attempts].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).pop();
  return { state: TEACHER_STATE[session.status] || 'failed', sourceStatus, submissionId: String(submissionId), sessionId: String(session._id),
    settings: { passPercent, attemptCap: session.settings?.attemptCap },
    summary: { totalTasks: tasks.length, passedTasks: tasks.filter(t => t.passed).length, attemptsUsed: session.attemptsUsed || 0,
      attemptCap: session.settings?.attemptCap, lastPracticedAt: iso(last?.createdAt) }, tasks };
}

/** One attempt in the teacher's history. answerText: the attempt's assessed text (from its recording). */
function teacherAttempt(attempt, answerText) {
  return { id: String(attempt._id), attemptNumber: attempt.attemptNumber, state: studentState(attempt.status), levelTitle: attempt.result?.levelTitle || null,
    passed: attempt.status === 'ready' ? Boolean(attempt.result?.passed) : null, onTask: attempt.status === 'ready' ? Boolean(attempt.result?.onTask) : null,
    notAssessableReason: attempt.notAssessableReason || null, failure: attempt.status === 'failed' ? (attempt.errorCode === 'COACH_TRANSCRIPTION_FAILED' ? 'transcription' : 'check') : null,
    feedback: attempt.status === 'ready' ? { improved: [...(attempt.result?.feedback?.improved || [])], stillWeak: [...(attempt.result?.feedback?.stillWeak || [])],
      nextTip: attempt.result?.feedback?.nextTip || '' } : null,
    vocab: attempt.result?.vocab ? { used: [...(attempt.result.vocab.used || [])], missing: [...(attempt.result.vocab.missing || [])] } : null,
    fluencyChange: attempt.result?.fluencyChange || null, answerText: answerText || '', attemptedAt: iso(attempt.createdAt) };
}

module.exports = { studentSession, studentAttempt, studentTask, teacherProgress, teacherAttempt, passRuleText, nextStepOf };
