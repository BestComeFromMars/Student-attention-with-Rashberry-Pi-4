import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer as createVite} from 'vite';
import {chromium} from 'playwright-core';
import {createApp} from '../../backend/dist/app.js';
import {HistoryStore,historyDay} from '../../backend/dist/history-store.js';
import {Sessions} from '../../backend/dist/sessions.js';
import {PiSource} from '../../backend/dist/pi-source.js';
import {InferenceRuntime} from '../../backend/dist/inference-runtime.js';
import {createPixelTracker} from '../../backend/dist/pixel-tracker.js';
import {localAIEnv} from '../../backend/local-ai-env.mjs';

const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.qa/history/browser-'+Date.now());
const env=await localAIEnv(resolve(root,'backend'));for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=env.TEMP;
const image=await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg'));
const pixels=createPixelTracker(resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),resolve(root,'backend'),env);
let mode='warning',streaming=false,timer,api,vite,browser,page,store=new HistoryStore(work);
const pi=new PiSource(),checks=[];
const status=()=>({online:streaming,deviceOnline:true,state:streaming?'streaming':'off',desired:streaming,
  cameraReleased:!streaming,bootId:'history-qa',generation:1,width:1280,height:720,error:null});
async function tick(){if(!streaming)return;await pi.update(image,true);if(streaming)timer=setTimeout(tick,1000/15);}
const controller={status,async command(command){if(command==='start'){streaming=true;await tick();}else{streaming=false;clearTimeout(timer);pi.close();}return status();}};
class ControlledSessions extends Sessions{
  async detect(...args){const tracks=await super.detect(...args);return tracks.map(t=>({...t,attention:mode==='clear'?'uncertain':'needs_attention',
    alerts:mode==='clear'?[]:[{type:'head_turned',label:'Quay lệch hướng lâu',observedAt:Date.now(),expiresAt:Date.now()+5000,held:mode==='held'}]}));}
}
const runtime=new InferenceRuntime(async()=>({ready:true,detect:async()=>[],
  trackFrame:(jpeg,context)=>pixels.track(jpeg,context.sessionId,context.frameId,context.capturedAt),
  seedGeometry:(session,seeds)=>pixels.seed(session,seeds),release:session=>pixels.release(session),close:()=>pixels.close(),
  detectFrame:async(_jpeg,context)=>({frameAt:Date.now(),objects:[],memory:{totalMB:8192,availableMB:mode==='limited'?500:5000,limit:mode==='limited'?1:20,detected:2,processed:mode==='limited'?1:2,limited:mode==='limited',pressure:mode==='limited'},people:(mode==='limited'?[.242]:[.242,.721]).map((cx,i)=>({
    personId:i+1,geometryId:i+1,boxKind:'person',trackingState:'face',faceVisibility:'visible',
    geometryFrameIds:{person:context.frameId,face:context.frameId},
    box:{x:cx-.11,y:.15,width:.22,height:.8},personBox:{x:cx-.11,y:.15,width:.22,height:.8},
    faceBox:{x:cx-.07,y:.34,width:.14,height:.38}}))})}));
