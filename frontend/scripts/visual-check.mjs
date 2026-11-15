import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';
import { createInferenceEngine } from '../../backend/dist/inference.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(root, 'frontend/dist');
const output = resolve(root, '.qa');
const executables = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
let executablePath;
for (const candidate of executables) {
  try { await access(candidate); executablePath = candidate; break; } catch {}
}
if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH để kiểm tra giao diện.');
let engine;
let server;
let browser;
try {
  await mkdir(output, { recursive: true });
  engine = await createInferenceEngine(resolve(root, 'backend/models/classroom'));
  const api = createApp({ engine });
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return api(request, response);
    let path = url.pathname === '/__qa/portrait.jpg' ? resolve(root, 'backend/test-fixtures/portrait.jpg')
      : resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    const rel = relative(dist, path);
    if (url.pathname !== '/__qa/portrait.jpg' && (rel.startsWith('..') || isAbsolute(rel))) {
      response.writeHead(403).end(); return;
    }
    try {
      const bytes = await readFile(path);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' }[extname(path)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // A canvas video from the official TensorFlow test photo replaces getUserMedia.
  // The real webcam is never opened in this test.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const image = new Image();
        image.src = '/__qa/portrait.jpg';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        const context = canvas.getContext('2d');
        const stream = canvas.captureStream(15);
        context.fillStyle = '#eaf0f8';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const width = image.width * 720 / image.height;
        context.drawImage(image, (1280 - width) / 2, 0, width, 720);
        return stream;
      },
    });
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  const camera = await page.locator('.camera-panel').boundingBox();
  const panel = await page.locator('.attention-panel').boundingBox();
  assert(camera.x < panel.x && camera.width > panel.width * 2, 'Desktop needs a large left camera and a right attention list.');
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:/Webcam máy tính/}).click();
  assert.equal(await page.getByRole('region',{name:'Sơ đồ lớp học'}).count(),0);
  await page.getByRole('button', { name: 'Bật camera', exact: true }).click();
  await page.getByRole('button', { name: 'Bắt đầu nhận diện', exact: true }).click();
  await page.locator('.face-frame').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(9000);
  assert(engine.ready,'The real AI process must stay alive while the browser is rendering');
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).waitFor({timeout:1000});
  assert.equal(await page.getByRole('alert').count(),0,'Live camera must not silently stop with an error');
  assert.equal(engine.metrics?.analysisError,null,'All analysis threads must remain healthy');
  assert.equal(engine.metrics?.geometryError,null,'The face rescan must remain healthy');
  await page.screenshot({ path: resolve(output, 'face-bbox.png'), fullPage: true });
  assert(await page.locator('.face-overlay svg .face-frame').count()>0,'Motion/SVG must render the face rectangle');
  assert(await page.locator('.analysis-frame').evaluate(canvas=>canvas.width>0&&canvas.hidden&&getComputedStyle(canvas).display==='none'),
    'the analyzed image must remain hidden and available for correct face capture');
  assert(await page.locator('video').evaluate(video=>!video.classList.contains('media-hidden')&&!video.paused),
    'camera playback must remain visible independently of AI');
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();
  await page.getByText('Nhận diện đang tạm dừng',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Tiếp tục nhận diện',exact:true}).click();
  await page.getByRole('button',{name:'Đặt lại phiên nhận diện',exact:true}).click();
  await page.locator('.face-frame').first().waitFor({timeout:20000});
  await page.getByRole('button', { name: 'Tắt camera', exact: true }).click();
  assert.equal(await page.locator('.attention-card').count(),0,'Turning off camera must clear captured faces');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'Mobile layout must not overflow horizontally.');
  assert.deepEqual(errors, [], 'Browser must have no uncaught errors.');
  console.log('Chrome: desktop/mobile, attention list, live simulated camera + real AI, hidden capture image and Motion/SVG bbox passed.');
  console.log('Screenshots: .qa/desktop.png, .qa/face-bbox.png, .qa/mobile.png');
} catch(error) {
  if(browser){
    for(const page of browser.contexts().flatMap(context=>context.pages())){
      await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});
      console.error('Browser state:',await page.locator('body').innerText().catch(()=>''));
    }
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (engine) await engine.close();
}
