// Explicit physical-Pi test. Never invoked by the normal examiner.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';
import { PiSource } from '../../backend/dist/pi-source.js';
import { PiController, piControlUrl, forgetPiAddress } from '../../backend/dist/pi-controller.js';
import { InferenceRuntime } from '../../backend/dist/inference-runtime.js';
import { createInferenceEngine } from '../../backend/dist/inference.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
loadEnvFile(resolve(root, 'backend/.env'));
const checks = [];
let api, controller, engine, browser, vite, page;
const until = async (condition, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (!await condition().catch(() => false)) {
    assert(Date.now() < deadline, 'Physical Pi check timed out');
    await delay(300);
  }
};
const check = async (name, action) => {
  const start = Date.now();
  await action();
  checks.push({ name, status: 'passed', durationMs: Date.now() - start });
  console.log('PASS ' + name);
};
async function pi(path = '/health', body) {
  for (let attempt = 0; ; attempt++) {
    try {
  const response = await fetch(await piControlUrl(path, process.env.PI_CONTROL_URL), {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + process.env.PI_TOKEN, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, 'Pi control endpoint failed');
  return response.json();
    } catch (error) {
      forgetPiAddress(process.env.PI_CONTROL_URL);
      if (attempt >= 3) throw error;
      await delay(500);
    }
  }
}
async function stopBackend() {
  if (!api) return;
  api.closeAllConnections();
  const closingServer = new Promise(resolve => api.close(resolve));
  await Promise.all([controller.close(), engine.close(), closingServer]);
  api = controller = engine = undefined;
}
async function startBackend() {
  engine = new InferenceRuntime(signal => createInferenceEngine(resolve(root, 'backend/models/classroom'), signal));
  const source = new PiSource();
  controller = new PiController(source, { url: process.env.PI_CONTROL_URL, token: process.env.PI_TOKEN,
    rtspUrl: process.env.PI_RTSP_URL, ready: () => engine.ready });
  api = createServer(createApp({ engine, pi: source, piController: controller, piToken: process.env.PI_TOKEN }));
  await new Promise((yes, no) => { api.once('error', no); api.listen(3001, '127.0.0.1', yes); });
  controller.start();
  await engine.start();
  assert(engine.ready, engine.startupError ?? 'Real AI failed to load');
}

try {
  await check('Pi standby: webcam off and released before test', async () => {
    await pi('/stop', {}); // Also makes a repeat run safe after an interrupted previous test.
    assert.deepEqual([(await pi()).desired, (await pi()).camera_released], [false, true]);
  });
  await check('Real local AI model startup', startBackend);
  process.env.BACKEND_URL = 'http://127.0.0.1:3001';
  vite = await createVite({ root: resolve(root, 'frontend'), server: { host: 'localhost', port: 3000, strictPort: true } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--disable-gpu', '--renderer-process-limit=1'] });
  page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://localhost:3000');
  await page.getByRole('combobox', { name: 'Chọn webcam' }).click();
    await page.getByRole('option', { name: /^Raspberry Pi 4/ }).click();
  await check('Web camera-on: real RTSP decoding and MJPEG image', async () => {
    await page.getByRole('button', { name: 'Bật camera', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pi-video')?.naturalWidth === 1280);
    assert.equal((await pi()).state, 'streaming');
  });
  const detectionResponse = () => page.waitForResponse(response => response.url().includes('/detect/pi') && response.status() === 200, { timeout: 60000 });
  await check('Real webcam JPEG processed by real backend AI', async () => {
    const pending = detectionResponse();
    await page.getByRole('button', { name: 'Bắt đầu nhận diện', exact: true }).click();
    const result = await (await pending).json();
    assert(Array.isArray(result.tracks));
    checks.push({ observedTracks: result.tracks.length, note: 'No classroom frames or identities saved.' });
  });
  await check('Backend stop releases webcam; missing heartbeat expires after ten seconds', async () => {
    await stopBackend();
    await until(async () => (await pi()).camera_released);
    assert.equal((await pi()).desired, true);
    await pi('/heartbeat', { ready: true });
    await until(async () => (await pi()).state === 'streaming');
    await delay(11000);
    await until(async () => (await pi()).camera_released);
    assert.equal((await pi()).desired, true);
  });
  await check('Backend restart automatically restores video and detection', async () => {
    const pending = detectionResponse();
    await startBackend();
    await pending;
    await page.waitForFunction(() => document.querySelector('.pi-video')?.naturalWidth === 1280);
    await page.getByRole('button', { name: 'Tạm dừng nhận diện', exact: true }).waitFor();
  });
  await check('Explicit camera-off releases webcam; camera can be opened again', async () => {
    await page.getByRole('button', { name: 'Tắt camera', exact: true }).click();
    await until(async () => { const s = await pi(); return !s.desired && s.camera_released; });
    await page.getByRole('button', { name: 'Bật camera', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pi-video')?.naturalWidth === 1280);
    await page.getByRole('button', { name: 'Tắt camera', exact: true }).click();
    await until(async () => (await pi()).camera_released);
    assert.deepEqual(pageErrors, []);
  });
} catch (error) {
  checks.push({ status: 'failed', error: error.message });
  console.error(error);
  process.exitCode = 1;
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => dispatchEvent(new Event('pagehide'))).catch(() => {});
  await browser?.close();
  await vite?.close();
  await pi('/stop', {}).catch(() => {});
  await stopBackend();
  await mkdir(resolve(root, '.qa'), { recursive: true });
  await writeFile(resolve(root, '.qa/pi-live.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
  console.log('Live check processes closed; explicit Pi camera-stop requested.');
}