let app=createApp({engine:runtime,pi,piController:controller,history:store,sessions:new ControlledSessions()});
const until=async(test,label)=>{const end=Date.now()+25000;while(!await test()){assert(Date.now()<end,label);await delay(100);}checks.push(label);};
try{
  await runtime.start();api=createServer((req,res)=>{
    if(req.url==='/__fixture.jpg'){res.setHeader('Content-Type','image/jpeg');res.end(image);}else app(req,res);
  });await new Promise(yes=>api.listen(0,'127.0.0.1',yes));
  const backend='http://127.0.0.1:'+api.address().port;process.env.BACKEND_URL=backend;
  vite=await createVite({root:resolve(root,'frontend'),cacheDir:resolve(work,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
  await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
  browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/__fixture.jpg',route=>route.fulfill({contentType:'image/jpeg',body:image}));
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:'fixture',label:'Webcam kiểm thử',groupId:'test'}],addEventListener(){},removeEventListener(){},
      getUserMedia:async()=>{const img=new Image();img.src='/__fixture.jpg';await img.decode();
        const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
        const draw=()=>canvas.getContext('2d').drawImage(img,0,0);draw();const interval=setInterval(draw,33),stream=canvas.captureStream(30);
        for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{clearInterval(interval);stop();};}return stream;}
    }});
  });
  const data=async(path,method='GET',body)=>{
    const res=await fetch(backend+'/api/history'+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    assert(res.ok,await res.clone().text());return res.status===204?undefined:res.json();
  };
  const today=historyDay(Date.now());
  await page.goto(origin);
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();await page.getByRole('option',{name:/Webcam kiểm thử/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await until(async()=>{const runs=(await data('/days/'+today)).runs;return runs.length===1&&runs[0].peopleCount===2;},'webcam creates one block and two people');
  const first=(await data('/days/'+today)).runs[0];
  await until(async()=>{const run=await data('/runs/'+first.id);return run.captures.length===2&&run.captures.every(c=>c.photoRevision>=2);},'paired worker portraits saved');
  await delay(2200);let run=await data('/runs/'+first.id);assert(run.captures.every(c=>c.count===1));
  assert.equal((await readdir(join(work,today,first.id))).filter(n=>n.endsWith('.jpg')).length,2);checks.push('continuous warning overwrites only two JPEGs without recounting');
  mode='held';await delay(800);mode='clear';await delay(1000);mode='warning';
  await until(async()=>{const value=await data('/runs/'+first.id);return value.captures.every(c=>c.count===2);},'only a fresh episode increments counts');
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();await page.getByRole('button',{name:'Tiếp tục nhận diện',exact:true}).click();
  await delay(1000);assert.equal((await data('/days/'+today)).runs.length,1);checks.push('pause/resume keeps the same block');
  await page.getByRole('button',{name:'Đặt lại phiên nhận diện',exact:true}).click();
  await until(async()=>{const values=(await data('/days/'+today)).runs;return values.length===2&&values[0].peopleCount===2;},'reset starts block 2 and retains block 1');
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  await until(async()=>{const values=(await data('/days/'+today)).runs;return values.every(r=>r.endedAt);},'camera stop flushes and closes both blocks');
  await store.close();store=new HistoryStore(work);app=createApp({engine:runtime,pi,piController:controller,history:store,sessions:new ControlledSessions()});
  await page.reload();await page.getByRole('img',{name:/Ảnh mặt Học sinh A/}).waitFor();
  await page.screenshot({path:resolve(root,'.qa/history/history-panel.png'),fullPage:true});
  checks.push('reload and backend store restart preserve portraits and history');
  const oldDate=historyDay(Date.now()-86400000),oldId=randomUUID(),oldCapture=randomUUID();
  await data('/runs','POST',{id:oldId,startedAt:Date.now()-86400000,source:'pi',cameraLabel:'Pi hôm qua'});
  await data('/runs/'+oldId+'/captures','PUT',{captures:[{captureId:oldCapture,trackId:'A',displayName:'Hôm qua',labels:['Gục người'],count:3,revision:1,firstAt:Date.now()-86400000,lastAt:Date.now()-86400000}]});
  await page.getByLabel('Ngày lịch sử').fill(oldDate);await page.getByText('Hôm qua',{exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Xóa lần 1',exact:true}).click();assert.equal((await data('/days/'+oldDate)).runs.length,1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Xóa lần 1',exact:true}).click();
  await until(async()=>!(await data('/days/'+oldDate)).runs.length,'cancel/confirm deletion and date selection work');
  await page.getByLabel('Ngày lịch sử').fill(today);await page.getByRole('button',{name:/Lần 2/}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Xóa lịch sử ngày đang xem'}).click();
  await until(async()=>!(await data('/days/'+today)).runs.length,'delete day removes archived blocks');
  const remaining=await readdir(join(work,today));assert(remaining.every(name=>name==='history.json'));
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();await page.getByRole('option',{name:/Raspberry Pi 4/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.pi-video')?.naturalWidth===1280);
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await until(async()=>{const values=(await data('/days/'+today)).runs;return values.length===1&&values[0].number===3&&values[0].peopleCount===2;},'Pi MJPEG uses the same archive and preserves the next daily number');
  mode='limited';await page.getByText('Không đủ RAM để nhận diện.',{exact:true}).waitFor();
  await until(async()=>await page.locator('.camera-person-count').innerText()==='1/1 người','RAM pressure retains the admitted person');
  assert(await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).isVisible());
  assert.equal((await data('/days/'+today)).runs.length,1);
  await page.screenshot({path:resolve(root,'.qa/history/ram-notice.png'),fullPage:true});
  mode='warning';await page.waitForFunction(()=>!document.querySelector('.memory-notice'));
  await until(async()=>await page.locator('.camera-person-count').innerText()==='2/20 người','capacity recovers without stopping camera or creating a block');
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  await until(async()=>{const values=(await data('/days/'+today)).runs;return values.length===1&&Boolean(values[0].endedAt);},'Pi stop flushes the final archive');
  assert.deepEqual(errors,[]);
  const report={passed:true,checks,errors,work,physicalCameraContacted:false,semanticWarnings:'controlled',pixelTracker:'real Python worker',frontend:'production React source'};
  await writeFile(resolve(root,'.qa/history/browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
  if(page){console.log('PANEL FAILURE',(await page.locator('.attention-panel').innerText().catch(()=> 'No panel')).slice(0,5000));
    console.log('BROWSER FAILURE',(await page.locator('body').innerText().catch(()=>'')).slice(0,5000));
    await page.screenshot({path:resolve(root,'.qa/history/browser-failure.png'),fullPage:true}).catch(()=>{});}
  throw error;
}finally{
  streaming=false;clearTimeout(timer);pi.close();await browser?.close();await vite?.close();
  api?.closeAllConnections();if(api?.listening)await new Promise(yes=>api.close(yes));await store.close();await runtime.close();
}
