import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { root, exists, checkNode, ensurePort, run } from './runtime.mjs';

const children = new Set();
let stopping = false;
let initialized = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  console.log('HỆ THỐNG: Đang đóng web/backend và tiến trình con. Không gửi lệnh tắt Raspberry Pi.');
  await Promise.all([...children].map(child => new Promise(done => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => {
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else if (child.phaseGroup) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else child.kill('SIGKILL');
    }, 20000);
    child.once('close', () => { clearTimeout(timer); done(); });
    if (child.connected) child.send('student-attention:stop', () => {});
    else if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else if (child.phaseGroup) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    else child.kill('SIGTERM');
  })));
  if (process.connected) process.disconnect();
}
function launch(name, args, cwd, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ...extra } });
  children.add(child);
  child.once('error', error => { console.error('KHỞI ĐỘNG: ' + error.message); void stop(1); });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (initialized && !stopping) {
      console.error(`HỆ THỐNG: ${name} đã thoát ngoài yêu cầu dừng (mã ${code ?? 'không có'}, tín hiệu ${signal ?? 'không có'}). Xem lỗi ngay phía trên.`);
      void stop(code || 1);
    }
  });
  return child;
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('message', message => { if (message === 'student-attention:stop') void stop(); });
process.on('disconnect', () => { void stop(); });
const phaseOptions = { detached: process.platform !== 'win32', onChild: child => {
  child.phaseGroup = process.platform !== 'win32';
  children.add(child); child.once('exit', () => children.delete(child));
} };
try {
  checkNode();
  for (const path of ['backend/node_modules/typescript/bin/tsc', 'frontend/node_modules/vite/dist/node/index.js',
    'backend/.venv', 'backend/models/classroom/installation.json']) if (!await exists(resolve(root, path))) throw new Error('Chưa cài môi trường. Chạy npm run requirement trước.');
  let config = {};
  try { config = parseEnv(await readFile(resolve(root, 'backend/.env'), 'utf8')); } catch {}
  const port = Number(process.env.PORT || config.PORT || 3001);
  const host = process.env.HOST || config.HOST || '0.0.0.0';
  await ensurePort(port, host);
  await ensurePort(3000, 'localhost');
  console.log('HỆ THỐNG: Kiểm tra mô hình và build backend; web/backend sẽ chạy trong cùng terminal.');
  await run(process.execPath, [resolve(root, 'backend/scripts/setup-ai.mjs')], phaseOptions);
  if (!stopping) await run(process.execPath, [resolve(root, 'scripts/build.mjs'), 'backend'], phaseOptions);
  if (!stopping) {
    initialized = true;
    launch('Backend', ['--env-file-if-exists=.env', 'dist/index.js'], resolve(root, 'backend'));
    const address = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host.includes(':') ? '[' + host + ']' : host;
    launch('Frontend', [resolve(root, 'scripts/web.mjs')], resolve(root, 'frontend'), { BACKEND_URL: 'http://' + address + ':' + port });
    console.log('HỆ THỐNG: Nhấn Ctrl+C một lần để dừng cả frontend và backend.');
  }
} catch (error) { if (!stopping) { console.error('KHỞI ĐỘNG: ' + error.message); await stop(1); } }
