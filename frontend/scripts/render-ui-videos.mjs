import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,copyFile,unlink,rmdir,mkdir,open,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';

const root=fileURLToPath(new URL('../../',import.meta.url));
const argv=process.argv.slice(2),option=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};
const work=resolve(option('--work',resolve(root,'.qa/video-export-ui')));
const temporary=resolve(work,'.tmp');await mkdir(temporary,{recursive:true});
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=temporary;
const output=resolve(option('--output',resolve(root,'backend/tests/videos_detected')));
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const requested=option('--files',null);
const files=requested?requested.split(','):Array.from({length:7},(_,i)=>'class_'+(i+1));
if(files.some(name=>! /^[a-zA-Z0-9_-]+$/.test(name)))throw Error('Invalid video name');
const overlayUpdated=Math.max(...await Promise.all(['frontend/src/components/FaceOverlay.tsx','frontend/src/components/ObjectOverlay.tsx',
  'frontend/src/components/PersonOverlay.tsx','frontend/src/components/OverlayLabel.tsx','frontend/src/lib/activity.ts','frontend/dev/export-video.tsx',
  'frontend/src/styles.css','frontend/src/lib/attention.ts'].map(async path=>(await stat(resolve(root,path))).mtimeMs)));
let vite,browser;
const errors=[],reports=[];
const deadline=async(promise,ms)=>{let timer;try{return await Promise.race([promise,
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser frame timed out')),ms);})]);}finally{clearTimeout(timer);}};
try{
  vite=await createServer({configFile:false,root:resolve(root,'frontend'),cacheDir:resolve(work,'vite-cache'),
    logLevel:'error',plugins:[react(),{name:'actual-video-overlays',configureServer(server){
      server.middlewares.use(async(req,res,next)=>{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/__export'){
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/dev/export-video.tsx"></script></body></html>'));return;
        }
        const match=/^\/__frames\/([a-zA-Z0-9_-]+)\/(\d{6})\.jpg$/.exec(url.pathname);
        if(match&&files.includes(match[1])){try{res.setHeader('Content-Type','image/jpeg');res.end(await readFile(resolve(work,match[1]+'_input_frames',match[2]+'.jpg')));}catch{res.statusCode=404;res.end();}return;}
        const video=/^\/__videos\/([a-zA-Z0-9_-]+)\.mp4$/.exec(url.pathname);
        if(video&&files.includes(video[1])){try{
          const path=resolve(output,video[1]+'.mp4'),size=(await stat(path)).size;
          const range=/^bytes=(\d+)-(\d*)/.exec(req.headers.range??'');
          const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;
          if(start>end){res.statusCode=416;res.end();return;}
          res.statusCode=range?206:200;res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
          res.setHeader('Content-Length',end-start+1);if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
          const stream=createReadStream(path,{start,end});res.on('close',()=>stream.destroy());stream.pipe(res);
        }catch{res.statusCode=404;res.end();}return;}
        next();
      });
    }}],server:{host:'127.0.0.1',port:0}});
  await vite.listen();const address=vite.httpServer.address(),origin='http://127.0.0.1:'+address.port;
  const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--disable-gpu','--renderer-process-limit=1']});
  browser=await launch();
  await mkdir(output,{recursive:true});
  for(const stem of requested?files:[files[5],files[6],...files.slice(0,5)]){
    const info=JSON.parse(await readFile(resolve(work,stem+'_inference.json'),'utf8'));
    if(!info.predictionsComplete)throw Error(stem+': incomplete inference');
    const inputUpdated=Math.max(overlayUpdated,(await stat(resolve(work,stem+'_inference.json'))).mtimeMs);
    try{
      const verified=JSON.parse(await readFile(resolve(work,stem+'_ui_verified.json'),'utf8'));
      const target=await stat(resolve(output,stem+'.mp4'));
      if(target.mtimeMs>=inputUpdated&&target.size>1000&&verified.frames===info.frames&&verified.width===info.width&&verified.height===info.height){
        reports.push({video:stem+'.mp4',...verified,source:resolve(output,stem+'.mp4')});
        console.log(stem+': keeping completed, fully decoded UI video');continue;
      }
    }catch{}
    let overlayState=null;
    const openRenderPage=async()=>{
      const page=await browser.newPage({viewport:{width:info.width,height:info.height},deviceScaleFactor:1});
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+`/__export?width=${info.width}&height=${info.height}`);
      await page.waitForFunction(()=>window.exportReady===true);
      if(overlayState)await page.evaluate(state=>window.restoreExportOverlayState(state),overlayState);
      const cdp=await page.context().newCDPSession(page);
      await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
      return {page,cdp};
    };
    let {page,cdp}=await openRenderPage();
    const rendered=resolve(work,stem+'_ui_frames');await mkdir(rendered,{recursive:true});
    const reader=await open(resolve(work,stem+'_predictions.jsonl'));
    let frame=0,done=false,lastProgress=0;
    const labelFrames=[];
    try{
      for await(const line of reader.readLines()){
        const prediction=JSON.parse(line);frame++;
        if(prediction.frame!==frame)throw Error('Missing source frame');
        const framePath=resolve(rendered,String(frame).padStart(6,'0')+'.jpg');
        let screenshot,snapshot;
        for(let attempt=0;attempt<3;attempt++){
        try{
        snapshot=await deadline(page.evaluate(async({prediction,url})=>window.renderExportFrame({image:url,tracks:prediction.tracks,objects:prediction.objects}),
          {prediction,url:`/__frames/${stem}/${String(prediction.imageFrame??frame).padStart(6,'0')}.jpg`}),10000);
        overlayState=snapshot.layout;
        for(const track of prediction.tracks.filter(track=>track.personBox&&track.status==='visible')){
          const label=snapshot.labels[track.id],box=track.displayBoxes?.person??track.personBox;
          if(label){
            const x=Math.max(0,Math.min((box.x+box.width)*info.width-label.width,info.width-label.width));
            const y=Math.max(0,Math.min(box.y*info.height>=label.height?box.y*info.height-label.height:box.y*info.height,info.height-label.height));
            if(Math.abs(label.x-x)>.1||Math.abs(label.y-y)>.1)throw Error('Person label must stay at the body top right');
          }
        }
        if(errors.length)throw Error(errors.join('\n'));
        if(frame===1||frame===Math.floor(info.frames/2)){
          const drawn=await page.evaluate(()=>({
            dashed:[...document.querySelectorAll('.person-frame,.face-frame,.object-frame')]
              .filter(rect=>getComputedStyle(rect).strokeDasharray!=='none').length,
            thin:[...document.querySelectorAll('.person-frame,.face-frame,.object-frame')]
              .filter(rect=>Number.parseFloat(getComputedStyle(rect).strokeWidth)<1.5).length,
            unreadable:[...document.querySelectorAll('.observation-label text')].filter(node=>{
              const style=getComputedStyle(node);return Number.parseFloat(style.fontSize)<13||!['rgb(248, 250, 252)','rgb(226, 232, 240)'].includes(style.fill);
            }).length,
            warnings:[...document.querySelectorAll('.observation-label')].filter(node=>node.dataset.warning==='true')
              .map(node=>getComputedStyle(node.querySelector('rect')).fill),
            people:[...document.querySelectorAll('.person-frame')].map(rect=>({id:rect.closest('[data-person-id]').dataset.personId,
              x:rect.x.baseVal.value,y:rect.y.baseVal.value,width:rect.width.baseVal.value,height:rect.height.baseVal.value})),
            faces:[...document.querySelectorAll('.face-frame')].map(rect=>({id:rect.closest('[data-face-id]').dataset.faceId,
              x:rect.x.baseVal.value,y:rect.y.baseVal.value,width:rect.width.baseVal.value,height:rect.height.baseVal.value})),
            objects:[...document.querySelectorAll('.object-frame')].map(rect=>({id:rect.closest('[data-object-id]').dataset.objectId,
              x:rect.x.baseVal.value,y:rect.y.baseVal.value,width:rect.width.baseVal.value,height:rect.height.baseVal.value})),
          }));
          if(drawn.dashed)throw Error('Bounding boxes must use solid strokes');
          if(drawn.thin||drawn.unreadable||drawn.warnings.some(fill=>fill!=='rgb(127, 29, 29)'))
            throw Error('Overlay must use readable solid boxes, compact light text and red warning backgrounds');
          const faces=prediction.tracks.filter(t=>t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face')&&t.trackingState!=='predicted'&&
            (t.status==='visible'||t.trackingState==='body'||t.trackingState==='coasting')).map(t=>({...t,box:t.displayBoxes?.face??t.faceBox??t.box}));
          const people=prediction.tracks.filter(t=>t.personBox&&t.status==='visible').map(t=>({...t,box:t.displayBoxes?.person??t.personBox}));
          const objects=prediction.objects.map(object=>({...object,box:object.displayBox??object.box}));
          for(const [actual,expected,prefix]of [[drawn.people,people,''],[drawn.faces,faces,'face-'],[drawn.objects,objects,'']]){
            if(actual.length!==expected.length)throw Error('UI did not paint all supported boxes');
            for(const item of expected){
              const box=actual.find(rect=>rect.id===prefix+item.id);
              if(!box||['x','y','width','height'].some(key=>Math.abs(box[key]-item.box[key]*(key==='x'||key==='width'?info.width:info.height))>.1))
                throw Error('UI bbox does not match the analyzed source frame');
            }
          }
        }
        // This is a screenshot of the actual React SVG components and CSS;
        // no separate renderer reimplements their coordinates/labels/colors.
        screenshot=await page.screenshot({type:'jpeg',quality:95,animations:'disabled',timeout:15000});
        break;
        }catch(error){
          if(attempt===2)throw error;
          await page.close();await browser.close();browser=await launch();({page,cdp}=await openRenderPage());
        }
        }
        await writeFile(framePath,screenshot);
        labelFrames.push({frame,labels:snapshot.labels,baseline:snapshot.baseline});
        if(frame%30===0)await cdp.send('HeapProfiler.collectGarbage');
        if(frame===Math.floor(info.frames/2))await writeFile(resolve(work,stem+'_ui_preview.jpg'),screenshot);
        if(Date.now()-lastProgress>5000||frame===info.frames){console.log(`${stem}: actual UI ${frame}/${info.frames}`);lastProgress=Date.now();}
        if(frame%100===0&&frame<info.frames){
          // Saved model identities/states stay continuous; only the disposable
          // browser renderer is recycled to bound native image-cache memory.
          await page.close();await browser.close();browser=await launch();
          ({page,cdp}=await openRenderPage());
        }
      }
      if(frame!==info.frames)throw Error('Incomplete prediction stream');
      await writeFile(resolve(work,stem+'_label_positions.jsonl'),labelFrames.map(row=>JSON.stringify(row)).join('\n')+'\n');
      done=true;
    }finally{await reader.close();await page.close();}
    // Close Chromium before opening the encoder: their native graphics
    // workspaces must not share this machine's limited commit budget.
    await browser.close();browser=null;
    const encoder=spawn(python,[resolve(root,'backend/ai/encode_ui_video.py'),'--work',work,'--stem',stem,'--frames',rendered],
      {cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OPENBLAS_NUM_THREADS:'1',OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS:'0'}});
    await new Promise((yes,no)=>{encoder.once('error',no);encoder.once('exit',code=>code===0?yes():no(Error(stem+': encoder exited '+code)));});
    const verification=JSON.parse(await readFile(resolve(work,stem+'_ui_verified.json'),'utf8'));
    verification.solidBoxesVerified=true;
    verification.boldLabelsVerified=true;
    verification.topRightLabelsVerified=true;
    await copyFile(resolve(work,stem+'_ui.mp4'),resolve(output,stem+'.mp4'));
    browser=await launch();const check=await browser.newPage();
    try{
      await check.goto(origin+`/__export?width=${info.width}&height=${info.height}`);
      const decoded=await check.evaluate(async url=>{
        const video=document.createElement('video');video.muted=true;video.preload='auto';
        await new Promise((yes,no)=>{video.onloadeddata=yes;video.onerror=()=>no(Error('Browser cannot decode output MP4'));video.src=url;});
        return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};
      },`/__videos/${stem}.mp4`);
      if(decoded.width!==info.width||decoded.height!==info.height||Math.abs(decoded.duration-info.frames/info.fps)>.1)
        throw Error('Browser video playback metadata mismatch');
      verification.browserPlaybackVerified=true;
    }finally{await check.close();}
    await unlink(resolve(work,stem+'_ui.mp4'));
    for(let frame=1;frame<=info.frames;frame++){
      await unlink(resolve(rendered,String(frame).padStart(6,'0')+'.jpg'));
      await unlink(resolve(rendered,String(frame).padStart(6,'0')+'.png')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    await rmdir(rendered);
    reports.push({video:stem+'.mp4',...verification,source:resolve(output,stem+'.mp4')});
  }
  const total={};
  for(const report of reports)for(const [key,value]of Object.entries(report.evaluation??{}))if(!key.endsWith('Pct')&&typeof value==='number')total[key]=(total[key]??0)+value;
  await writeFile(resolve(work,'summary.json'),JSON.stringify({complete:reports.length===files.length,videos:reports,total,
    matchedStatusAccuracyPct:total.decided?100*total.correct/total.decided:null,
    decisionCoveragePct:total.gt?100*total.decided/total.gt:null,
    endToEndCorrectPct:total.gt?100*total.correct/total.gt:null,
    overlays:'Imported production PersonOverlay.tsx, FaceOverlay.tsx and ObjectOverlay.tsx, production styles.css; Chromium screenshots'},null,2));
}finally{await browser?.close();await vite?.close();}
