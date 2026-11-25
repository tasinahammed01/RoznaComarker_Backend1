'use strict';
// Speaking Coach: the task documents of a session. The type, area, targets and pass rule are decided in code (areas.planTasks); the prompt and
// tip are the AI wording when it passed the checks, otherwise these templates (plain English that passes the student text check), so a
// session never fails for want of wording. The assignment title is the teacher's text, shortened.
const title = value => String(value || 'your task').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'your task';
const AREA_TIPS = Object.freeze({
  'speaking-grammar': 'Speak a little more slowly and think about each verb as you say it.',
  'speaking-organisation': 'Start with your main idea, give a reason or an example, then finish with a short ending.',
  'speaking-task': 'Add one more example or reason and explain why it matters.'
});

/** { prompt, tip } for a task without AI wording. */
function templateText({ type, areaLabel, criterionId, assignmentTitle, targets = [] }) {
  const topic = title(assignmentTitle);
  const area = String(areaLabel || 'this area').trim().toLowerCase();
  switch (type) {
    case 'follow_up':
      return { prompt: `Here is a follow-up question about "${topic}": what is one more example or reason you could give? Explain it in a few sentences.`,
        tip: 'Say your example first, then explain why it fits.' };
    case 'fluency_drill':
      return { prompt: `Talk for about one minute about "${topic}". Try to keep going without long stops.`,
        tip: 'If you need time to think, slow down instead of stopping, and try not to say um or uh.' };
    case 'vocab_swap':
      return { prompt: `Answer "${topic}" again and use these words: ${targets.join(', ')}.`,
        tip: 'Plan where each word fits before you start speaking.' };
    default:
      return { prompt: `Answer "${topic}" again. This time, focus on your ${area}.`,
        tip: AREA_TIPS[criterionId] || 'Think about what you want to say before you start, then speak in full sentences.' };
  }
}

/** Task documents t1..tN: the first one active, the others locked. texts: { taskId: { prompt, tip } } (checked AI wording), optional. */
function buildTasks(plan, { assignmentTitle, maxSeconds, texts = {} }) {
  return plan.map((item, index) => {
    const taskId = `t${index + 1}`;
    const words = texts[taskId] || templateText({ ...item, assignmentTitle });
    return { taskId, order: index + 1, type: item.type, criterionId: item.criterionId, areaLabel: item.areaLabel, prompt: words.prompt, tip: words.tip,
      targets: item.targets || [], maxSeconds, status: index === 0 ? 'active' : 'locked', attemptCount: 0, passedAt: null, passRule: item.passRule };
  });
}

module.exports = { templateText, buildTasks };
