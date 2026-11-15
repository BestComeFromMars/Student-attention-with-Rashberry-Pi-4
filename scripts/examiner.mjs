import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, access, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.qa/examiner');
const npm = process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const withAI = process.argv.includes('--ai');
const results = [];
let active;
let cancelled = false;
const startedAt = new Date();
const killActive = () => {
  if (!active?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(active.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-active.pid, 'SIGTERM'); } catch { active.kill('SIGTERM'); } }
};
const cancel = () => { cancelled = true; killActive(); };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
await mkdir(output, { recursive: true });
for (const name of ['desktop.png', 'mobile.png', 'failure.png', 'system.json']) {
  await unlink(resolve(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function run(name, args, cwd = root, timeoutMs = 120000) {
  if (cancelled) { results.push({ name, status: 'skipped', reason: 'User cancelled' }); return; }
  const log = String(results.length + 1).padStart(2, '0') + '.log';
  const start = performance.now();
  let timedOut = false;
  let contents = '';
  console.log('CHECK ' + name);
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    const timer = setTimeout(() => { timedOut = true; killActive(); }, timeoutMs);
    const append = chunk => { contents += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { contents += '\n' + error.stack; });
    child.on('close', code => { clearTimeout(timer); active = undefined; resolveResult(code); });
  });
  await writeFile(resolve(output, log), contents);
  const item = { name, status: result === 0 && !timedOut ? 'passed' : 'failed',
    durationMs: Math.round(performance.now() - start), exitCode: result, log,
    ...(timedOut ? { reason: 'Exceeded ' + timeoutMs / 1000 + ' seconds; owned test processes terminated' } : {}) };
  const match = contents.match(/Tests\s+(\d+) passed/);
  if (match) item.testsPassed = Number(match[1]);
  results.push(item);
  console.log(item.status.toUpperCase() + ' ' + name + ' (' + (item.durationMs / 1000).toFixed(1) + 's)');
  if (item.status === 'failed') console.log(contents.slice(-2400));
}
const npmRun = (name, folder, script, timeout) => run(name, [npm, '--prefix', folder, 'run', script], root, timeout);
try {
  await npmRun('Frontend TypeScript', 'frontend', 'typecheck');
  await npmRun('Backend TypeScript', 'backend', 'typecheck');
  await npmRun('Frontend regression tests', 'frontend', 'test');
  await run('Backend regression tests', [resolve(root, 'backend/node_modules/vitest/vitest.mjs'), 'run'], resolve(root, 'backend'));
  await npmRun('Raspberry Pi agent tests', 'Raspberry_pi_4', 'test');
  await npmRun('Frontend production build', 'frontend', 'build');
  await npmRun('Backend production build', 'backend', 'build');
  await npmRun('Vite health and reconnect scenarios', 'frontend', 'test:startup');
  await npmRun('Chrome camera lifecycle and development reload', 'frontend', 'test:camera');
  const backendBuild = results.find(item => item.name === 'Backend production build');
  if (backendBuild?.status === 'passed') {
    await npmRun('HTTP and browser system examiner', 'frontend', 'test:system');
    try { results.at(-1).scenarios = JSON.parse(await readFile(resolve(output, 'system.json'), 'utf8')).checks; } catch {}
  }
  else results.push({ name: 'HTTP and browser system examiner', status: 'skipped', reason: 'Backend build failed; avoid testing stale compiled code' });
  if (withAI) {
    await run('Python native AI regression tests', [resolve(root, 'backend/scripts/test-ai.mjs')], resolve(root, 'backend'), 180000);
    if (backendBuild?.status === 'passed') await run('Real model smoke test, synthetic images', [resolve(root, 'backend/scripts/verify-model.mjs')], resolve(root, 'backend'), 240000);
  } else results.push({ name: 'Native AI model smoke test', status: 'skipped', reason: 'Use npm run examine -- --ai for native Python tests and real local models. Requires available memory; never opens webcam.' });

  if (!cancelled) {
    const start = performance.now();
    try {
      const liveURL = process.env.EXAMINER_BACKEND_URL || 'http://127.0.0.1:3001';
      const response = await fetch(liveURL.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      const status = response.ok && data.status === 'ok' && data.modelReady && data.detector === 'classroom' ? 'passed' : 'failed';
      results.push({ name: 'Existing backend health (read only)', status, durationMs: Math.round(performance.now() - start),
        observed: { status: data.status, modelReady: data.modelReady, detector: data.detector, error: data.error } });
    } catch (error) {
      results.push({ name: 'Existing backend health (read only)', status: process.env.EXAMINER_BACKEND_URL ? 'failed' : 'skipped',
        reason: process.env.EXAMINER_BACKEND_URL ? error.message : 'No backend responding at localhost:3001; isolated API/browser tests run their own temporary server.' });
    }
  }
} catch (error) {
  results.push({ name: 'Examiner runner', status: 'failed', reason: error.stack });
} finally {
  killActive();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  const report = { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), cancelled,
    scope: 'Frontend, API, lifecycle and failure handling. Browser system test uses deterministic simulated AI/video with real Express/Vite/tracking/rules. No real webcam.',
    limitations: ['No labeled classroom videos: no accuracy/F1/distance certification.',
      'UI screenshots and 40 synthetic tracks do not certify full AI FPS for 40 real students.'],
    results };
  await writeFile(resolve(output, 'latest.json'), JSON.stringify(report, null, 2));
  const escaped = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const passed = results.filter(item => item.status === 'passed').length;
  const failed = results.filter(item => item.status === 'failed').length;
  const skipped = results.filter(item => item.status === 'skipped').length;
  const rows = results.map(item => `<tr><td>${escaped(item.name)}${item.scenarios ? '<details><summary>' + item.scenarios.length + ' tình huống</summary><ul>' + item.scenarios.map(check => '<li class="' + check.status + '">' + escaped(check.status + ': ' + check.name) + '</li>').join('') + '</ul></details>' : ''}</td><td class="${item.status}">${escaped(item.status)}</td><td>${item.durationMs === undefined ? '—' : (item.durationMs / 1000).toFixed(1) + 's'}</td><td>${item.log ? `<a href="${item.log}">Nhật ký</a>` : escaped(item.reason || JSON.stringify(item.observed || ''))}</td></tr>`).join('');
  const images = [];
  for (const name of ['desktop.png', 'mobile.png']) {
    try { await access(resolve(output, name)); images.push(`<a href="${name}">${name}</a>`); } catch {}
  }
  await writeFile(resolve(output, 'latest.html'), `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Student Attention Examiner</title><style>
body{font:15px/1.6 system-ui;background:#f1f6ff;color:#18365c;margin:0;padding:32px}main{max-width:1100px;margin:auto;background:white;padding:28px;border:1px solid #dbe6f8;border-radius:16px}h1{color:#2563eb;margin:0}a{color:#2563eb}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{padding:12px 10px;border-bottom:1px solid #e2eaf6;text-align:left}.passed{color:#15803d}.failed{color:#b91c1c}.skipped{color:#8b6410}.scroll{overflow:auto}small{color:#64748b}</style><main>
<h1>Student Attention · Examiner</h1><p>${passed} qua · ${failed} lỗi · ${skipped} bỏ qua</p><small>${escaped(startedAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }))}</small>
<p>Kiểm tra frontend/backend, phiên camera và xử lý lỗi. Bài kiểm tra trình duyệt dùng camera/mô hình mô phỏng; HTTP, proxy, tracker và luật trạng thái chạy thật.</p>
<div class="scroll"><table><thead><tr><th>Bài kiểm tra</th><th>Kết quả</th><th>Thời gian</th><th>Chi tiết</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>${images.join(' · ')} · <a href="system.json">Chi tiết luồng hệ thống</a> · <a href="latest.json">Báo cáo JSON</a></p>
<p>Không truy cập webcam thật. Không chứng nhận độ chính xác sáu hành động, tầm xa hoặc FPS nhận diện cả lớp. Máy chủ/trình duyệt kiểm thử tự đóng sau khi chạy; không tác động ứng dụng người dùng đã mở.</p></main></html>`);
  console.log(`Examiner: ${passed} passed, ${failed} failed, ${skipped} skipped. Report: .qa/examiner/latest.html`);
  process.exitCode = cancelled ? 130 : failed ? 1 : 0;
}
