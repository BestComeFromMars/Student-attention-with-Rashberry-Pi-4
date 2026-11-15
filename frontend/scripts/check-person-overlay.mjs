// Render actual production components over one result from the real API replay.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';

const root=fileURLToPath(new URL('../../',import.meta.url));
const observations=process.argv.includes('--observations');
const single=observations&&process.argv.includes('--single');
const work=resolve(root,observations?'.qa/observation-upgrade':'.qa/action-demo');
await mkdir(resolve(work,'.tmp'),{recursive:true});
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=resolve(work,'.tmp');
const source=resolve(root,'.qa/video-export-ui/class_6_input_frames');
let info=JSON.parse(await readFile(resolve(source,'metadata.json'),'utf8'));
let row;
if(single){
  row=JSON.parse(await readFile(resolve(work,'single-latest.json'),'utf8'));row.sourceFrame=0;
  const loaded=createRequire(resolve(root,'backend/package.json'))('sharp');const sharp=loaded.default??loaded;
  const metadata=await sharp(resolve(root,'backend/test-fixtures/portrait.jpg')).metadata();
  info={width:metadata.width,height:metadata.height};
}else if(observations){
  row=JSON.parse(await readFile(resolve(work,'classroom-latest.json'),'utf8'));
  const timings=JSON.parse(await readFile(resolve(work,'classroom-timings.json'),'utf8'));
  row.sourceFrame=Math.min(info.frames,Math.floor(timings.at(-1).elapsedMs*info.fps/1000)+1);
}else{
  const rows=(await readFile(resolve(work,'stability-core-frames.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  row=rows.filter(r=>r.tracks.some(t=>t.personBox&&t.faceVisibility==='unavailable'&&t.status==='visible'))
    .sort((a,b)=>(b.objects.length-a.objects.length)||(b.tracks.length-a.tracks.length))[0];
}
assert.ok(row?.tracks.some(t=>t.personBox&&t.status==='visible'),'Replay needs a visible person rectangle');
const image=await readFile(single?resolve(root,'backend/test-fixtures/portrait.jpg'):
  resolve(source,String(row.sourceFrame).padStart(6,'0')+'.jpg'));
const errors=[];let vite,browser;
try{
  vite=await createServer({configFile:false,root:resolve(root,'frontend'),cacheDir:resolve(work,'overlay-vite-cache'),
    logLevel:'error',plugins:[react(),{name:'check-actual-overlay',configureServer(server){
      server.middlewares.use(async(req,res,next)=>{
        if(req.url.startsWith('/__check')){
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/dev/export-video.tsx"></script></body></html>'));return;
        }
        if(req.url==='/__source.jpg'){res.setHeader('Content-Type','image/jpeg');res.end(image);return;}
        next();
      });
    }}],server:{host:'127.0.0.1',port:0}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--disable-gpu','--renderer-process-limit=1']});
  const page=await browser.newPage({viewport:{width:info.width,height:info.height},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__check?width=${info.width}&height=${info.height}`);
  await page.waitForFunction(()=>window.exportReady===true);
  await page.evaluate(async row=>window.renderExportFrame({image:'/__source.jpg',tracks:row.tracks,objects:row.objects}),row);
  await page.waitForFunction(()=>document.querySelectorAll('.person-frame').length>0);
  const drawn=await page.evaluate(()=>{
    const boxes=(selector,attribute)=>[...document.querySelectorAll(selector)].map(rect=>({
      id:rect.closest(`[${attribute}]`).getAttribute(attribute),x:rect.x.baseVal.value,y:rect.y.baseVal.value,
      width:rect.width.baseVal.value,height:rect.height.baseVal.value}));
    return {people:boxes('.person-frame','data-person-id'),faces:boxes('.face-frame','data-face-id'),
      objects:boxes('.object-frame','data-object-id')};
  });
  const people=row.tracks.filter(t=>t.personBox&&t.status==='visible').map(t=>({...t,box:t.displayBoxes?.person??t.personBox}));
  const faces=row.tracks.filter(t=>t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face')&&t.trackingState!=='predicted'&&
    (t.status==='visible'||t.trackingState==='body'||t.trackingState==='coasting')).map(t=>({...t,box:t.displayBoxes?.face??t.faceBox??t.box}));
  const objects=row.objects.map(object=>({...object,box:object.displayBox??object.box}));
  for(const [actual,expected,prefix]of [[drawn.people,people,''],[drawn.faces,faces,'face-'],[drawn.objects,objects,'']]){
    assert.equal(actual.length,expected.length);
    for(const item of expected){
      const rect=actual.find(b=>b.id===prefix+item.id);assert.ok(rect);
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(rect[key]-item.box[key]*(key==='x'||key==='width'?info.width:info.height))<.1);
    }
  }
  for(const track of people.filter(t=>t.faceVisibility==='unavailable'))assert.ok(!drawn.faces.some(b=>b.id==='face-'+track.id));
  assert.deepEqual(errors,[]);
  await mkdir(work,{recursive:true});await page.screenshot({path:resolve(work,single?'single-person-overlay.png':'person-overlay.png'),animations:'disabled'});
  const report={passed:true,sourceFrame:row.sourceFrame,people:people.length,faces:faces.length,objects:row.objects.length,
    peopleWithoutFace:people.filter(t=>t.faceVisibility==='unavailable').length,coordinatesMatchAPI:true,
    source:'Production PersonOverlay, FaceOverlay, ObjectOverlay with an actual HTTP replay result; not an action-accuracy test.'};
  await writeFile(resolve(work,single?'single-overlay-check.json':'overlay-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await vite?.close();}
