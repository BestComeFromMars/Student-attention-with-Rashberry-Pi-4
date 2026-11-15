// Unattended 1x virtual camera: production App, transport, API and native models.
// Only the media device is replaced. No source-time overrides, model serialization,
// seek/pause/replay while running, altered thresholds or prerecorded predictions.
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat,copyFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,extname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {loadEnvFile} from 'node:process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createInferenceEngine} from '../../backend/dist/inference.js';
import {InferenceRuntime} from '../../backend/dist/inference-runtime.js';
import {HistoryStore} from '../../backend/dist/history-store.js';
import {createApp} from '../../backend/dist/app.js';
import {localAIEnv} from '../../backend/local-ai-env.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const tagIndex=process.argv.indexOf('--tag');
const tag=tagIndex<0?'':process.argv[tagIndex+1];
const screencast=process.argv.includes('--screencast');
const recordOnly=process.argv.includes('--record-only');
const extraAILatency=Math.max(0,Number(option('--ai-delay-ms','0'))||0);
if(tag&&!/^[a-z0-9_-]+$/.test(tag))throw Error('Invalid output tag');
const source=resolve(option('--file',resolve(root,'backend/tests/videos/class_2.mp4')));
const sourceName=basename(source),sourceStem=basename(source,'.mp4');
if(!/^[a-zA-Z0-9_-]+\.mp4$/.test(sourceName))throw Error('Expected an MP4 source filename');
const results=resolve(option('--output',resolve(root,'backend/tests/test_results')));
const stem=sourceStem+'_realtime_'+Date.now()+(tag?'_'+tag:'');
const work=resolve(option('--work',resolve(root,'.qa',stem)));
const output=resolve(work,stem+'.mp4');
const published=resolve(results,sourceName);
assert.notEqual(source,output);assert.notEqual(source,published);
const sourceSha256=createHash('sha256').update(await readFile(source)).digest('hex');
await mkdir(resolve(work,'screens'),{recursive:true});
await mkdir(results,{recursive:true});
try{loadEnvFile(resolve(root,'backend/.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
delete process.env.AI_EXPORT_SERIAL_NATIVE;delete process.env.AI_EXPORT_VIDEO_TIMELINE;
const env=await localAIEnv(resolve(root,'backend'));
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=env.TEMP;
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const probe=spawnSync(python,['-c',"import cv2,json,sys;c=cv2.VideoCapture(sys.argv[1]);print(json.dumps(dict(fps=c.get(5),frames=int(c.get(7)))));c.release()",source],
  {env,windowsHide:true,encoding:'utf8'});
assert.equal(probe.status,0,probe.stderr);const sourceInfo=JSON.parse(probe.stdout);
// Match index.ts, including the startup wrapper that owns geometry forwarding.
const engine=new InferenceRuntime(signal=>createInferenceEngine(resolve(root,'backend/models/classroom'),signal));
await engine.start();
assert(engine.ready,engine.startupError??'Production AI runtime did not become ready');
const native=[],buffers=[],pixels=[],pixelBuffers=[],screens=[],writes=[],errors=[],apiFailures=[];
const observed=new Proxy(engine,{get(target,key){
  if(key==='trackFrame')return async(jpeg,context)=>{
    const row={frameId:context.frameId,capturedAt:context.capturedAt,start:Date.now(),index:pixels.length+1};pixels.push(row);pixelBuffers.push(jpeg);
    try{const result=await target.trackFrame(jpeg,context);row.end=Date.now();row.result=result;return result;}
    catch(error){row.end=Date.now();row.error=error.message;throw error;}
  };
  if(key==='detectFrame')return async(jpeg,context)=>{
    const index=native.length+1,start=Date.now();
    const row={index,start,bytes:jpeg.length,frameId:context?.frameId};native.push(row);buffers.push(jpeg);
    try{const result=await target.detectFrame(jpeg,context);
      if(extraAILatency)await new Promise(resolve=>setTimeout(resolve,extraAILatency));
      row.end=Date.now();row.ms=row.end-start;row.metrics={...target.metrics};
      row.people=result.people.map(person=>({geometryId:person.geometryId,personId:person.personId,box:person.box,
        trackingState:person.trackingState,faceVisibility:person.faceVisibility}));return result;}
    catch(error){row.end=Date.now();row.error=error.message;throw error;}
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
const history=new HistoryStore(resolve(work,'history'));
const app=createApp({engine:observed,history}),dist=resolve(option('--frontend-dist',resolve(root,'frontend/dist')));
async function serveVideo(request,response,path){
  const size=(await stat(path)).size,range=/^bytes=(\d+)-(\d*)/.exec(request.headers.range??'');
  const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;
  if(start>end){response.writeHead(416).end();return;}
  response.statusCode=range?206:200;response.setHeader('Content-Type','video/mp4');response.setHeader('Accept-Ranges','bytes');
  response.setHeader('Content-Length',end-start+1);if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
  const stream=createReadStream(path,{start,end});response.on('close',()=>stream.destroy());stream.pipe(response);
}
const server=createServer(async(request,response)=>{
  try{
    const path=new URL(request.url,'http://localhost').pathname;
    if(path.startsWith('/api/'))return app(request,response);
    if(path==='/__camera-source.mp4')return await serveVideo(request,response,source);
    if(path==='/__camera-result.mp4')return await serveVideo(request,response,output);
    const file=resolve(dist,'.'+(path==='/'?'/index.html':decodeURIComponent(path))),local=relative(dist,file);
    if(local.startsWith('..')||isAbsolute(local)){response.writeHead(403).end();return;}
    response.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]??'application/octet-stream'});
    response.end(await readFile(file));
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
  args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--autoplay-policy=no-user-gesture-required']});
let browser,cdp,finished=false,metadata;
try{
  browser=await launch();const page=await browser.newPage({viewport:{width:1920,height:1200},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.url().includes('/detect')&&!response.ok())apiFailures.push({status:response.status(),at:Date.now()});});
  let endReplay;const ended=new Promise(resolve=>endReplay=resolve);
  await page.exposeBinding('__notifyCameraReplayEnd',(_context,data)=>endReplay(data));
  await page.addInitScript(({sourceName,sourceStem,sourceInfo})=>{
    const trace=window.__cameraReplay={requests:[],mediaEvents:[],overlaySamples:[],previewFrames:[],pixelFrames:[],startedAt:null,endedAt:null};
    document.addEventListener('pixelpresented',event=>{
      if(trace.startedAt===null||trace.endedAt!==null)return;
      trace.pixelFrames.push({...event.detail,at:Date.now(),sourceSeconds:window.__cameraSource.currentTime,
        response:trace.lastCompletedResponse??0});
    });
    // Passive observation only; never touch playback, models, settings or UI.
    setInterval(()=>{
      if(trace.startedAt===null||trace.endedAt!==null)return;
      const nodes=[...document.querySelectorAll('.person-frame,.face-frame,.object-frame')];
      const labels=[...document.querySelectorAll('.observation-label')];
      const captionsPinned=labels.every(label=>{
        const [kind,id]=label.dataset.anchorFrame?.split(':')??[];
        if(!kind||!id)return false;
        const box=document.querySelector(`[data-${kind}-id="${CSS.escape(id)}"] > rect`);
        const viewport=label.parentElement.closest('svg');if(!box||!viewport)return false;
        const read=(node,key)=>Number(node.getAttribute(key));
        const x=read(box,'x'),y=read(box,'y'),right=x+read(box,'width'),w=read(label,'width'),h=read(label,'height');
        const expectedX=Math.max(0,Math.min(right-w,read(viewport,'width')-w));
        const expectedY=Math.max(0,Math.min(y>=h?y-h:y,read(viewport,'height')-h));
        return Math.abs(read(label,'x')-expectedX)<.6&&Math.abs(read(label,'y')-expectedY)<.6;
      });
      const analysis=document.querySelector('.analysis-frame');
      trace.overlaySamples.push({at:Date.now(),sourceSeconds:window.__cameraSource.currentTime,boxes:nodes.length,
        people:document.querySelectorAll('.person-frame').length,faces:document.querySelectorAll('.face-frame').length,
        objects:document.querySelectorAll('.object-frame').length,captionsPinned,
        captionEntranceDisabled:labels.every(label=>{const style=getComputedStyle(label);return style.animationName==='none'&&Number.parseFloat(style.transitionDuration)===0;}),
        analysisVisible:Boolean(analysis&&!analysis.hidden&&getComputedStyle(analysis).display!=='none'),
        solid:nodes.every(node=>getComputedStyle(node).strokeDasharray==='none'),
        readable:nodes.every(node=>Number.parseFloat(getComputedStyle(node).strokeWidth)>=1.5)});
    },100);
    const fetchOriginal=window.fetch.bind(window);
    window.fetch=async(resource,options)=>{
      const url=typeof resource==='string'?resource:resource.url;
      if(options?.method!=='POST'||!/\/api\/sessions\/[^/]+\/detect$/.test(url))return fetchOriginal(resource,options);
      if(trace.startedAt===null){
        trace.startedAt=Date.now();trace.startedPerf=performance.now();
        const preview=document.querySelector('video[aria-label="Video trực tiếp từ webcam"]');
        const sample=(at,metadata)=>{
          if(trace.endedAt!==null)return;
          const boxes=Object.fromEntries(['person','face','object'].map(kind=>{
            const rect=document.querySelector('.'+kind+'-frame');
            return [kind,rect?{id:rect.parentElement.getAttribute('data-'+kind+'-id'),
              x:Number(rect.getAttribute('x')),y:Number(rect.getAttribute('y'))}:null];
          }));
          trace.previewFrames.push({at:Date.now(),mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,
            response:trace.lastCompletedResponse??0,boxes});
          preview.requestVideoFrameCallback(sample);
        };
        preview.requestVideoFrameCallback(sample);
        void window.__cameraSource.play();
      }
      const row={index:trace.requests.length+1,start:Date.now(),sourceSeconds:window.__cameraSource.currentTime,
        frameId:Number(new Headers(options?.headers).get('X-Frame-Id'))||undefined};trace.requests.push(row);
      try{
        const response=await fetchOriginal(resource,options);
        row.status=response.status;
        row.data=await response.clone().json().catch(()=>null);
        row.completedSourceSeconds=window.__cameraSource.currentTime;
        row.end=Date.now();
        trace.lastCompletedResponse=row.index;
        return response;
      }catch(error){row.end=Date.now();row.error=error.message;throw error;}
    };
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:sourceStem+'-virtual-camera',label:sourceName+' — camera giả lập',groupId:'replay'}],
      addEventListener(){},removeEventListener(){},getUserMedia:async()=>{
        if(window.__cameraSource)throw Error('Only one virtual camera may be opened');
        const source=document.createElement('video');source.id='virtual-camera-source';source.muted=true;source.playsInline=true;source.preload='auto';source.loop=false;
        source.style.cssText='position:fixed;left:-10000px;width:2px;height:2px;';document.body.append(source);window.__cameraSource=source;
        await new Promise((resolve,reject)=>{source.onloadeddata=resolve;source.onerror=()=>reject(Error('Cannot decode source MP4'));source.src='/__camera-source.mp4';});
        trace.source={width:source.videoWidth,height:source.videoHeight,duration:source.duration,playbackRate:source.playbackRate,...sourceInfo};
        // A native media stream keeps decoded frames on the browser video
        // pipeline. A canvas round-trip added a main-thread copy and dropped
        // frames even though AI and playback were already independent.
        const captured=source.captureStream();
        const stream=new MediaStream(captured.getVideoTracks());
        captured.getAudioTracks().forEach(track=>track.stop());
        for(const name of ['playing','waiting','stalled','pause','seeking','seeked','ended','ratechange'])source.addEventListener(name,()=>trace.mediaEvents.push({name,at:Date.now(),sourceSeconds:source.currentTime,playbackRate:source.playbackRate}));
        source.onended=()=>{
          trace.endedAt=Date.now();const quality=source.getVideoPlaybackQuality();
          trace.playbackQuality={totalVideoFrames:quality.totalVideoFrames,droppedVideoFrames:quality.droppedVideoFrames};
          const preview=document.querySelector('video[aria-label="Video trực tiếp từ webcam"]').getVideoPlaybackQuality();
          trace.previewPlaybackQuality={totalVideoFrames:preview.totalVideoFrames,droppedVideoFrames:preview.droppedVideoFrames};
          void window.__notifyCameraReplayEnd({startedAt:trace.startedAt,endedAt:trace.endedAt});
        };
        for(const track of stream.getTracks()){
          // The test clip ending is not a hardware-camera disconnection. Keep
          // the production camera lifecycle open until post-playback cleanup.
          const listen=track.addEventListener.bind(track);
          track.addEventListener=(type,listener,options)=>{if(type!=='ended')listen(type,listener,options);};
          const stop=track.stop.bind(track);track.stop=()=>{source.pause();stop();};
        }
        return stream;
      },
    }});
  },{sourceName,sourceStem,sourceInfo});
  await page.goto(origin);
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option').filter({hasText:sourceName}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).waitFor();
  await page.getByRole('button',{name:'Phóng to camera',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video[aria-label="Video trực tiếp từ webcam"]')?.readyState>=2);
  await page.waitForTimeout(400);
  const crop=await page.locator('.video-viewport').boundingBox();assert(crop?.width>200&&crop.height>200);
  if(screencast){
  cdp=await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame',event=>{
    const index=screens.length+1,file=String(index).padStart(6,'0')+'.jpg';
    const timestamp=event.metadata.timestamp*1000;
    screens.push({file,at:Number.isFinite(timestamp)&&Math.abs(timestamp-Date.now())<10000?timestamp:Date.now()});
    writes.push(writeFile(resolve(work,'screens',file),Buffer.from(event.data,'base64')));
    void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
  });
  await cdp.send('Page.startScreencast',{format:'jpeg',quality:90,maxWidth:1920,maxHeight:1200,everyNthFrame:1});
  }
  const sourceDuration=await page.evaluate(()=>window.__cameraSource.duration);
  console.log(sourceName+': starting unattended 1x camera replay; no interaction until playback ends');
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  const timer=setInterval(()=>{const last=native.at(-1);console.log(`Realtime: ${native.length} submitted | last inference ${last?.ms??'running'} ms | screens ${screens.length}`);},5000);
  try{
    let timeout;
    try{await Promise.race([ended,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('Virtual camera playback timed out')),Math.max(120000,(sourceDuration+30)*1000)))]);}
    finally{clearTimeout(timeout);}
  }finally{clearInterval(timer);}
  await cdp?.send('Page.stopScreencast');await Promise.all(writes);
  const trace=await page.evaluate(()=>JSON.parse(JSON.stringify(window.__cameraReplay)));
  const style=await page.locator('.person-frame,.face-frame,.object-frame').evaluateAll(nodes=>({boxes:nodes.length,
    solid:nodes.every(node=>getComputedStyle(node).strokeDasharray==='none'),readable:nodes.every(node=>Number.parseFloat(getComputedStyle(node).strokeWidth)>=1.5)}));
  const sourceUnchanged=sourceSha256===createHash('sha256').update(await readFile(source)).digest('hex');
  assert(sourceUnchanged,'Input video must remain unchanged throughout the test');
  metadata={complete:false,sourcePath:source,sourceSha256,sourceUnchanged,
    ...trace,crop,screens,style,capabilities:engine.capabilities,errors,apiFailures,
    extraAILatencyMs:extraAILatency,
    exportMode:screencast?'screencast':'native_source_frames_current_pixel_tracking_and_completed_live_AI',
    mode:'Production frontend and HTTP API; media-element captureStream plays the original MP4 once at 1x. Current-pixel geometry runs separately from semantic AI. Image and geometry share a frame ID and presentation commit. No source-time override, threshold edits or manual interaction during playback. Not a physical webcam/Pi test.'};
  await page.screenshot({path:resolve(work,'interface.png')});
  const framesDirectory=resolve(work,'actual_uploads');await mkdir(framesDirectory,{recursive:true});
  await Promise.all(buffers.map((buffer,index)=>writeFile(resolve(framesDirectory,String(index+1).padStart(6,'0')+'.jpg'),buffer)));
  const pixelDirectory=resolve(work,'pixel_uploads');await mkdir(pixelDirectory,{recursive:true});
  await Promise.all(pixelBuffers.map((buffer,index)=>writeFile(resolve(pixelDirectory,String(index+1).padStart(6,'0')+'.jpg'),buffer)));
  // Playback is finished. These are cleanup actions, never changes during it.
  const stopButton=page.getByRole('button',{name:'Tắt camera',exact:true});
  if(await stopButton.count())await stopButton.click();
  await browser.close();browser=null;await engine.close();
  metadata.native=native;metadata.pixels=pixels;metadata.complete=true;
  await writeFile(resolve(work,'recording.json'),JSON.stringify(metadata,null,2));
  if(!recordOnly){
  const encoder=spawn(screencast?python:process.execPath,
    [resolve(root,screencast?'backend/ai/encode_realtime_capture.py':'frontend/scripts/render-decision-video.mjs'),'--work',work,'--output',output],
    {cwd:root,env,windowsHide:true,stdio:'inherit'});
  await new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('exit',code=>code===0?resolve():reject(Error('Encoder exited '+code)));});
  browser=await launch();const check=await browser.newPage();await check.goto(origin);
  const decoded=await check.evaluate(async()=>{
    const video=document.createElement('video');video.muted=true;video.preload='auto';
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('Cannot play output MP4'));video.src='/__camera-result.mp4';});
    return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};
  });
  assert.equal(decoded.width,metadata.source.width);assert.equal(decoded.height,metadata.source.height);
  const verified=JSON.parse(await readFile(resolve(work,'encoded.json'),'utf8'));
  assert(Math.abs(decoded.duration-verified.durationSeconds)<.15);
  const evaluator=spawn(python,[resolve(root,'backend/ai/evaluate_realtime_replay.py'),'--work',work],
    {cwd:root,env,windowsHide:true,stdio:'inherit'});
  await new Promise((yes,no)=>{evaluator.once('error',no);evaluator.once('exit',code=>code===0?yes():no(Error('Coverage evaluator exited '+code)));});
  const coverage=JSON.parse(await readFile(resolve(work,'coverage.json'),'utf8'));
  const completed=trace.requests.filter(row=>row.status===200&&row.end<=trace.endedAt),latencies=completed.map(row=>row.end-row.start).sort((a,b)=>a-b);
  const visible=row=>row.data.tracks.filter(track=>track.status==='visible');
  const firstVisible=completed.find(row=>visible(row).length>0);
  const lastVisible=completed.findLast(row=>visible(row).length>0);
  const sustainedZero=lastVisible?completed.find(row=>row.index>lastVisible.index&&visible(row).length===0):null;
  let longestZeroMs=0,zeroStart=null;
  for(const row of completed.filter(row=>firstVisible&&row.index>=firstVisible.index)){
    if(visible(row).length===0){zeroStart??=row.end;}
    else if(zeroStart!==null){longestZeroMs=Math.max(longestZeroMs,row.end-zeroStart);zeroStart=null;}
  }
  if(zeroStart!==null)longestZeroMs=Math.max(longestZeroMs,trace.endedAt-zeroStart);
  const painted=trace.overlaySamples.filter(row=>row.boxes>0);
  const paintedStyle={boxes:Math.max(0,...painted.map(row=>row.boxes)),solid:painted.every(row=>row.solid),
    readable:painted.every(row=>row.readable),verified:painted.length>0,sampledAt:'throughout_playback',samples:trace.overlaySamples.length};
  const submittedWithinVideo=native.filter(row=>row.start<=trace.endedAt);
  const interventions=trace.mediaEvents.filter(event=>['seeking','seeked'].includes(event.name)||
    event.name==='pause'&&event.sourceSeconds<trace.source.duration-.02||
    event.name==='ratechange'&&event.playbackRate!==1);
  assert.equal(interventions.length,0,'source must play once at 1x without pausing or seeking');
  const frameGaps=trace.previewFrames.slice(1).map((frame,index)=>frame.at-trace.previewFrames[index].at).sort((a,b)=>a-b);
  const advancingDuringAI=completed.map(row=>({request:row.index,frames:trace.previewFrames.filter(frame=>frame.at>=row.start&&frame.at<=row.end).length}));
  const smoothUpdatesByLayer=Object.fromEntries(['person','face','object'].map(kind=>[kind,
    trace.previewFrames.slice(1).filter((frame,index)=>{
      const before=trace.previewFrames[index],a=before.boxes?.[kind],b=frame.boxes?.[kind];
      return frame.response===before.response&&a&&b&&a.id===b.id&&Math.hypot(a.x-b.x,a.y-b.y)>.01;
    }).length]));
  const report={complete:true,video:published,source,sourceDurationSeconds:trace.source.duration,
    sourceFPS:sourceInfo.fps,smoothUpdatesByLayer,
    sourceSha256,sourceUnchanged,coverage,
    continuity:coverage.continuity,
    sourcePlaybackQuality:trace.playbackQuality,previewPlaybackQuality:trace.previewPlaybackQuality,
    replaySeconds:(trace.endedAt-trace.startedAt)/1000,playbackRate:trace.source.playbackRate,
    submitted:submittedWithinVideo.length,postPlaybackCleanupRequests:native.length-submittedWithinVideo.length,
    completedWithinVideo:completed.length,inferenceResponsesPerSecond:completed.length/((trace.endedAt-trace.startedAt)/1000),
    preview:{visibleAnalysisCanvas:trace.overlaySamples.some(sample=>sample.analysisVisible),sampledFrames:trace.previewFrames.length,
      presentedFramesPerSecond:trace.previewFrames.length>1?
        (trace.previewFrames.at(-1).presentedFrames-trace.previewFrames[0].presentedFrames)*1000/
        (trace.previewFrames.at(-1).at-trace.previewFrames[0].at):0,
      longestSampleGapMs:Math.max(0,...trace.previewFrames.slice(1).map((frame,index)=>frame.at-trace.previewFrames[index].at))},
    previewFrameGapP95Ms:frameGaps[Math.floor(frameGaps.length*.95)]??null,
    previewFramesDuringAI:advancingDuringAI,
    firstVisibleAtSeconds:firstVisible?(firstVisible.end-trace.startedAt)/1000:null,
    sustainedVisibleLossAtSeconds:sustainedZero?(sustainedZero.end-trace.startedAt)/1000:null,
    zeroVisibleResponsesAfterFirstDetection:completed.filter(row=>firstVisible&&row.index>firstVisible.index&&visible(row).length===0).length,
    longestZeroVisibleSeconds:longestZeroMs/1000,
    minimumVisiblePeopleAfterFirstDetection:firstVisible?Math.min(...completed.filter(row=>row.index>=firstVisible.index).map(row=>visible(row).length)):0,
    functionalOutcome:!firstVisible?'no_people_detected':longestZeroMs>1000?'lost_visible_people':'continuous_detection_observed',
    p50ResponseMs:latencies[Math.floor(latencies.length*.5)]??null,p95ResponseMs:latencies[Math.floor(latencies.length*.95)]??null,
    maximumVisiblePeople:Math.max(0,...completed.map(row=>visible(row).length)),
    maximumVisibleFaces:Math.max(0,...completed.map(row=>visible(row).filter(track=>track.faceVisibility!=='unavailable'&&(track.faceBox||track.boxKind==='face')).length)),
    maximumVisibleObjects:Math.max(0,...completed.map(row=>(row.data.objects??[]).length)),
    objectKinds:[...new Set(completed.flatMap(row=>(row.data.objects??[]).map(object=>object.kind)))],
    renderedBoxLayers:Object.fromEntries(['people','faces','objects'].map(kind=>[kind,{
      maximum:Math.max(0,...trace.overlaySamples.map(row=>row[kind])),samplesWithBoxes:trace.overlaySamples.filter(row=>row[kind]>0).length}])),
    maximumPeopleWithPose:Math.max(0,...completed.map(row=>visible(row).filter(track=>track.observation?.bodyPose).length)),
    peakPrivateMemoryMB:Math.max(0,...native.filter(row=>row.end<=trace.endedAt).map(row=>row.metrics?.privateMemoryMB??0)),
    warningTypes:[...new Set(completed.flatMap(row=>visible(row).flatMap(track=>(track.alerts??[]).map(alert=>alert.type))))],
    modelErrors:native.filter(row=>row.end<=trace.endedAt).flatMap(row=>row.error?[row.error]:Object.entries(row.metrics??{}).filter(([key,value])=>key.endsWith('Error')&&value).map(([key,value])=>`${key}: ${value}`)),
    frontendErrors:errors,apiFailures:apiFailures.filter(row=>row.at<=trace.endedAt),
    browserPlaybackVerified:true,encoded:verified,style:paintedStyle,endOfPlaybackStyle:style,mode:metadata.mode,
    unattendedPlaybackVerified:interventions.length===0,mediaEvents:trace.mediaEvents,
    exportMode:metadata.exportMode,
    composedPreview:{frames:trace.pixelFrames.length,fps:trace.pixelFrames.length/((trace.endedAt-trace.startedAt)/1000),
      nativeFrameRatio:trace.pixelFrames.length/Math.max(1,trace.previewFrames.length),
      p95PresentationMs:trace.pixelFrames.map(f=>f.presentedAt-f.capturedAt).sort((a,b)=>a-b)[Math.floor(trace.pixelFrames.length*.95)]},
    caveat:screencast?'Actual frontend screencast; MP4 frame count is not the number of AI inferences.':
      'Live composed FPS is measured separately. Export retains every original frame/PTS and replays only current-pixel tracking with the actually completed live AI decisions. No future AI, geometry interpolation or new behavior inference.'};
  report.checks={
    inputUnchanged:sourceUnchanged,unattended1xPlayback:interventions.length===0,
    threeBoxLayersRendered:Object.values(report.renderedBoxLayers).every(layer=>layer.maximum>0),
    cameraAtLeast25FPS:report.preview.presentedFramesPerSecond>=25,
    cameraMaintainsSourceFPS:report.preview.presentedFramesPerSecond>=sourceInfo.fps*.98,
    everyPresentedBoxMatchesItsImage:trace.pixelFrames.length>0&&trace.pixelFrames.every(frame=>frame.frameId===frame.geometryFrameId),
    composedKeepsNativeCameraCadence:report.composedPreview.nativeFrameRatio>=.98,
    composedPresentationWithin120ms:report.composedPreview.p95PresentationMs<=120,
    outputMaintainsEverySourceFrameAndTimestamp:verified.allSourceFramesPreserved&&verified.nativeFpsPreserved&&verified.frameTimestampMaxErrorMs<=.1,
    cameraAdvancesWhileAIWaits:advancingDuringAI.some(row=>row.frames>=2),
    analysisImageHidden:!report.preview.visibleAnalysisCanvas,
    noModelOrAPIErrors:report.modelErrors.length===0&&report.apiFailures.length===0,
    noFrontendErrors:report.frontendErrors.length===0,
    captionsStayAtBoxCorner:painted.length>0&&painted.every(sample=>sample.captionsPinned),
    noCaptionEntranceAnimations:painted.length>0&&painted.every(sample=>sample.captionEntranceDisabled),
    noBoxLayerDisappearsAfterFirstDetection:Object.values(coverage.continuity).every(layer=>layer.firstAtSeconds!==null&&layer.emptyResponsesAfterFirst===0),
  };
  assert(report.checks.captionsStayAtBoxCorner,'Captions detached from their box corner during playback');
  assert(report.checks.noCaptionEntranceAnimations,'Captions must appear in place without entrance effects');
  if(/^class_[1-7]$/.test(sourceStem))assert(report.checks.threeBoxLayersRendered,'Classroom replay must contain person, face and object geometry');
  assert(report.checks.noModelOrAPIErrors,'Model/API errors cannot be accepted as a successful replay');
  await writeFile(resolve(work,'report.json'),JSON.stringify(report,null,2));
  await copyFile(output,published);
  console.log(JSON.stringify({video:published,report:resolve(work,'report.json'),checks:report.checks,
    preview:report.preview,aiResponses:report.completedWithinVideo,p50ResponseMs:report.p50ResponseMs,p95ResponseMs:report.p95ResponseMs,
    smoothUpdatesByLayer,renderedBoxLayers:report.renderedBoxLayers,capturedCoverage:coverage.capturedAI.totals,liveCoverage:coverage.displayedOverLiveVideo.totals}));finished=true;
  }else{
    const frames=trace.pixelFrames,elapsed=(trace.endedAt-trace.startedAt)/1000;
    const threeLayers=['person:','face:','object:'].every(kind=>frames.some(frame=>frame.boxes.some(box=>box.key.startsWith(kind))));
    const report={work,complete:true,sourceUnchanged,sourceFPS:sourceInfo.fps,elapsed,threeLayers,
      presentedFrames:frames.length,composedFPS:frames.length/elapsed,aiResponses:trace.requests.filter(row=>row.status===200).length,
      sameFrame:frames.length>0&&frames.every(frame=>frame.frameId===frame.geometryFrameId),
      errors,apiFailures:apiFailures.filter(row=>row.at<=trace.endedAt),pixelErrors:pixels.filter(row=>row.error),
      p95GeometryMs:frames.map(frame=>frame.processingMs).sort((a,b)=>a-b)[Math.floor(frames.length*.95)],
      p95PresentationMs:frames.map(frame=>frame.presentedAt-frame.capturedAt).sort((a,b)=>a-b)[Math.floor(frames.length*.95)]};
    await writeFile(resolve(work,'pixel-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    if(/^class_[1-7]$/.test(sourceStem))assert(threeLayers,'Classroom replay must contain person, face and object geometry');
    assert(errors.length===0&&report.apiFailures.length===0,'Replay frontend/API failed');finished=true;
  }
}finally{
  if(!finished&&metadata)await writeFile(resolve(work,'partial-recording.json'),JSON.stringify({...metadata,native},null,2));
  await browser?.close();await engine.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
