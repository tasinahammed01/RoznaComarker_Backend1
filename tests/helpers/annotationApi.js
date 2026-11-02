'use strict';
// Teacher annotation API calls for the Task 6A tests.
const crypto = require('crypto');
const request = require('supertest');
const { signTestJwt } = require('./auth');

function annotationApi(app, user) {
  const jwt = signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
  const base = id => `/api/submissions/${id}/teacher-annotations`;
  const auth = r => r.set('Authorization', `Bearer ${jwt}`);
  const api = {
    snapshot: id => auth(request(app).get(base(id))),
    history: (id, query = '') => auth(request(app).get(`${base(id)}/history${query}`)),
    preview: id => auth(request(app).get(`${base(id)}/preview`)),
    post: (id, body) => auth(request(app).post(base(id))).send(body),
    scoreReview: (id, body) => auth(request(app).post(`${base(id)}/score-review`)).send(body),
    /** Reads the current revision and source, then applies one action. Returns the response. */
    async act(id, body) {
      const snap = await api.snapshot(id);
      if (snap.status !== 200) return snap;
      return api.post(id, { revision: snap.body.data.revision, sourceHash: snap.body.data.sourceHash, requestId: crypto.randomUUID(), ...body });
    },
    /** The correction currently stored for a quoted word (any status), from the teacher snapshot. */
    async find(id, quotedText, symbol) {
      const snap = await api.snapshot(id);
      return (snap.body.data?.corrections || []).find(c => c.quotedText === quotedText && (!symbol || c.symbol === symbol));
    },
  };
  return api;
}

/** A manual-entry value covering one word of the canonical transcript. */
function manualValue(submission, quotedText, { symbol = 'ART', category = 'GRAMMAR', message = 'Teacher manual note.', suggestedText = 'the park', occurrence = 0 } = {}) {
  const page = submission.ocrPages[0];
  const text = submission.transcriptText;
  // Whole-word occurrences only (the fixture transcript is single-space separated).
  const starts = [];
  for (let at = 0, i = 0, words = text.split(' '); i < words.length; at += words[i].length + 1, i++) if (words[i] === quotedText) starts.push(at);
  const start = starts[occurrence];
  return { fileId: String(page.fileId), page: 1, startChar: start, endChar: start + quotedText.length, quotedText, symbol, category, message, suggestedText };
}

module.exports = { annotationApi, manualValue };
