'use strict';
// The teacher dashboard's score rule, exactly as the frontend applies it (RoznaComarker src/app/services/teacher-dashboard-score.util.ts):
// GET /api/feedback/:submissionId per submission; a score counts only when evaluationStatus is 'completed' and overallScore is a finite
// number; the average is rounded to one decimal. Used to prove the assignment report gives the same average for the same data.
const request = require('supertest');

function completedFeedbackScore(feedback) {
  if (!feedback || typeof feedback !== 'object' || feedback.evaluationStatus !== 'completed') return null;
  const score = typeof feedback.overallScore === 'number' ? feedback.overallScore : Number.NaN;
  return Number.isFinite(score) ? score : null;
}

async function averageOfDashboard(app, bearer, submissionIds) {
  const scores = [];
  for (const submissionId of submissionIds) {
    const res = await request(app).get(`/api/feedback/${submissionId}`).set('Authorization', `Bearer ${bearer}`);
    if (res.status !== 200) throw new Error(`dashboard feedback read failed: ${res.status}`);
    const score = completedFeedbackScore(res.body.data);
    if (score !== null) scores.push(score);
  }
  if (!scores.length) return 0;
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
}

module.exports = { completedFeedbackScore, averageOfDashboard };
