// Explicit local integration check. Never opens a camera or powers off a Pi.
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { root, ensurePort } from './runtime.mjs';

const target = resolve(process.argv[2] || root);
const name = process.argv[3] || 'current';
await ensurePort(3000, 'localhost'); await ensurePort(3001, '0.0.0.0');
const child = spawn(process.execPath, [resolve(target, 'scripts/start.mjs')], {
  cwd: target, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, AI_DEBUG: '0' },
});
let output = '';
const append = chunk => { output = (output + chunk.toString()).slice(-100000); };
child.stdout.on('data', append); child.stderr.on('data', append);
const completed = new Promise(yes => child.once('close', yes));
const request = (path, options = {}) => fetch('http://127.0.0.1:3001' + path, { ...options, signal: AbortSignal.timeout(15000) });
const until = async (condition, seconds = 120) => {
  const deadline = Date.now() + seconds * 1000;
  while (!await condition().catch(() => false)) {
    assert(child.exitCode === null, 'Launcher exited before readiness');
    assert(Date.now() < deadline, 'Launcher readiness timed out');
    await delay(300);
  }
};
let result;
try {
  await until(async () => (await (await request('/api/health')).json()).modelReady);
  assert.equal((await fetch('http://localhost:3000', { signal: AbortSignal.timeout(10000) })).status, 200);
  const health = await (await request('/api/health')).json();
  assert(health.capabilities.faces.includes('SCRFD-10G')); assert.equal(health.capabilities.behaviors, 6);
  const session = await (await request('/api/sessions', { method: 'POST' })).json();
  const jpeg = await readFile(resolve(target, 'backend/test-fixtures/portrait.jpg'));
  const detect = () => request('/api/sessions/' + session.sessionId + '/detect', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
  const responses = await Promise.all([detect(), detect()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  await Promise.all(responses.map(response => response.arrayBuffer()));
  let tracks = [];
  await until(async () => { tracks = (await (await detect()).json()).tracks; return tracks.some(track => track.observation?.facePresent && track.signals?.length === 6); }, 30);
  assert.equal((await request('/api/sessions/' + session.sessionId, { method: 'DELETE' })).status, 204);
  const event = (headers, value = 'camera_on') => request('/api/client/events', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ event: value, source: 'computer' }) });
  assert.equal((await event({})).status, 403);
  assert.equal((await event({ 'X-Client-Event': '1', Origin: 'http://untrusted.example' })).status, 403);
  assert.equal((await event({ 'X-Client-Event': '1' }, 'unknown')).status, 400);
  assert.equal((await event({ 'X-Client-Event': '1' })).status, 204);
  child.send('student-attention:stop');
  const stopTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 25000);
  const exitCode = await completed; clearTimeout(stopTimer);
  assert.equal(exitCode, 0);
  await ensurePort(3000, 'localhost'); await ensurePort(3001, '0.0.0.0');
  assert(output.includes('XUNG ĐỘT')); assert(output.includes('AI đã sẵn sàng'));
  assert(!output.includes('inference_feedback_manager.cc') && !output.includes('Traceback (most recent call last)'));
  result = { status: 'passed', checkedAt: new Date().toISOString(), target, ready: health.modelReady,
    realFaceAndSixSignals: true, conflict409: true, clientEventValidation: true, quietNativeLogs: true,
    shutdownExitCode: exitCode, portsReleased: [3000, 3001], piPoweroffRequested: false };
  console.log(JSON.stringify(result));
} catch (error) { result = { status: 'failed', error: error.message }; console.error(error.message); process.exitCode = 1; }
finally {
  if (child.exitCode === null) {
    if (child.connected) child.send('student-attention:stop', () => {});
    const timer = setTimeout(() => {
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGKILL');
    }, 26000);
    await completed; clearTimeout(timer);
  }
  await mkdir(resolve(root, '.qa'), { recursive: true });
  await writeFile(resolve(root, '.qa/launcher-' + name + '.log'), output);
  await writeFile(resolve(root, '.qa/launcher-' + name + '.json'), JSON.stringify(result, null, 2) + '\n');
}
