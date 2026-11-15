// DESTRUCTIVE DEVICE ACTION: only run explicitly with --confirm after all Pi checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';
import { PiController, piControlUrl } from '../../backend/dist/pi-controller.js';
import { PiSource } from '../../backend/dist/pi-source.js';

if (!process.argv.includes('--confirm')) throw new Error('This powers off the real Pi. Pass --confirm explicitly.');
const root = fileURLToPath(new URL('../../', import.meta.url));
loadEnvFile(resolve(root, 'backend/.env'));
const endpoint = await piControlUrl('/health', process.env.PI_CONTROL_URL);
const controller = new PiController(new PiSource(), { url: process.env.PI_CONTROL_URL,
  token: process.env.PI_TOKEN, rtspUrl: process.env.PI_RTSP_URL, ready: () => false });
const engine = { ready: false, startupState: 'loading', detect: async () => { throw new Error('AI stopped for final poweroff check'); }, close: async () => {} };
let api, vite, browser;
const report = { checkedAt: new Date().toISOString(), webCommandAccepted: false, localServersClosed: false, sshWentOffline: false };
try {
  // Only the control API is opened; the heavy AI and video workers stay stopped.
  api = createServer(createApp({ engine, piController: controller }));
  await new Promise((yes, no) => { api.once('error', no); api.listen(3001, '127.0.0.1', yes); });
  controller.start(); // Publish device presence without starting AI or the video reader.
  process.env.BACKEND_URL = 'http://127.0.0.1:3001';
  vite = await createVite({ root: resolve(root, 'frontend'), server: { host: 'localhost', port: 3000, strictPort: true } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  await page.getByRole('combobox', { name: 'Chọn webcam' }).click();
    await page.getByRole('option', { name: /^Raspberry Pi 4/ }).click();
  page.once('dialog', dialog => dialog.accept());
  const pending = page.waitForResponse(response => response.url().endsWith('/api/pi/shutdown') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Tắt Raspberry Pi', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 202);
  const status = await response.json();
  assert.equal(status.state, 'shutting_down');
  assert.equal(status.cameraReleased, true);
  assert.equal(status.desired, false);
  report.webCommandAccepted = true;
  console.log('PASS web confirmation → backend → real Pi: shutdown accepted, webcam released.');
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  await vite?.close();
  if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
  await controller.close();
  report.localServersClosed = true;
}
if (report.webCommandAccepted) {
  const reachable = () => new Promise(resolve => {
    const socket = createConnection({ host: endpoint.hostname, port: 22 });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  // systemd may coalesce timers within its default accuracy window.
  for (let attempt = 0; attempt < 45; attempt++) {
    await delay(2000);
    if (!await reachable()) { report.sshWentOffline = true; break; }
  }
  if (report.sshWentOffline) console.log('PASS Pi offline after poweroff; local frontend/backend already closed.');
  else { report.error = 'Pi did not go offline after accepted shutdown'; process.exitCode = 1; }
}
await mkdir(resolve(root, '.qa'), { recursive: true });
await writeFile(resolve(root, '.qa/pi-poweroff.json'), JSON.stringify(report, null, 2));
