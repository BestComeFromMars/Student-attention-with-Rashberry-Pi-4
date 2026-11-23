// Render recorded AI decisions on the source video timeline.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
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
const sourcePixels=process.argv.includes('--source-pixels');
const refineOffline=process.argv.includes('--refine-offline');
const resumeFrom=process.argv.includes('--resume-from')?Number(option('--resume-from')):0;
const overlayStride=process.argv.includes('--overlay-stride')?Number(option('--overlay-stride')):1;
assert(Number.isSafeInteger(overlayStride)&&overlayStride>=1);
assert(Number.isSafeInteger(resumeFrom)&&resumeFrom>=0&&(!resumeFrom||sourcePixels));
assert(!refineOffline||sourcePixels);
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
assert.equal(createHash('sha256').update(await readFile(recording.sourcePath)).digest('hex'),recording.sourceSha256,
  'Source must be identical to the video used for the AI run');
let pixelExport;
if(sourcePixels||recording.pixelFrames?.length){
  const pixelPath=resolve(work,'pixel-export.json');
  if(!resumeFrom){
    const child=spawn(python,[resolve(root,'backend/ai/prepare_pixel_export.py'),'--work',work,
      ...(sourcePixels?['--source-frames']:[]),...(refineOffline?['--refine-offline']:[])],
      {cwd:root,env,windowsHide:true,stdio:'inherit'});
    await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Pixel geometry replay failed: '+code)));});
  }
  pixelExport=JSON.parse(await readFile(pixelPath,'utf8'));
  assert.equal(pixelExport.frames.length,info.frames);
  if(resumeFrom){
    assert(resumeFrom<=info.frames&&!pixelExport.livePresentationIsMeasuredSeparately&&
      Boolean(pixelExport.geometryRefinedWithLaterAnchors)===refineOffline);
    const modified=(await stat(pixelPath)).mtimeMs;
    for(let frame=0;frame<resumeFrom;frame++){
      const file=await stat(resolve(work,'overlays',String(frame).padStart(6,'0')+'.png'));
      assert(file.size>67&&file.mtimeMs>=modified,`Stale or missing overlay at frame ${frame}`);
    }
  }
}
if(refineOffline&&!resumeFrom){
  const child=spawn(python,[resolve(root,'backend/ai/render_playback_overlays.py'),'--work',work],
    {cwd:root,env,windowsHide:true,stdio:'inherit'});
  await new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Overlay rasterizer exited '+code)));});
  await encode(['--raw']);
  process.exit(0);
}
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
  async function openPage(){
    await browser?.close();
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
      args:['--disable-gpu','--renderer-process-limit=1']});
    const page=await browser.newPage({viewport:{width:info.width,height:info.height},deviceScaleFactor:1});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+`/__decision_overlay?width=${info.width}&height=${info.height}&overlay=1&smooth=${pixelExport?0:1}`);
    await page.waitForFunction(()=>window.exportReady===true);
    await page.evaluate(()=>document.fonts.ready.then(()=>{}));
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
    return {page,cdp};
  }
  let {page,cdp}=await openPage();
  const completedIndex=new Map(completed.map((row,index)=>[row.index,index]));
  const renderMeasured=(measured,row)=>page.evaluate(async({row,measured})=>window.renderExportFrame({image:'',tracks:row?.data.tracks??[],
    objects:row?.data.objects??[],at:measured.sourceSeconds*1000,geometry:measured.geometry}),{row,measured});
  let current=-1;
  for(let frame=0;frame<info.frames;frame++){
    const at=frame/info.fps;
    if(!pixelExport&&frame%overlayStride!==0&&!(completed[current+1]?.completedSourceSeconds<=at+1e-9))continue;
    if(pixelExport&&frame>resumeFrom&&(frame-resumeFrom)%240===0)({page,cdp}=await openPage());
    const measured=pixelExport?.frames[frame];
    if(pixelExport){
      current=completedIndex.get(measured.requestIndex)??-1;
      await renderMeasured(measured,completed[current]);
    }else{
    while(current+1<completed.length&&completed[current+1].completedSourceSeconds<=at+1e-9){
      const row=completed[++current];
      await page.evaluate(async row=>{
        await window.renderExportFrame({image:'',tracks:row.data.tracks,objects:row.data.objects??[],at:row.completedSourceSeconds*1000});
      },row);
    }
    await page.evaluate(at=>window.advanceExportOverlay(at*1000),at);
    }
    const file='overlays/'+String(frame).padStart(6,'0')+'.png';
    const {geometry,style,captions}=await page.evaluate(({width,height})=>{
      const read=(node,key)=>Number(node.getAttribute(key));
      const nodes=[...document.querySelectorAll('.person-frame,.face-frame,.object-frame')];
      const geometry=nodes.map(rect=>{
        const kind=rect.classList.contains('person-frame')?'person':rect.classList.contains('face-frame')?'face':'object';
        return {kind,id:rect.parentElement.getAttribute('data-'+kind+'-id').replace(/^face-/,''),
          box:{x:read(rect,'x')/width,y:read(rect,'y')/height,width:read(rect,'width')/width,height:read(rect,'height')/height}};
      });
      const style=nodes.every(node=>{
        const css=getComputedStyle(node);
        return css.strokeDasharray==='none'&&Number.parseFloat(css.strokeWidth)>=1.5;
      });
      const captions=[...document.querySelectorAll('.observation-label')].every(label=>{
        const [kind,id]=label.dataset.anchorFrame?.split(':')??[];
        const box=kind&&id?document.querySelector(`[data-${kind}-id="${CSS.escape(id)}"] > rect`):null;
        const viewport=label.parentElement.closest('svg');
        if(!box||!viewport)return false;
        const w=read(label,'width'),h=read(label,'height'),y=read(box,'y');
        const x=Math.max(0,Math.min(read(box,'x')+read(box,'width')-w,read(viewport,'width')-w));
        const top=Math.max(0,Math.min(y>=h?y-h:y,read(viewport,'height')-h));
        return Math.abs(read(label,'x')-x)<.6&&Math.abs(read(label,'y')-top)<.6;
      });
      return {geometry,style,captions};
    },info);
    assert(style);
    assert(captions,`Caption must stay attached at source frame ${frame}`);
    if(frame>=resumeFrom){
      let shot;
      try{shot=await cdp.send('Page.captureScreenshot',{format:'png',optimizeForSpeed:true});}
      catch(error){
        if(!measured)throw error;
        ({page,cdp}=await openPage());
        await renderMeasured(measured,completed[current]);
        shot=await cdp.send('Page.captureScreenshot',{format:'png',optimizeForSpeed:true});
      }
      await writeFile(resolve(work,file),Buffer.from(shot.data,'base64'));
    }
    decisions.push({frame,requestIndex:current>=0?completed[current].index:null,sourceSeconds:at,file,geometry});
    if(frame%100===0||frame===info.frames-1)console.log(`Smooth frontend overlays: ${frame+1}/${info.frames}`);
  }
  assert.equal(errors.length,0);
  await writeFile(resolve(work,'decision-overlays.json'),JSON.stringify({decisions,frontendComponents:true,
    overlayStride:pixelExport?1:overlayStride,
    interpolatedAtSourceFPS:!pixelExport&&overlayStride===1,currentFramePixels:!!pixelExport,replaysPixelTrackingOnly:!!pixelExport,
    geometryRefinedWithLaterAnchors:Boolean(pixelExport?.geometryRefinedWithLaterAnchors),
    causalCompletedResultsOnly:true,captionsPinnedAtEverySourceFrame:overlayStride===1||!!pixelExport,errors},null,2));
}finally{await browser?.close();await vite?.close();}
await encode();
