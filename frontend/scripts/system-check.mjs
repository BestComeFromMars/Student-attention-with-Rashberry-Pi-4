import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as viteServer } from 'vite';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';
import { Sessions } from '../../backend/dist/sessions.js';
import { PiSource } from '../../backend/dist/pi-source.js';
import { HttpError } from '../../backend/dist/errors.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.qa/examiner');
const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
const checks = [];
const rendering = [];
let api, vite, browser, page;
const pi = new PiSource();
const sessions = new Sessions();
let piJpeg, piPump;
const piDevice = { deviceOnline: true, state: 'off', desired: false, cameraReleased: true,
  bootId: 'examiner-boot', generation: 0, error: null };
const piCommands = [];
const piController = {
  status: () => ({ ...piDevice }),
  async command(command) {
    piCommands.push(command);
    clearInterval(piPump);
    if (command === 'start') {
      Object.assign(piDevice, { state: 'streaming', desired: true, cameraReleased: false, generation: piDevice.generation + 1 });
      await pi.update(piJpeg);
      piPump = setInterval(() => { void pi.update(piJpeg); }, 100);
    } else {
      Object.assign(piDevice, { state: command === 'shutdown' ? 'shutting_down' : 'off', desired: false, cameraReleased: true });
      pi.close();
    }
    return { ...piDevice };
  },
};
const engine = {
  ready: true, detector: 'classroom', mode: 'normal', faces: 3, clustered: false,
  calls: 0, active: 0, maxActive: 0, pending: null, lastSession: null,
  async detect(jpeg, context) {
    this.calls++; this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    this.lastSession = context.sessionId;
    try {
      if (this.mode === 'hold') await new Promise(resolve => { this.pending = resolve; });
      if (this.mode === 'error') throw new Error('EXAMINER_INTERNAL_DETAIL');
      if (this.mode === 'unavailable') throw new HttpError(503, 'AI tạm thời chưa sẵn sàng.');
      try { await sharp(jpeg).stats(); } catch { throw new HttpError(422, 'JPEG không hợp lệ.'); }
      return Array.from({ length: this.faces }, (_, index) => ({
        geometryId: index, boxKind: 'face', confidence: .95,
        box: { x: this.clustered ? .45 : .04 + (index % 8) * .12, y: this.clustered ? .45 : .06 + Math.floor(index / 8) * .18, width: .06, height: .09 },
        observation: { valid: true, eyeAspectRatio: .3, yawOffset: 0, pitchDeg: 0, yawDeg: 0,
          observedAt: Date.now(), objectsAt: Date.now(), facePixels: 100, mouthOpenRatio: .05,
          eyeBlinkLeft: 0, eyeBlinkRight: 0, phoneHeld: false, laptopInteraction: false, bookInteraction: false },
      }));
    } finally { this.active--; }
  },
  release() {}, async close() {},
};
const until = async condition => {
  const deadline = Date.now() + 8000;
  while (!condition()) { assert(Date.now() < deadline, 'Timed out waiting for a controlled request'); await delay(10); }
};
const check = async (name, fn) => {
  const start = performance.now();
  try { await fn(); checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - start) }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'failed', error: error.stack }); throw error; }
};
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
await mkdir(output, { recursive: true });
for (const name of ['desktop.png', 'mobile.png', 'failure.png', 'system.json']) {
  await unlink(resolve(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
try {
  api = httpServer(createApp({ engine, sessions, pi, piController, piToken: 'examiner-pi-token' }));
  await listen(api);
  const origin = 'http://127.0.0.1:' + api.address().port;
  const jpeg = await readFile(resolve(root, 'backend/test-fixtures/portrait.jpg'));
  piJpeg = jpeg;
  const request = (path, options = {}) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(15000) });
  const create = async () => { const response = await request('/api/sessions', { method: 'POST' }); assert.equal(response.status, 201); return (await response.json()).sessionId; };
  const frame = id => request('/api/sessions/' + id + '/detect', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });

  await check('HTTP: health, cache headers and unknown routes', async () => {
    const response = await request('/api/health');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).modelReady, true);
    assert.equal((await request('/api/does-not-exist')).status, 404);
  });
  await check('HTTP: model not ready refuses new sessions', async () => {
    engine.ready = false;
    try { assert.equal((await request('/api/sessions', { method: 'POST' })).status, 503); }
    finally { engine.ready = true; }
  });
  await check('HTTP: empty, wrong type, corrupt, oversized and unsupported encoding', async () => {
    const id = await create();
    const post = (body, headers = {}) => request('/api/sessions/' + id + '/detect', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body });
    assert.equal((await post(Buffer.alloc(0))).status, 400);
    assert.equal((await post('not JPEG', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('not JPEG')).status, 422);
    assert.equal((await post(Buffer.alloc(4 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await post(jpeg, { 'Content-Encoding': 'examiner-unsupported' })).status, 415);
    await request('/api/sessions/' + id, { method: 'DELETE' });
  });
  await check('HTTP: concurrent frame 409, deleted in-flight result 410, missing session 404', async () => {
    const id = await create();
    engine.mode = 'hold';
    const pending = frame(id);
    await until(() => engine.pending);
    assert.equal((await frame(id)).status, 409);
    assert.equal((await request('/api/sessions/' + id, { method: 'DELETE' })).status, 204);
    engine.mode = 'normal'; engine.pending(); engine.pending = null;
    assert.equal((await pending).status, 410);
    assert.equal((await frame(id)).status, 404);
  });
  await check('HTTP: model failure hides internal details and unlocks session', async () => {
    const id = await create(); engine.mode = 'error';
    const response = await frame(id); assert.equal(response.status, 500);
    assert(!(await response.text()).includes('EXAMINER_INTERNAL_DETAIL'));
    engine.mode = 'normal'; assert.equal((await frame(id)).status, 200);
    await request('/api/sessions/' + id, { method: 'DELETE' });
  });
  await check('HTTP: Raspberry Pi offline, token and valid/invalid upload', async () => {
    assert.equal((await request('/api/pi/stream')).status, 503);
    const upload = (body, token) => request('/api/pi/frame', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Pi-Token': token }, body });
    assert.equal((await upload(jpeg, 'wrong')).status, 401);
    assert.equal((await upload(jpeg, 'examiner-pi-tokeX')).status, 401);
    assert.equal((await upload('invalid jpeg', 'examiner-pi-token')).status, 422);
    assert.equal((await upload(jpeg, 'examiner-pi-token')).status, 202);
    assert.equal((await (await request('/api/pi/status')).json()).online, true);
    pi.close();
  });
  await check('HTTP: Pi power control refuses untrusted origins and missing confirmation', async () => {
    const power = (extra, body = { confirm: true }) => request('/api/pi/shutdown', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
    assert.equal((await power({})).status, 403);
    assert.equal((await power({ 'X-Pi-Control': '1', Origin: 'http://other.example' })).status, 403);
    assert.equal((await power({ 'X-Pi-Control': '1' }, {})).status, 400);
    assert.equal(piCommands.length, 0);
  });

  const previousBackend = process.env.BACKEND_URL;
  process.env.BACKEND_URL = origin;
  try { vite = await viteServer({ root: resolve(root, 'frontend'), cacheDir: resolve(root, 'frontend/.vite-cache/qa-system-' + process.pid), server: { port: 0, host: '127.0.0.1', strictPort: true, open: false } }); }
  finally { if (previousBackend === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = previousBackend; }
  await vite.listen();
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium',
  ];
  let executablePath;
  for (const path of candidates) { try { await access(path); executablePath = path; break; } catch {} }
  assert(executablePath, 'Install Chrome/Edge or set CHROME_PATH');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu', '--renderer-process-limit=1'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__examinerCamera = { starts: 0, stops: 0 };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'examiner', label: 'Examiner simulated camera' }],
      addEventListener() {}, removeEventListener() {},
      getUserMedia: async constraints => {
        if (constraints.audio !== false) throw new Error('Audio must stay off');
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d'); let frame = 0;
        const paint = () => { context.fillStyle = '#eaf2ff'; context.fillRect(0, 0, 640, 360);
          context.fillStyle = '#2563eb'; context.fillRect((frame++ * 3) % 600, 140, 40, 40); };
        paint(); const stream = canvas.captureStream(15); const timer = setInterval(paint, 60);
        window.__examinerCamera.starts++;
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track); let stopped = false;
          track.stop = () => { if (!stopped) { stopped = true; stop(); clearInterval(timer); window.__examinerCamera.stops++; } };
        }
        return stream;
      },
    } });
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const detect = async () => { await button('Bắt đầu nhận diện').click(); await page.locator('.face-frame').first().waitFor(); };
  const resume = async () => { await button('Tiếp tục nhận diện').click(); await button('Tạm dừng nhận diện').waitFor(); await page.locator('.face-frame').first().waitFor(); };
  await check('Browser: no camera/AI before click; real Vite proxy, JPEG and tracks', async () => {
    await page.goto('http://127.0.0.1:' + vite.httpServer.address().port, { waitUntil: 'networkidle' });
    assert.equal(engine.active, 0);
    assert.equal(await page.evaluate(() => window.__examinerCamera.starts), 0);
    const calls = engine.calls;
    await page.getByRole('combobox', { name: 'Chọn webcam' }).click();
    await page.getByRole('option', { name: /Webcam máy tính/ }).click();
    await button('Bật camera').click(); await button('Tắt camera').waitFor();
    assert.equal(engine.calls, calls);
    await detect();
    await page.waitForFunction(() => document.querySelectorAll('.face-frame').length === 3);
    assert(await page.locator('.face-frame').count() > 0);
  });
  await check('Browser: attention list replaces map; neutral faces do not create captured warnings', async () => {
    await page.getByRole('region',{name:'Danh sách cần chú ý'}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Sơ đồ lớp học'}).count(),0);
    assert.equal(await page.locator('.attention-card').count(),0);
    await button('Tạm dừng nhận diện').click(); await delay(200);
    const calls = engine.calls; await delay(200); assert.equal(engine.calls, calls);
    assert.equal(await page.evaluate(() => window.__examinerCamera.starts - window.__examinerCamera.stops), 1);
    await resume();
  });
  await check('Browser: transient AI 503, resume creates a new session and clears old names', async () => {
    const previous = engine.lastSession; engine.mode = 'unavailable';
    await button('Tiếp tục nhận diện').waitFor();
    assert.equal(await page.locator('.face-frame').count(), 0);
    engine.mode = 'normal'; await resume();
    assert.notEqual(engine.lastSession, previous);
    assert.equal(await page.getByRole('button', { name: /Minh Anh,/ }).count(), 0);
  });
  await check('Browser: malformed backend payload pauses safely and can resume', async () => {
    await page.route('**/api/sessions/*/detect', route =>
      route.fulfill({ contentType: 'application/json', body: '{"tracks":[{"id":"A","box":null}]}' }), { times: 1 });
    await button('Tiếp tục nhận diện').waitFor();
    await resume();
  });
  await check('Browser: reset/stop with inference in flight ignores the late result', async () => {
    engine.mode = 'hold'; await until(() => engine.pending);
    await button('Đặt lại phiên nhận diện').click();
    await button('Tắt camera').click();
    engine.mode = 'normal'; engine.pending(); engine.pending = null;
    await delay(200);
    assert.equal(await page.locator('.face-frame').count(), 0);
    assert.equal(await page.evaluate(() => window.__examinerCamera.starts - window.__examinerCamera.stops), 0);
  });
  await check('Browser: 40 face boxes, normalized positions after desktop/mobile resize, no overflow', async () => {
    engine.faces = 40;
    await button('Bật camera').click(); await button('Tắt camera').waitFor(); await detect();
    await page.waitForFunction(() => document.querySelectorAll('.face-frame').length === 40);
    const verifyPosition = async () => {
      await delay(280);
      const plot = await page.locator('.video-viewport').boundingBox();
      const dot = await page.locator('.face-frame').first().boundingBox();
      assert(Math.abs(dot.x + dot.width / 2 - (plot.x + plot.width * .07)) < 3);
      assert(Math.abs(dot.y + dot.height / 2 - (plot.y + plot.height * .105)) < 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    };
    await verifyPosition(); await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await verifyPosition();
    await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 }); await verifyPosition();
    for (const count of [10, 20, 40]) {
      engine.faces = count;
      await button('Đặt lại phiên nhận diện').click();
      await page.waitForFunction(expected => document.querySelectorAll('.face-frame').length === expected, count);
      await delay(350);
      const sample = await page.evaluate(async () => {
        const intervals = [];
        let previous;
        await new Promise(done => {
          const tick = at => {
            if (previous !== undefined) intervals.push(at - previous);
            previous = at;
            if (intervals.length < 90) requestAnimationFrame(tick); else done();
          };
          requestAnimationFrame(tick);
        });
        intervals.sort((a, b) => a - b);
        return { frameCount: intervals.length, browserFps: +(1000 * intervals.length / intervals.reduce((a, b) => a + b, 0)).toFixed(2),
          p95FrameMs: +intervals[Math.floor(intervals.length * .95)].toFixed(2) };
      });
      rendering.push({ people: count, viewport: [1440, 960], ...sample });
      assert(sample.browserFps >= 24, 'Overlay rendering fell below 24 FPS with ' + count + ' simulated tracks');
    }
  });
  await check('Browser: reduced motion, expanded camera, camera/session cleanup and no JS errors', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.face-frame').first().evaluate(element => getComputedStyle(element).animationName), 'none');
    await button('Phóng to camera').click();
    assert.equal(await page.locator('.attention-panel').evaluate(element=>element.inert),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.attention-panel').evaluate(element=>element.inert),false);
    await button('Tắt camera').click(); await delay(100);
    const counts = await page.evaluate(() => window.__examinerCamera);
    assert.equal(counts.starts, counts.stops);
    assert.equal(engine.maxActive, 1, 'Frontend must never overlap inference');
    assert.deepEqual(errors, []);
  });
  await check('Browser: 40 overlapping detections stay within camera viewport on desktop and phones', async () => {
    engine.clustered = true;
    await button('Bật camera').click(); await button('Tắt camera').waitFor(); await detect();
    await page.waitForFunction(() => document.querySelectorAll('.face-frame').length === 40);
    for (const [width, height] of [[1440, 960], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height }); await delay(450);
      assert.equal(await page.locator('.attention-panel').count(),1);
      assert.equal(await page.locator('.map-plot').count(),0);
      const circles = await page.locator('.face-frame').evaluateAll(elements => elements.map(element => {
        const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width };
      }));
      assert.equal(circles.length, 40);
      const viewport=await page.locator('.video-viewport').boundingBox();
      assert(circles.every(circle=>circle.x>=viewport.x&&circle.x<=viewport.x+viewport.width&&circle.y>=viewport.y&&circle.y<=viewport.y+viewport.height));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({ path: resolve(output, 'dense-' + width + '.png'), fullPage: true });
    }
    engine.clustered = false;
    await button('Tắt camera').click(); await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('Browser: Pi camera control, real MJPEG proxy and separate power confirmation (simulated device)', async () => {
    await page.getByRole('combobox', { name: 'Chọn webcam' }).click();
    await page.getByRole('option', { name: /^Raspberry Pi 4/ }).click();
    await button('Bật camera').click();
    await page.waitForFunction(() => document.querySelector('.pi-video')?.naturalWidth > 0);
    assert.equal(piCommands.at(-1), 'start');
    await detect();
    await button('Tắt camera').click();
    await until(() => piDevice.cameraReleased);
    assert.equal(piDevice.desired, false);
    page.once('dialog', dialog => dialog.dismiss());
    await button('Tắt Raspberry Pi').click();
    assert(!piCommands.includes('shutdown'));
    page.once('dialog', dialog => dialog.accept());
    await button('Tắt Raspberry Pi').click();
    await until(() => piCommands.includes('shutdown'));
    assert.equal(piDevice.state, 'shutting_down');
    assert.deepEqual(errors, []);
  });
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  clearInterval(piPump);
  engine.mode = 'normal'; engine.pending?.();
  if (page && !page.isClosed()) await page.evaluate(() => dispatchEvent(new Event('pagehide'))).catch(() => {});
  if (browser) await browser.close();
  if (vite) await vite.close();
  pi.close();
  if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
  await writeFile(resolve(output, 'system.json'), JSON.stringify({
    scope: 'Real HTTP/Vite/React/tracker/rules; deterministic simulated AI and camera, no physical webcam.',
    checks, rendering,
  }, null, 2));
  await writeFile(resolve(root, '.qa/rendering-load.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), note: 'Headless Chromium on this PC, simulated camera/AI; rendering cadence, not model FPS or physical phone measurements.', results: rendering,
  }, null, 2));
}
