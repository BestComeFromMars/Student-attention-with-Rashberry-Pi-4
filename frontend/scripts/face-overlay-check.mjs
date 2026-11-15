// Real frontend, Motion SVG, browser and session API; controlled geometry, public
// fixture video in RAM. Does not open a physical camera or load AI models.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';
import { createApp } from '../../backend/dist/app.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
let phase='jitter', sequence=0, server, vite, browser;
const errors=[];
const engine={ready:true, async detect(){
  if(phase==='missing') return [];
  const now=Date.now(), tick=sequence++;
  const measurements = phase==='dense' ? Array.from({length:40},(_,i)=>({
    cx:.07+(i%8)*.12,cy:.09+Math.floor(i/8)*.18,width:.065,height:.105,
  })) : [
    {cx:.242,cy:.532,width:.151,height:.366},
    {cx:.721,cy:.526,width:.137,height:.424},
  ];
  return measurements.map((box,index)=>{
    const jitter=phase==='jitter' && tick>0 ? tick%2 ? 1 : -1 : 0;
    const scale=phase==='near'?1.5:phase==='far'?.6:1;
    const width=box.width*(1+jitter*.13)*scale,height=box.height*(1-jitter*.12)*scale;
    return {geometryId:index+1,personId:index+1,trackingState:phase==='ghost'&&index===0?'predicted':phase==='coasting'?'coasting':phase==='body'?'body':'face',boxKind:'face',
      box:{x:box.cx-width/2+(phase==='fast'?.14:phase==='body'?.08:0),y:box.cy-height/2,width,height},
      observation:{valid:true,observedAt:now,objectsAt:now,facePixels:150,
        eyeAspectRatio:.3,eyeBlinkLeft:0,eyeBlinkRight:0,yawOffset:0,yawDeg:0,pitchDeg:0,
        mouthOpenRatio:.04,jawOpen:.03,phoneHeld:phase!=='dense' && index===1,
        laptopInteraction:false,bookInteraction:false}};
  });
},release(){},async close(){}};
try {
  server=createServer(createApp({engine}));
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const backend='http://127.0.0.1:'+server.address().port;
  process.env.BACKEND_URL=backend;
  vite=await createVite({root:resolve(root,'frontend'),cacheDir:resolve(root,'.qa/vite-overlay-cache'),logLevel:'error',optimizeDeps:{include:['motion/react']},plugins:[{
    name:'qa-face-inspection',
    resolveId(id){if(id==='/__qa/inspect.ts')return '\0qa-face-inspection';},
    load(id){if(id==='\0qa-face-inspection')return `window.__readFaceFrames=()=>Array.from(document.querySelectorAll('.face-frame')).map(node=>({
        id:node.parentElement.dataset.faceId,x:node.x.baseVal.value,y:node.y.baseVal.value,
        width:node.width.baseVal.value,height:node.height.baseVal.value,
        opacity:Number(getComputedStyle(node.parentElement).opacity),
        stageWidth:node.ownerSVGElement.width.baseVal.value,stageHeight:node.ownerSVGElement.height.baseVal.value
      }))`;},
    configureServer(dev){dev.middlewares.use('/__qa/two.jpg',async(_request,response)=>{
      response.setHeader('Content-Type','image/jpeg');
      response.end(await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg')));
    });},
  }],server:{host:'localhost',port:4312,strictPort:true,proxy:{'/api':{target:backend,changeOrigin:true}}}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
      const image=new Image();image.src='/__qa/two.jpg';await image.decode();
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      canvas.getContext('2d').drawImage(image,0,0,1280,720);
      return canvas.captureStream(15);
    }});
  });
  await page.goto('http://localhost:4312',{waitUntil:'networkidle'});
  await page.evaluate(()=>import('/__qa/inspect.ts'));
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:/Webcam máy tính/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.waitForFunction(()=>window.__readFaceFrames().length===2);
  async function frames(count=90){
    return page.evaluate(count=>new Promise(resolve=>{
      const samples=[],times=[];let last=performance.now();
      function sample(now){times.push(now-last);last=now;samples.push(window.__readFaceFrames());
        if(samples.length>=count)resolve({samples,times});else requestAnimationFrame(sample);}
      requestAnimationFrame(sample);
    }),count);
  }
  const jitter=await frames(120);
  const variation={};
  for(const id of ['face-A','face-B']){
    const measurements=jitter.samples.map(frame=>frame.find(box=>box.id===id));
    assert(measurements.every(Boolean),'frames must not blink out during size noise');
    const widths=measurements.map(box=>box.width),heights=measurements.map(box=>box.height);
    variation[id]={width:(Math.max(...widths)-Math.min(...widths))/widths[0],
      height:(Math.max(...heights)-Math.min(...heights))/heights[0]};
    const baseWidth=id==='face-A'?.151:.137,baseHeight=id==='face-A'?.366:.424;
    for(const box of measurements) {
      assert([1,.87,1.13].some(factor=>Math.abs(box.width/box.stageWidth-baseWidth*factor)<.00001),
        'width must equal a backend sample, not a delayed reconstructed size');
      assert([1,.88,1.12].some(factor=>Math.abs(box.height/box.stageHeight-baseHeight*factor)<.00001),
        'height must equal a backend sample');
    }
  }
  for(const [name,scale] of [['near',1.5],['far',.6],['near',1.5]]) {
    phase=name;
    await page.waitForFunction(scale=>window.__readFaceFrames().every(box=>
      Math.abs(box.width/box.stageWidth-(box.id==='face-A'?.151:.137)*scale)<.00001),scale);
  }
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();
  assert.equal(await page.locator('.face-overlay').count(),0,'pause must remove the overlay immediately');
  assert.equal(await page.locator('video').evaluate(video=>video.srcObject.getTracks()[0].readyState),'live');
  phase='steady';
  await page.getByRole('button',{name:'Tiếp tục nhận diện',exact:true}).click();
  await page.waitForFunction(()=>window.__readFaceFrames().length===2);
  await mkdir(resolve(root,'.qa'),{recursive:true});
  await page.screenshot({path:resolve(root,'.qa/face-overlay-desktop.png'),fullPage:true});
  phase='ghost';
  await page.waitForFunction(()=>window.__readFaceFrames().length===1&&window.__readFaceFrames()[0].id==='face-B');
  await page.waitForTimeout(250);
  assert.equal((await page.evaluate(()=>window.__readFaceFrames())).length,1,'texture tracking must not revive a rejected old face');
  assert.match(await page.locator('.camera-person-count').innerText(),/^1\/40/);
  await page.screenshot({path:resolve(root,'.qa/ghost-overlay.png'),fullPage:true});
  phase='steady';
  await page.waitForFunction(()=>window.__readFaceFrames().length===2);
  phase='fast';
  await page.waitForTimeout(350);
  const fast=await page.evaluate(()=>window.__readFaceFrames());
  assert(Math.abs((fast[0].x+fast[0].width/2)/fast[0].stageWidth-(.242+.14))<.015,'same-ID fast motion must not be rejected as a spike');
  phase='coasting';
  await page.waitForFunction(()=>document.querySelector('.camera-person-count')?.textContent?.startsWith('0/40')&&window.__readFaceFrames().length===2);
  const shortMiss=await frames(10);
  assert(shortMiss.samples.every(frame=>frame.length===2),'a short native miss must not blink the solid frames out');
  phase='body';
  await page.waitForTimeout(2200);
  const body=await page.evaluate(()=>window.__readFaceFrames());
  assert.equal(body.length,2,'fresh body support keeps face ROIs beyond the ordinary miss timeout');
  assert(Math.abs((body[0].x+body[0].width/2)/body[0].stageWidth-(.242+.08))<.015,'body support moves the face ROI');
  assert.match(await page.locator('.camera-person-count').innerText(),/^0\/40/);
  phase='jitter';
  await page.waitForTimeout(300);
  phase='missing';
  await page.waitForResponse(response=>/\/detect$/.test(response.url())&&response.ok());
  await page.waitForTimeout(300);
  const held=await page.evaluate(()=>window.__readFaceFrames());
  assert.equal(held.length,0,'a retained warning without face/body support must not draw a ghost rectangle');
  assert.match(await page.locator('.camera-person-count').innerText(),/^0\/40/,'held frames are not visible detections');
  phase='jitter';
  await page.waitForFunction(()=>document.querySelector('.camera-person-count')?.textContent?.startsWith('2/40'));
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  const mobile=await page.evaluate(()=>window.__readFaceFrames());
  for(const box of mobile)assert(box.x>=0&&box.y>=0&&box.x+box.width<=box.stageWidth+1&&box.y+box.height<=box.stageHeight+1);
  await page.screenshot({path:resolve(root,'.qa/face-overlay-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  phase='dense';
  await page.getByRole('button',{name:'Đặt lại phiên nhận diện',exact:true}).click();
  await page.waitForFunction(()=>window.__readFaceFrames().length===40);
  const dense=await frames(90), intervals=dense.times.slice(1).sort((a,b)=>a-b);
  const p95=intervals[Math.floor(intervals.length*.95)];
  assert(dense.samples.every(frame=>frame.length===40));
  assert(p95<50,'40-frame rendering must remain responsive');
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  assert.equal(await page.locator('.face-overlay').count(),0);
  assert.deepEqual(errors,[]);
  const report={checkedAt:new Date().toISOString(),note:'Real UI/Motion SVG/session API; controlled boxes and public fixture video, not physical-camera tracking accuracy.',
    variation,rejectedGhostNotDrawn:true,shortMissNoBlink:true,rawDimensionsPreserved:true,nearFarMatched:true,pauseClearsOverlay:true,fastMotionFollowed:true,bodySupportedBeyondTimeout:true,unsupportedLostBoxesHidden:true,lostNotCountedVisible:true,mobileWithinViewport:true,
    dense:{faces:40,frames:90,p95IntervalMs:+p95.toFixed(2)},cameraOffClears:true,errors};
  await writeFile(resolve(root,'.qa/face-overlay-verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();await vite?.close();
  server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));
}
