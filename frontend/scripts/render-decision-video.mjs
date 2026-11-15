// Offline rendering only. AI decisions were already measured during a real 1x run.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
import {localAIEnv} from '../../backend/local-ai-env.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const option=key=>{const i=process.argv.indexOf(key);if(i<0)throw Error('Missing '+key);return process.argv[i+1];};
const work=resolve(option('--work')),output=resolve(option('--output'));
const env=await localAIEnv(resolve(root,'backend'));
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=env.TEMP;
const python=resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
async function encode(extra=[]){
  const child=spawn(python,[resolve(root,'backend/ai/encode_decision_video.py'),'--work',work,'--output',output,...extra],
    {cwd:root,env,windowsHide:true,stdio:'inherit'});
  await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Source-frame encoder exited '+code)));});
}
await encode(['--probe-only']);
const info=JSON.parse(await readFile(resolve(work,'source-info.json'),'utf8'));
const recording=JSON.parse(await readFile(resolve(work,'recording.json'),'utf8'));
let pixelExport;
if(recording.pixelFrames?.length){
  const child=spawn(python,[resolve(root,'backend/ai/prepare_pixel_export.py'),'--work',work],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Pixel geometry replay failed: '+code)));});
  pixelExport=JSON.parse(await readFile(resolve(work,'pixel-export.json'),'utf8'));
}
assert.equal(createHash('sha256').update(await readFile(recording.sourcePath)).digest('hex'),recording.sourceSha256,
  'Source must be identical to the video used for the realtime AI run');
const completed=recording.requests.filter(row=>row.status===200&&row.end<=recording.endedAt);
assert(completed.every(row=>Number.isFinite(row.completedSourceSeconds)),'Need completion times measured on the source video');
await mkdir(resolve(work,'overlays'),{recursive:true});
let vite,browser;const errors=[],decisions=[];
try{
  vite=await createServer({configFile:false,root:resolve(root,'frontend'),cacheDir:resolve(work,'overlay-vite-cache'),
    plugins:[react(),{name:'decision-overlay-export',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!req.url.startsWith('/__decision_overlay'))return next();
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/dev/export-video.tsx"></script></body></html>'));
    });}}],logLevel:'error',server:{host:'127.0.0.1',port:0}});
  await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:info.width,height:info.height},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+`/__decision_overlay?width=${info.width}&height=${info.height}&overlay=1&smooth=${pixelExport?0:1}`);
  await page.waitForFunction(()=>window.exportReady===true);
  let current=-1;
  for(let frame=0;frame<info.frames;frame++){
    const at=frame/info.fps;
    if(pixelExport){
      const measured=pixelExport.frames[frame],row=completed.find(q=>q.index===measured.requestIndex);
      current=row?completed.indexOf(row):-1;
      await page.evaluate(async({row,measured})=>window.renderExportFrame({image:'',tracks:row?.data.tracks??[],
        objects:row?.data.objects??[],at:measured.sourceSeconds*1000,geometry:measured.geometry}),{row,measured});
    }else{
    while(current+1<completed.length&&completed[current+1].completedSourceSeconds<=at+1e-9){
      const row=completed[++current];
      await page.evaluate(async row=>{
        await window.renderExportFrame({image:'',tracks:row.data.tracks,objects:row.data.objects??[],at:row.completedSourceSeconds*1000});
      },row);
    }
    await page.evaluate(at=>window.advanceExportOverlay(at*1000),at);
    }
    const style=await page.locator('.person-frame,.face-frame,.object-frame').evaluateAll(nodes=>({
      solid:nodes.every(node=>getComputedStyle(node).strokeDasharray==='none'),
      readable:nodes.every(node=>Number.parseFloat(getComputedStyle(node).strokeWidth)>=1.5)}));
    assert(style.solid&&style.readable);
    const captions=await page.locator('.observation-label').evaluateAll(labels=>labels.every(label=>{
      const [kind,id]=label.dataset.anchorFrame?.split(':')??[];
      const box=kind&&id?document.querySelector(`[data-${kind}-id="${CSS.escape(id)}"] > rect`):null;
      const viewport=label.parentElement.closest('svg');if(!box||!viewport)return false;
      const read=(node,key)=>Number(node.getAttribute(key));
      const w=read(label,'width'),h=read(label,'height'),y=read(box,'y');
      const x=Math.max(0,Math.min(read(box,'x')+read(box,'width')-w,read(viewport,'width')-w));
      const top=Math.max(0,Math.min(y>=h?y-h:y,read(viewport,'height')-h));
      return Math.abs(read(label,'x')-x)<.6&&Math.abs(read(label,'y')-top)<.6;
    }));
    assert(captions,`Caption must stay attached at source frame ${frame}`);
    const file='overlays/'+String(frame).padStart(6,'0')+'.png';
    const geometry=await page.locator('.person-frame,.face-frame,.object-frame').evaluateAll((nodes,info)=>nodes.map(rect=>{
      const kind=rect.classList.contains('person-frame')?'person':rect.classList.contains('face-frame')?'face':'object';
      return {kind,id:rect.parentElement.getAttribute('data-'+kind+'-id').replace(/^face-/,''),
        box:{x:Number(rect.getAttribute('x'))/info.width,y:Number(rect.getAttribute('y'))/info.height,
          width:Number(rect.getAttribute('width'))/info.width,height:Number(rect.getAttribute('height'))/info.height}};
    }),info);
    await page.screenshot({path:resolve(work,file),omitBackground:true,type:'png',animations:'allow'});
    decisions.push({frame,requestIndex:current>=0?completed[current].index:null,sourceSeconds:at,file,geometry});
    if(frame%100===0||frame===info.frames-1)console.log(`Smooth frontend overlays: ${frame+1}/${info.frames}`);
  }
  assert.equal(errors.length,0);
  await writeFile(resolve(work,'decision-overlays.json'),JSON.stringify({decisions,frontendComponents:true,
    interpolatedAtSourceFPS:!pixelExport,currentFramePixels:!!pixelExport,replaysPixelTrackingOnly:!!pixelExport,
    causalCompletedResultsOnly:true,captionsPinnedAtEverySourceFrame:true,errors},null,2));
}finally{await browser?.close();await vite?.close();}
await encode();
