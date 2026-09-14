'use strict';
// Normal repository startup against an owned ephemeral test DB; never uses the .env database.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongoose').mongo;
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function runNpm(args, env) {
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: root, env, windowsHide: true })
    : spawn('npm', args, { cwd: root, env });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  let mongo, backend;
  try {
    mongo = await MongoMemoryServer.create({ instance: { dbName: 'assessment_release_runtime_test' } });
    const uri = mongo.getUri('assessment_release_runtime_test');
    const client = new MongoClient(uri);
    try {
      await client.connect();
      // Existing startup migration expects these collections to exist.
      await client.db().createCollection('flashcardsubmissions');
      await client.db().createCollection('flashcardsets');
    } finally { await client.close(); }
    const port = await freePort();
    const env = { ...process.env, NODE_ENV: 'development', MONGO_URI: uri, HOST: '127.0.0.1', PORT: String(port),
      RUNTIME_HEALTH_URL: `http://127.0.0.1:${port}/api/health` };
    backend = runNpm(['start'], env);
    let output = '', exited = false;
    const capture = chunk => { output = (output + String(chunk)).slice(-100000); };
    backend.stdout.on('data', capture); backend.stderr.on('data', capture);
    backend.on('exit', () => { exited = true; });
    backend.on('error', () => { exited = true; });
    let response;
    for (let attempt = 0; attempt < 90 && !exited; attempt++) {
      try {
        response = await fetch(env.RUNTIME_HEALTH_URL, { headers: { Origin: 'http://localhost:4200' }, signal: AbortSignal.timeout(1500) });
        if (response.ok) break;
      } catch { /* startup not listening yet */ }
      await pause(1000);
    }
    console.log(JSON.stringify({ isolatedTestDatabase: true, normalStartCommand: 'npm.cmd start',
      databaseConnected: output.includes('MongoDB connected'), healthResponds: !!response?.ok,
      frontendOriginAllowed: response?.headers.get('access-control-allow-origin') === 'http://localhost:4200',
      visionCredentialInitializationFailed: output.includes('Google Vision credentials file not found'),
      startupFailed: exited || output.includes('Startup failed') }));
    if (!response?.ok) throw Object.assign(new Error('Isolated startup failed'), { code: 'ISOLATED_STARTUP_FAILED' });
    const verifier = runNpm(['run', 'verify:runtime'], env);
    verifier.stdout.on('data', data => process.stdout.write(data));
    verifier.stderr.on('data', data => process.stderr.write(data));
    const exitCode = await new Promise(resolve => { verifier.on('error', () => resolve(1)); verifier.on('exit', resolve); });
    if (exitCode !== 0) throw Object.assign(new Error('Runtime contract failed'), { code: 'RUNTIME_CONTRACT_FAILED' });
  } finally {
    if (backend?.pid && backend.exitCode === null) {
      if (process.platform === 'win32') {
        const stopped = await new Promise(resolve => {
        const stop = spawn('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        stop.on('exit', code => resolve(code === 0)); stop.on('error', () => resolve(false));
      });
        if (!stopped) {
          console.error(JSON.stringify({ cleanupRequired: true, ownedBackendProcessId: backend.pid }));
          process.exitCode = 1;
          backend.stdout.destroy(); backend.stderr.destroy(); backend.unref();
        }
      }
      else backend.kill('SIGTERM');
    }
    if (mongo) await mongo.stop();
  }
}
main().catch(error => { console.error(JSON.stringify({ runtimeFailed: true, code: error.code || error.name })); process.exitCode = 1; });
