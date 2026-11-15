// Real HTTP/session evaluator and browser, with controlled observations.
// Does not load AI models or open a physical camera.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
let firstAt, lastTrack, server, vite, browser;
const requests = [], errors = [];
const engine = {
  ready: true,
  async detect() {
    const now = Date.now();
    firstAt ??= now;
    if(now-firstAt>=2500)return [];
    return [{ geometryId: 1, boxKind: 'face', box: { x: .35, y: .2, width: .2, height: .35 },
      observation: { valid: true, observedAt: now, objectsAt: now, facePixels: 128,
        eyeAspectRatio: .3, eyeBlinkLeft: 0, eyeBlinkRight: 0, yawOffset: 0, yawDeg: 0,
        pitchDeg: 0, mouthOpenRatio: .04, jawOpen: .03,
        phoneHeld: false, bookInteraction: false, laptopInteraction: now-firstAt<1800 } }];
  }, release() {}, async close() {},
};
try {
  server = createServer(createApp({ engine }));
  await new Promise((yes,no) => { server.once('error',no); server.listen(0,'127.0.0.1',yes); });
  const backend = 'http://127.0.0.1:'+server.address().port;
  process.env.BACKEND_URL = backend;
  vite = await createVite({ root: resolve(root,'frontend'),cacheDir:resolve(root,'.qa/vite-vit-alert-cache'),
    optimizeDeps:{include:['motion/react']}, server: { host: 'localhost', port: 4311, strictPort: true,
    proxy: { '/api': { target: backend, changeOrigin: true } } }, logLevel: 'error' });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (!/\/detect$/.test(response.url()) || !response.ok()) return;
    requests.push(response.json().then(value => { lastTrack = value.tracks[0]; }).catch(() => {}));
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{ configurable:true,value:async()=>{
      const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=360;
      const context=canvas.getContext('2d'); context.fillStyle='#eaf0f8'; context.fillRect(0,0,640,360);
      return canvas.captureStream(30);
    } });
  });
  await page.goto('http://localhost:4311');
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:/Webcam máy tính/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.locator('.face-overlay li').filter({hasText:'Vừa ghi nhận: Tương tác laptop'}).waitFor();
  const held = structuredClone(lastTrack);
  assert.equal(held.attention,'needs_attention');
  assert.equal(held.signals.find(signal=>signal.type==='laptop').state,'clear');
  assert(held.alerts[0].held);
  assert(held.alerts[0].expiresAt-held.alerts[0].observedAt>=5000);
  await mkdir(resolve(root,'.qa'),{recursive:true});
  await page.screenshot({path:resolve(root,'.qa/alert-hold-browser.png')});
  await delay(Math.max(0,held.alerts[0].expiresAt-Date.now()-150));
  assert.equal(lastTrack.attention,'needs_attention');
  assert.equal(lastTrack.status,'lost');
  assert.equal(await page.locator('.face-overlay li').count(),0,'lost warning must not draw an unsupported face box over video');
  assert(await page.locator('.attention-card').count(),'captured warning stays in the attention list through face loss');
  await page.screenshot({path:resolve(root,'.qa/alert-hold-lost-browser.png')});
  await delay(400);
  assert.notEqual(lastTrack?.attention,'needs_attention');
  assert.equal(lastTrack?.alerts.length ?? 0,0);
  assert(!await page.locator('.face-overlay li').filter({hasText:'Vừa ghi nhận'}).count());
  assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  await writeFile(resolve(root,'.qa/alert-hold-browser.json'),JSON.stringify({
    checkedAt:new Date().toISOString(),note:'Controlled observations; real session evaluator, HTTP and browser. No physical camera.',
    heldAlert:held.alerts[0],currentSignal:held.signals.find(signal=>signal.type==='laptop'),
    redUntilExpiry:true,heldThroughFaceLoss:true,lostTrackNotCountedVisible:true,clearedAfterExpiry:true,errors,
  },null,2));
  console.log('PASS: laptop red, retained label displayed for five seconds through face loss, then cleared.');
} finally {
  await Promise.allSettled(requests);
  await browser?.close();
  await vite?.close();
  server?.closeAllConnections();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
}
