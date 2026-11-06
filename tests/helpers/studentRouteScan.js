'use strict';
// Calls every GET route a student or guest can reach, as that student or guest, against the seeded fixtures, and keeps every 200 response.
// The route list is read from app.js and the route files (not typed here), so a new route is covered without being listed. A route only the
// teacher or an admin may call (requireRole with no student) is not reachable and is left out; everything else must be called at least once
// with a 200, or be listed in EXEMPT with the reason.
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const src = path.join(__dirname, '..', '..', 'src');
const read = file => fs.readFileSync(file, 'utf8');

/** [{ route, file, access }] for every router.get in every mounted route file. access: 'teacher/admin' | 'student' | 'any' (any signed-in user, or public). */
function routeInventory() {
  const appText = read(path.join(src, 'app.js'));
  const vars = Object.fromEntries([...appText.matchAll(/const (\w+) = require\(['"]\.\/routes\/([\w.\-/]+)['"]\)/g)].map(m => [m[1], m[2]]));
  const out = [];
  for (const mount of appText.matchAll(/app\.use\(\s*['"](\/[^'"]*)['"],\s*(?:require\(['"]\.\/routes\/([\w.\-/]+)['"]\)|(\w+))\s*\)/g)) {
    const file = mount[2] || vars[mount[3]];
    const full = file && path.join(src, 'routes', file.endsWith('.js') ? file : `${file}.js`);
    if (!full || !fs.existsSync(full)) continue;
    const text = read(full);
    const starts = [...text.matchAll(/router\.get\(\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"])/g)];
    for (const start of starts) {
      const rest = text.slice(start.index + 1), next = rest.search(/\nrouter\.|\nmodule\.exports/);
      const block = text.slice(start.index, next < 0 ? undefined : start.index + 1 + next);
      const roles = [...block.matchAll(/requireRole\(\s*(\[[^\]]*\]|['"][^'"]*['"])/g)].flatMap(m => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]));
      // router.use('/admin', requireRole('admin')) guards every /admin route of a file without being in its block.
      const adminOnly = /\/admin(\/|$)/.test(mount[1] + (start[2] || start[1] || ''));
      const access = adminOnly || (roles.length && roles.every(role => ['teacher', 'admin'].includes(role))) ? 'teacher/admin' : roles.includes('student') ? 'student' : 'any';
      for (const p of start[1] ? [...start[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : [start[2]]) out.push({ route: mount[1] + (p === '/' ? '' : p), file: path.basename(full), access });
    }
  }
  const seen = new Set();
  return out.filter(item => !seen.has(item.route) && seen.add(item.route));
}

/** Routes that answer with something other than JSON, or a stream: not scannable as text, and the reason. */
const EXEMPT = [
  [/\/pdf|download/i, 'a PDF or file stream; its text is checked in annotationNoLeak.test.js'],
  [/media|\/uploads|\/files/i, 'binary media'],
  [/\/stream|\/sse/i, 'a live stream (SSE); its payload is built by notificationForStudent, tested below'],
  [/docs|swagger/i, 'API documentation'],
  [/jwt-test/i, 'development only'],
];
const exemption = route => EXEMPT.find(([pattern]) => pattern.test(route))?.[1] ?? null;

/** Where each route parameter points in the fixtures. An ambiguous `:id` is tried against every candidate. */
function candidates(f, r) {
  const ids = [f.IDS.class, f.IDS.assignment, f.IDS.registered, r.worksheet._id, r.flashcards._id, r.worksheetAssignment._id, r.flashcardAssignment._id, r.session._id, f.student._id];
  return ids.map(String);
}
function fill(route, candidate, f, r, guest = false) {
  return route.replace(/:(\w+)/g, (_, name) => {
    const n = name.toLowerCase();
    if (n === 'joincode') return 'FIXTURE-1';
    if (n === 'sharetoken') return r.shareToken;
    if (n === 'qrtoken') return 'fixture-qr';
    if (n === 'firebaseuid') return f.student.firebaseUid;
    if (n === 'sessionid') return String((guest ? r.guestSession : r.session)._id);
    if (n === 'filename') return 'x.png';
    return candidate;
  });
}
function queries(route, f, r) {
  if (!/draft|my-submission|progress|attempts/.test(route)) return [''];
  return ['', `?assignmentId=${r.worksheetAssignment._id}`, `?assignmentId=${r.flashcardAssignment._id}`, '?activityId=activity-1&questionId=q1'];
}

/**
 * Every 200 response for every reachable route. Returns { responses: [{ who, route, url, body }], inventory: [{ ...route, covered, exempt }] }.
 * A guest is also called on the /guest/ routes, with the guest's own link token.
 */
async function scan({ app, f, r, studentJwt, portalSession }) {
  const inventory = routeInventory().map(item => ({ ...item, covered: false, exempt: exemption(item.route) }));
  const responses = [];
  for (const item of inventory) {
    if (item.access === 'teacher/admin' || item.exempt) continue;
    const guestRoute = item.route.includes('/guest/') && !item.route.includes('/guest/status') && !item.route.includes('/guest/assignments');
    const record = (who, url, res) => {
      if (res.status !== 200 || !res.body || typeof res.body !== 'object' || !Object.keys(res.body).length) return;
      item.covered = true;
      responses.push({ who, route: item.route, url, body: res.body });
    };
    // A guest has one submission and one link token: one call per route, as the guest. Everything else is called as the student.
    if (guestRoute) {
      const url = fill(item.route, String(f.IDS.guest), f, r, true) + (/attempts/.test(item.route) ? '?activityId=activity-1&questionId=q1' : '');
      record('guest', url, await request(app).get(url).set('X-Guest-Token', f.guestToken));
      // The same page through the recovery portal's session.
      if (portalSession) record('portal', url, await request(app).get(url).set('X-Recovery-Session', portalSession));
      continue;
    }
    if (item.route.startsWith('/api/recovery/') && portalSession) {
      record('portal', item.route, await request(app).get(item.route).set('X-Recovery-Session', portalSession));
      continue;
    }
    const urls = new Set();
    for (const candidate of candidates(f, r)) for (const query of queries(item.route, f, r)) urls.add(fill(item.route, candidate, f, r) + query);
    for (const url of urls) {
      record('student', url, await request(app).get(url).set('Authorization', `Bearer ${studentJwt}`));
      if (item.access === 'any' && /shared|status|plans|join|legend|health/.test(item.route)) record('public', url, await request(app).get(url));
    }
  }
  return { responses, inventory };
}

/** Every key name in a JSON value, with its path. */
function keysOf(value, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysOf(v, `${at}[]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push({ key: k, at: `${at}.${k}` }); keysOf(v, `${at}.${k}`, out); }
  return out;
}

module.exports = { routeInventory, scan, keysOf, exemption, EXEMPT };
