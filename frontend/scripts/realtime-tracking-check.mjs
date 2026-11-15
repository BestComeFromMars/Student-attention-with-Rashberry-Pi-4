// Displayed public video + deliberately delayed HTTP inference, no hardware.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {createServer as createVite} from 'vite';
import {chromium} from 'playwright-core';
import {createApp} from '../../backend/dist/app.js';
import {PiSource} from '../../backend/dist/pi-source.js';
import {createInferenceEngine} from '../../backend/dist/inference.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sharp=createRequire(new URL('../../backend/package.json',import.meta.url))('sharp');
const piMode=process.env.REALTIME_SOURCE==='pi';
const realModel=process.env.REALTIME_ENGINE==='real';
const expectedPeople=Number(process.env.REALTIME_PEOPLE||2);
const inferenceDelay=Number(process.env.REALTIME_DELAY_MS||1200);
let server,vite,browser;
let piTimer,streaming=false,piStarted=0;
const pi=new PiSource(),piImages=new Map();
const status=()=>({online:true,deviceOnline:true,state:streaming?'streaming':'off',desired:streaming,
  cameraReleased:!streaming,bootId:'qa-realtime-pi',generation:1,width:1280,height:720,error:null});
async function piTick(){
  if(!streaming)return;
  const t=(performance.now()-piStarted)/1000;
  const shift=Math.round(((Math.abs((t*.85)%2-1)*2-1)*90)/10)*10;
  await pi.update(piImages.get(shift),true);
  if(streaming)piTimer=setTimeout(piTick,1000/15);
}
const piController={status,async command(command){
  if(command==='start'){streaming=true;piStarted=performance.now();await piTick();}
  else {streaming=false;clearTimeout(piTimer);pi.close();}
  return status();
}};
const errors=[];
const requestMetrics=[];
let publicFrame=await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg'));
if(realModel && expectedPeople===1)publicFrame=await sharp(publicFrame).composite([{input:await sharp({create:{width:640,height:720,channels:3,background:'#dcdcdc'}}).png().toBuffer(),left:640,top:0}]).jpeg({quality:90}).toBuffer();
const engine=realModel?await createInferenceEngine(resolve(root,'backend/models/classroom')):{ready:true,async detect(jpeg){
  const {data,info}=await sharp(jpeg).extract({left:0,top:6,width:400,height:1}).raw().toBuffer({resolveWithObject:true});
  let marker=130;
  for(let x=0;x<info.width;x++) if(data[x*info.channels+1]>160 && data[x*info.channels]<100 && data[x*info.channels+2]<100){marker=x;break;}
  const shift=marker-130;
  await delay(inferenceDelay);
  return [{cx:.242,cy:.532,width:.151,height:.366},{cx:.721,cy:.526,width:.137,height:.424}].map((box,i)=>({
    geometryId:i+1,personId:i+1,trackingState:'face',boxKind:'face',box:{x:box.cx-box.width/2+shift/1280,
      y:box.cy-box.height/2,width:box.width,height:box.height},
    observation:{valid:false,eyeAspectRatio:0,yawOffset:0,observedAt:Date.now()},
  }));
},async close(){}};
if(realModel){
  const nativeDetect=engine.detect.bind(engine);
  engine.detect=async(...args)=>{
    const started=performance.now();const output=await nativeDetect(...args);
    requestMetrics.push({ms:performance.now()-started,bytes:args[0].length,...engine.metrics});return output;
  };
}
if(!realModel){
  engine.detectFrame=async(jpeg)=>{
    const faces=await engine.detect(jpeg),at=Date.now();
    return {frameAt:at,people:faces.map(face=>({...face,faceBox:face.box,faceVisibility:'visible',boxKind:'person',
      box:{x:face.box.x,y:.1,width:.22,height:.85},personBox:{x:face.box.x,y:.1,width:.22,height:.85}})),
      objects:[{id:'O1',kind:'book',box:{x:faces[0].box.x+.3,y:.7,width:.12,height:.12},confidence:.9,trackedAt:at,observedAt:at,trackingState:'detected'}]};
  };
}
try {
  if(piMode){
    const original=await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg'));
    const marker=await sharp({create:{width:12,height:12,channels:3,background:'#00ff00'}}).png().toBuffer();
    for(let shift=-90;shift<=90;shift+=10){
      let image=sharp(original);
      if(shift)image=image.extract({left:Math.max(0,-shift),top:0,width:1280-Math.abs(shift),height:720})
        .extend({left:Math.max(0,shift),right:Math.max(0,-shift),top:0,bottom:0,background:'#dcdcdc'});
      piImages.set(shift,await image.composite([{input:marker,left:130+shift,top:4}]).jpeg({quality:90}).toBuffer());
    }
  }
  server=createServer(createApp({engine,pi,...(piMode?{piController}:{})}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const backend='http://127.0.0.1:'+server.address().port;
  process.env.BACKEND_URL=backend;
  vite=await createVite({root:resolve(root,'frontend'),cacheDir:resolve(root,'.qa/vite-realtime-cache'),logLevel:'error',optimizeDeps:{include:['motion/react']},plugins:[{
    name:'qa-realtime-video',configureServer(dev){dev.middlewares.use('/__qa/two.jpg',async(_request,response)=>{
      response.setHeader('Content-Type','image/jpeg');
      response.end(publicFrame);
    });},
  }],server:{host:'localhost',port:4313,strictPort:true,proxy:{'/api':{target:backend,changeOrigin:true}}}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.__transport={encoding:[],http:[]};
    const originalEncode=OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob=async function(...args){
      const started=performance.now();const blob=await originalEncode.apply(this,args);
      window.__transport.encoding.push(performance.now()-started);return blob;
    };
    const originalFetch=window.fetch;
    window.fetch=async(...args)=>{
      const started=performance.now();
      const response=await originalFetch(...args);
      if(/\/detect(?:\/pi)?$/.test(String(args[0])) && response.ok) {
        const data=await response.clone().json(),track=data.tracks.find(track=>track.id==='A');
        window.__rawBox=track?.displayBoxes?.face??track?.faceBox??track?.box;
        window.__responses=(window.__responses||0)+1;
        (window.__faceCounts??=[]).push(data.tracks.filter(track=>track.status==='visible').length);
        window.__transport.http.push(performance.now()-started);
      }
      return response;
    };
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
      const image=new Image();image.src='/__qa/two.jpg';await image.decode();
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const context=canvas.getContext('2d');const started=performance.now();
      function draw(){
        const t=(performance.now()-started)/1000;
        // Continuous motion with hard reversals, no constant-velocity shortcut.
        const shift=Math.round((Math.abs((t*.85)%2-1)*2-1)*95);
        context.fillStyle='#dcdcdc';context.fillRect(0,0,1280,720);
        context.drawImage(image,shift,0,1280,720);
        context.fillStyle='#00ff00';context.fillRect(130+shift,4,12,12);
        window.__videoTimer=setTimeout(draw,1000/30);
      }
      draw();return canvas.captureStream(30);
    }});
  });
  await page.goto('http://localhost:4313',{waitUntil:'networkidle'});
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:piMode?/Raspberry Pi 4/:/Webcam máy tính/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-face-id="face-A"] .face-frame'));
  await page.waitForTimeout(2000);
  const samples=await page.evaluate(()=>new Promise(resolve=>{
    const video=document.querySelector('.pi-video')??document.querySelector('video');
    const displayed=video;
    // Read only the marker's scanline. Full-frame GPU readback twice per RAF
    // would itself become the display bottleneck and invalidate the FPS test.
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true});const rows=[],started=performance.now();
    function measure(){
      const rect=document.querySelector('[data-face-id="face-A"] .face-frame'),raw=window.__rawBox;
      if(rect && raw && (displayed.videoWidth||displayed.naturalWidth)){
        context.drawImage(displayed,0,6,400,1,0,0,400,1);
        const pixels=context.getImageData(0,0,400,1).data;
        let marker;
        for(let x=0;x<400;x++) if(pixels[x*4+1]>160&&pixels[x*4]<100&&pixels[x*4+2]<100){marker=x;break;}
        if(marker!==undefined){
          const expected=.242+(marker-130)/1280;
          const center=(rect.x.baseVal.value+rect.width.baseVal.value/2)/rect.ownerSVGElement.width.baseVal.value;
          context.drawImage(video,0,6,400,1,0,0,400,1);
          const live=context.getImageData(0,0,400,1).data;let liveMarker;
          for(let x=0;x<400;x++)if(live[x*4+1]>160&&live[x*4]<100&&live[x*4+2]<100){liveMarker=x;break;}
          rows.push({at:performance.now(),marker,mediaTime:video.currentTime,error:Math.abs(center-expected)*1280,
            centerPx:center*1280,
            layerX:Object.fromEntries(['person','face','object'].map(kind=>[kind,Number(document.querySelector('.'+kind+'-frame')?.getAttribute('x'))])),
            rawAlignmentPx:Math.abs(center-(raw.x+raw.width/2))*1280,
            liveVideoMismatchPx:liveMarker===undefined?0:Math.abs(center-(.242+(liveMarker-130)/1280))*1280,
            response:window.__responses});
        }
      }
      if(rows.length>=360 || performance.now()-started>12000)resolve(rows);else requestAnimationFrame(measure);
    }requestAnimationFrame(measure);
  }));
  const mean=key=>samples.reduce((sum,row)=>sum+row[key],0)/samples.length;
  const errorsSorted=samples.map(row=>row.error).sort((a,b)=>a-b);
  const report={checkedAt:new Date().toISOString(),source:piMode?'pi-mjpeg':'browser-video',expectedPeople,note:realModel?'Public moving fixture, real AI models; not physical camera accuracy.':`Public moving fixture, ${inferenceDelay}ms artificial inference delay, actual displayed-video pixels; not physical-camera accuracy.`,
    samples:samples.length,pairedFrameUpdates:new Set(samples.map(row=>row.response)).size,
    meanErrorPx:mean('error'),meanRawAlignmentPx:mean('rawAlignmentPx'),meanUnsynchronizedVideoMismatchPx:mean('liveVideoMismatchPx'),p95ErrorPx:errorsSorted[Math.floor(errorsSorted.length*.95)],errors,
    requestMetrics,transport:await page.evaluate(()=>window.__transport),faceCounts:await page.evaluate(()=>window.__faceCounts),
    inferenceResponsesPerSecond:(new Set(samples.map(row=>row.response)).size-1)*1000/(samples.at(-1).at-samples[0].at),
    liveMarkerUpdates:samples.filter((row,index)=>index>0&&row.marker!==samples[index-1].marker).length,
    liveUpdatesWhileSameInference:samples.filter((row,index)=>index>0&&row.response===samples[index-1].response&&row.marker!==samples[index-1].marker).length,
    smoothUpdatesByLayer:Object.fromEntries(['person','face','object'].map(kind=>[kind,samples.filter((row,index)=>index>0&&row.response===samples[index-1].response&&Math.abs(row.layerX[kind]-samples[index-1].layerX[kind])>.01).length])),
    maximumFrameStepPx:Math.max(0,...samples.slice(1).map((row,index)=>Math.abs(row.centerPx-samples[index].centerPx))),
    latencyNote:'Video plays independently. SVG positions interpolate already completed AI results; no future AI or motion accuracy claim.'};
  const analysisHidden=await page.locator('.analysis-frame').evaluate(canvas=>canvas.hidden&&getComputedStyle(canvas).display==='none');
  report.trackingCriteriaPassed=report.pairedFrameUpdates>=3 && report.smoothUpdatesByLayer.face>=60 && report.maximumFrameStepPx<25 &&
    report.liveMarkerUpdates>=30 && report.liveUpdatesWhileSameInference>=15 && analysisHidden && errors.length===0;
  await mkdir(resolve(root,'.qa'),{recursive:true});
  await writeFile(resolve(root,realModel?`.qa/realtime-real-model-${expectedPeople}.json`:piMode?'.qa/realtime-tracking-pi.json':'.qa/realtime-tracking.json'),JSON.stringify({...report,trace:samples},null,2));
  assert(report.pairedFrameUpdates>=3,'AI must keep returning results: '+JSON.stringify(report));
  assert(report.trackingCriteriaPassed,'live video must advance while AI waits, without a visible analyzed-image canvas: '+JSON.stringify(report));
  if(realModel)assert(report.faceCounts.slice(4).every(count=>count===expectedPeople),'faces must remain present throughout movement');
  // Hold the next inference indefinitely. Live pixels and the pause button
  // must keep working; the last AI coordinates must remain unchanged.
  let unblock,intercepted;
  const blocked=new Promise(resolve=>intercepted=resolve),released=new Promise(resolve=>unblock=resolve);
  await page.route('**/api/sessions/*/detect',async route=>{intercepted();await released;await route.abort().catch(()=>{});});
  await blocked;
  const stall=await page.evaluate(()=>new Promise(resolve=>{
    const media=document.querySelector('.pi-video')??document.querySelector('video');
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true}),markers=[],started=performance.now();
    const signature=()=>JSON.stringify([...document.querySelectorAll('.face-frame,.person-frame,.object-frame')]
      .map(rect=>[rect.getAttribute('x'),rect.getAttribute('y'),rect.getAttribute('width'),rect.getAttribute('height'),rect.getAttribute('stroke')]));
    let settled;
    function sample(){
      context.drawImage(media,0,6,400,1,0,0,400,1);const pixels=context.getImageData(0,0,400,1).data;
      let marker;for(let x=0;x<400;x++)if(pixels[x*4+1]>160&&pixels[x*4]<100&&pixels[x*4+2]<100){marker=x;break;}
      markers.push(marker);
      if(performance.now()-started>=1500&&settled===undefined)settled=signature();
      if(performance.now()-started<3200)setTimeout(sample,50);
      else resolve({seconds:(performance.now()-started)/1000,distinctMarkers:new Set(markers).size,
        boxesUnchanged:signature()===settled,
        layers:Object.fromEntries(['person','face','object'].map(kind=>[kind,document.querySelectorAll('.'+kind+'-frame').length])),
        remainingBoxes:document.querySelectorAll('.face-frame,.person-frame,.object-frame').length});
    }sample();
  }));
  assert(stall.distinctMarkers>=10&&stall.remainingBoxes>0&&stall.boxesUnchanged,'video must move while pending AI boxes remain unchanged: '+JSON.stringify(stall));
  if(!realModel)assert(Object.values(stall.layers).every(count=>count>0),'all three independent overlay layers must survive stalled AI');
  report.stalledInference=stall;
  await writeFile(resolve(root,realModel?`.qa/realtime-real-model-${expectedPeople}.json`:piMode?'.qa/realtime-tracking-pi.json':'.qa/realtime-tracking.json'),JSON.stringify({...report,trace:samples},null,2));
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();
  unblock();
  assert.equal(await page.locator('.face-overlay').count(),0);
  assert(await page.locator('.analysis-frame').evaluate(canvas=>canvas.width===0&&canvas.hidden));
  if(piMode)assert.equal(streaming,true);
  else assert.equal(await page.locator('video').evaluate(video=>video.srcObject.getTracks()[0].readyState),'live');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(report,null,2));
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
} finally {
  streaming=false;clearTimeout(piTimer);pi.close();
  await browser?.close();await vite?.close();server?.closeAllConnections();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await engine.close();
}
