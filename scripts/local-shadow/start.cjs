'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { root, home, applyEnvironment, assertIsolation, localDirectory } = require('./config.cjs');
const network = require('./network.cjs');
let mongo, server, frontend, mongoose, realHandle, locked = false, closing = false;
const lock = path.join(home, 'session.lock');
const smoke = process.argv.includes('--smoke');
const verify = process.argv.includes('--verify');
const realOne = process.argv.includes('--real-one');
const realPreflight = process.argv.includes('--preflight-real-one');
const astraVerified=process.argv.includes('--astra-verified');
const astraPreflight=process.argv.includes('--preflight-astra-verified');
async function stop(code = 0) {
  if (closing) return; closing = true;
  realHandle?.stop();
  if (frontend) frontend.kill();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  if (mongoose) await mongoose.disconnect();
  if (mongo) await mongo.stop({ doCleanup: false, force: false });
  if (locked) fs.unlinkSync(lock);
  console.log('Local shadow stopped; data retained. External provider transport attempts:', network.counts.providerRequests, '; verifier requests: 0.');
  process.exitCode = code;
}
async function freePort(port) {
  const net = require('net');
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('LOCAL_PORT_OCCUPIED_' + port))); s.listen(port, '127.0.0.1', () => s.close(resolve)); });
}
async function main() {
  if((astraVerified||astraPreflight)&&(realOne||realPreflight||smoke||verify))throw Error('LOCAL_MODES_MUST_NOT_BE_COMBINED');
  const astra=(astraVerified||astraPreflight)?require('./astra-verified.cjs').inspect():null;
  const env = applyEnvironment(astra?.env); assertIsolation(process.env);
  if(astraPreflight){console.log(JSON.stringify(astra.summary));return;}
  process.chdir(root);
  localDirectory(home);
  let real;
  if (realOne || realPreflight) {
    localDirectory(path.join(home, 'private'));
    real = require('./real-one.cjs').inspect();
    const summary = require('./real-one.cjs').summary(real);
    if (realPreflight) { console.log(JSON.stringify(summary)); return; }
    if (smoke || verify || real.missing.length) { console.log(JSON.stringify(summary)); throw Error('REAL_ONE_PREFLIGHT_INCOMPLETE'); }
  }
  network.install(astraVerified?{astraVerified:true}:realOne ? { realOne: true, ledger: real.ledger, imageHash: real.image.sha256 } : {});
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error('LOCAL_SHADOW_ALREADY_RUNNING'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locked = true;
  for (const port of [5001, 27028, ...(smoke ? [] : [4200])]) await freePort(port);
  for (const dir of ['db', 'uploads', 'private']) localDirectory(path.join(home, dir));
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  mongo = await MongoMemoryReplSet.create({ binary: { checkMD5: false },
    instanceOpts: [{ port: 27028, ip: '127.0.0.1', dbPath: path.join(home, 'db') }],
    replSet: { count: 1, name: 'localShadow', storageEngine: 'wiredTiger', ip: '127.0.0.1' } });
  const actualMongo = new URL(mongo.getUri('rozna_shadow_local'));
  if (actualMongo.host !== '127.0.0.1:27028' || actualMongo.pathname !== '/rozna_shadow_local') {
    throw Error('LOCAL_MONGO_LISTENER_IDENTITY_CHANGED');
  }
  mongoose = require('mongoose');
  await mongoose.connect(env.MONGO_URI);
  const Plan = require('../../src/models/Plan');
  const User = require('../../src/models/user.model');
  const Class = require('../../src/models/class.model');
  const Assignment = require('../../src/models/assignment.model');
  const plan = await Plan.findOneAndUpdate({ slug: 'free' }, { $setOnInsert: { name: 'Free', price: 0,
    durationDays: 30, billingInterval: 'month', billingType: 'monthly', isActive: true,
    features: { maxClasses: 5, maxStudents: 50, essayAnalysesPerMonth: 100, storageMB: 500 },
    limits: { classes: 5, assignments: 20, students: 50, submissions: 100, storageMB: 500 } } }, { upsert: true, new: true });
  const teacher = await User.findOneAndUpdate({ firebaseUid: 'local-shadow-synthetic-teacher' },
    { $setOnInsert: { email: 'teacher@local-shadow.invalid', role: 'teacher', displayName: 'Local shadow teacher', plan: plan._id } }, { upsert: true, new: true });
  const classroom = await Class.findOneAndUpdate({ joinCode: 'LOCAL-SHADOW-ONLY' },
    { $setOnInsert: { name: 'Local shadow writing', teacher: teacher._id, isActive: true } }, { upsert: true, new: true });
  let student=null;
  if(astraVerified){
    student=await User.findOneAndUpdate({firebaseUid:'local-shadow-synthetic-student'},{$setOnInsert:{email:'student@local-shadow.invalid',
      role:'student',displayName:'Local shadow student'}},{upsert:true,new:true});
    await require('../../src/models/membership.model').findOneAndUpdate({student:student._id,class:classroom._id},
      {$set:{status:'active'}},{upsert:true});
  }
  let assignment = await Assignment.findOne({ teacher: teacher._id, title: 'Local shadow handwritten exercise' });
  if (!assignment) assignment = await Assignment.create({ title: 'Local shadow handwritten exercise', teacher: teacher._id,
    class: classroom._id, instructions: 'Local test only. Do not submit until real provider traffic is separately authorized.',
    isActive: true, allowGuestSubmission: true, qrToken: crypto.randomBytes(24).toString('hex') });
  const hook = require('../../src/services/correctionShadow/stagingHook');
  hook.configureStagingAdapters(null);
  if (realOne) realHandle = require('./real-one.cjs').install(real);
  if (astraVerified) realHandle = require('./astra-verified.cjs').install();
  const credit = await require('../../src/services/assessmentCreditRouter.service').canRunAssessment({
    teacherUserId: teacher._id, assignmentId: assignment._id, user: teacher });
  if (!credit.allowed) throw Error('LOCAL_TEACHER_CREDIT_POLICY_BLOCKED');
  // Reuse the normal app and dispatch, without server.js's unrelated worker startup/AI health validation.
  const app = require('../../src/app');
  await require('../../src/models/Submission').init();
  server = await new Promise((resolve, reject) => {
    const s = require('http').createServer((req, res) => {
      if (realOne) {
        if (req.method === 'POST') {
          const expected = '/api/guest/assignments/' + assignment.qrToken + '/submit';
          if (req.url !== expected || real.ledger.spent('upload')) { res.writeHead(409); return res.end('Local one-upload budget blocks this request.'); }
          real.ledger.event('UPLOAD_ACCEPTED');
          res.once('finish', () => real.ledger.event('HTTP_RESPONSE_FINISHED', { httpStatus: res.statusCode }));
        } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /\/pdf(?:\?|$)|\/practice|\/drafts/.test(req.url)) {
          res.writeHead(403); return res.end('Local experiment route disabled.');
        }
      }
      app(req, res);
    });
    s.once('error', reject); s.listen(5001, '127.0.0.1', () => resolve(s));
  });
  const endpoint = 'http://127.0.0.1:5001/api/guest/assignments/' + assignment.qrToken;
  const response = await fetch(endpoint, { headers: { Origin: 'http://localhost:4200' } });
  if (!response.ok || response.headers.get('access-control-allow-origin') !== 'http://localhost:4200') throw Error('LOCAL_GUEST_ENTRY_CHECK_FAILED');
  const entry = await response.json(); if (!entry.data?.allowGuestSubmission) throw Error('LOCAL_ASSIGNMENT_DISABLED');
  const state = { frontendUrl: 'http://localhost:4200', backendUrl: 'http://127.0.0.1:5001',
    assignmentUrl: 'http://localhost:4200/student/assignments/qr/' + assignment.qrToken,
    database: 'rozna_shadow_local', databasePath: path.join(home, 'db'), uploads: path.join(home, 'uploads'),
    teacherId: String(teacher._id), classId: String(classroom._id), assignmentId: String(assignment._id),
    guestEntryStatus: response.status, generator: realOne ? 'EXPLICIT_REAL_ONE_V15' : 'GENERATOR_NOT_CONFIGURED', mode: 'shadow_v15',
    ocrSourceMode:env.OCR_SOURCE_MODE,
    ...(student?{studentToken:require('../../src/utils/jwt').signJwt(student),
      studentAssignmentUrl:'http://localhost:4200/student/my-classes/detail/'+classroom._id,
      studentResultUrl:'http://localhost:4200/student/my-classes/detail/my-submissions/'+assignment._id+'?classId='+classroom._id}:{}),
    providerCalls: 0, verifierCalls: 0, uploadSubmitted: false, frontendStarted: !smoke,
    creditPolicyAllowed: credit.allowed, backgroundWorkersStarted: false };
  fs.writeFileSync(path.join(home, 'private', 'session.json'), JSON.stringify(state, null, 2));
  console.log('Isolated local backend ready on http://127.0.0.1:5001; guest entry verified.');
  console.log('Private assignment URL: backend/.local-shadow/private/session.json');
  if (smoke) return stop();
  const frontRoot = path.resolve(root, '../RoznaComarker');
  frontend = cp.spawn(process.execPath, [path.join(frontRoot, 'node_modules/@angular/cli/bin/ng.js'), 'serve',
    '--configuration', 'local-shadow', '--host', '127.0.0.1', '--port', '4200'], {
      cwd: frontRoot, env: { ...process.env }, stdio: 'inherit', windowsHide: true });
  frontend.once('exit', () => { if (!closing) stop(1); });
  frontend.once('error', () => stop(1));
  if (verify) {
    const deadline = Date.now() + 180000; let ready = false;
    while (Date.now() < deadline) {
      try { if ((await fetch('http://127.0.0.1:4200')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error('LOCAL_FRONTEND_START_TIMEOUT');
    const puppeteer = require('puppeteer');
    const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    const browser = await puppeteer.launch({ headless: true, pipe: true, timeout: 60000,
      ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-sandbox'] });
    try {
      const page = await browser.newPage(); await page.setRequestInterception(true);
      let apiReached = false;
      page.on('request', request => {
        const u = new URL(request.url());
        if (!network.permitted(u.hostname)) return request.abort();
        return request.continue();
      });
      page.on('response', res => { if (res.url() === endpoint && res.status() === 200) apiReached = true; });
      await page.goto(state.assignmentUrl, { waitUntil: 'networkidle0', timeout: 60000 });
      await page.waitForFunction(() => document.body.innerText.includes('Submit your work'), { timeout: 30000 });
      const form = await page.evaluate(() => ({ filePicker: !!document.querySelector('input[type=file]'),
        email: !!document.querySelector('input[type=email]'), submit: [...document.querySelectorAll('button')].some(b => b.textContent.includes('Submit Assignment')) }));
      if (!apiReached || !form.filePicker || !form.email || !form.submit) throw Error('LOCAL_BROWSER_FORM_CHECK_FAILED');
      Object.assign(state, { browserVerified: true, browserReachedBackend: true, form });
      fs.writeFileSync(path.join(home, 'private', 'session.json'), JSON.stringify(state, null, 2));
      console.log('Browser verified normal guest upload form and local backend; no file selected/submitted.');
    } finally { await browser.close(); }
    await stop();
  }
}
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
main().catch(async e => { const safe = /^[A-Z0-9_]+$/.test(e.message || '') ? e.message : 'LOCAL_STARTUP_FAILED'; console.error('Local shadow startup failed:', safe); await stop(1); });
