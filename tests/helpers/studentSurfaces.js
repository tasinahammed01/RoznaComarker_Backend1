'use strict';
// Every student-facing HTTP surface that shows corrections or anything derived from them, for one registered and one guest submission.
// Shared by the golden test (no annotations: output must not change) and the no-leak matrix (hidden content must never appear).
const request = require('supertest');

function surfaces({ app, ids, studentJwt, guestToken }) {
  const asStudent = url => request(app).get(url).set('Authorization', `Bearer ${studentJwt}`);
  const asGuest = url => request(app).get(url).set('X-Guest-Token', guestToken);
  const r = String(ids.registered), g = String(ids.guest), a = String(ids.assignment);
  return {
    'registered: my submission for assignment': () => asStudent(`/api/submissions/assignment/${a}/my`),
    'registered: my submissions list': () => asStudent('/api/submissions/my'),
    'registered: ocr-corrections': () => asStudent(`/api/submissions/${r}/ocr-corrections`),
    'registered: feedback': () => asStudent(`/api/feedback/${r}`),
    'registered: draft comparison': () => asStudent(`/api/submissions/${r}/draft-comparison`),
    'guest: results': () => asGuest(`/api/guest/submissions/${g}/`),
    'guest: presentation': () => asGuest(`/api/guest/submissions/${g}/presentation`),
    'guest: ocr-corrections': () => asGuest(`/api/guest/submissions/${g}/ocr-corrections`),
    'guest: feedback': () => asGuest(`/api/guest/submissions/${g}/feedback`),
    'guest: drafts': () => asGuest(`/api/guest/submissions/${g}/drafts`),
  };
}

async function capture(list) {
  const out = {};
  for (const [name, call] of Object.entries(list)) {
    const res = await call();
    out[name] = { status: res.status, body: res.body };
  }
  return out;
}

module.exports = { surfaces, capture };
