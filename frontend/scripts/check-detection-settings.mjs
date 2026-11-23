// Real app + real HTTP rules, with controlled measurements and a canvas camera.
// This checks configuration transport/behavior, not pretrained-model accuracy.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../backend/dist/app.js';
import {Sessions} from '../../backend/dist/sessions.js';

const root=fileURLToPath(new URL('../../',import.meta.url)),dist=resolve(root,'frontend/dist'),work=resolve(root,'.qa/detection-settings');
await mkdir(resolve(work,'.tmp'),{recursive:true});
for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=resolve(work,'.tmp');
let now=Date.now(),detections=0;
const sessions=new Sessions(()=>now),updates=[],created=[],errors=[];
const engine={ready:true,close:async()=>{},release:()=>{},detect:async()=>{
  now+=250;detections++;
  return [{boxKind:'person',personId:7,geometryId:7,box:{x:.15,y:.1,width:.3,height:.8},personBox:{x:.15,y:.1,width:.3,height:.8},
    faceBox:{x:.2,y:.15,width:.2,height:.25},faceVisibility:'visible',trackingState:'face',
    observation:{valid:true,facePresent:true,facePixels:120,eyeAspectRatio:.3,yawOffset:0,yawDeg:0,pitchDeg:30,
      observedAt:now,phoneHeld:false,laptopInteraction:false,bookInteraction:false,objectsAt:now}}];
}};
const app=createApp({engine,sessions});
const server=createServer(async(request,response)=>{
  if(request.url.startsWith('/api/')){
    if(request.method==='PUT'&&request.url.endsWith('/settings'))updates.push(request.url);
    if(request.method==='POST'&&request.url==='/api/sessions')created.push(request.url);
    return app(request,response);
  }
  try{
    const url=new URL(request.url,'http://localhost'),path=resolve(dist,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    const local=relative(dist,path);if(local.startsWith('..')||isAbsolute(local)){response.writeHead(403).end();return;}
    const data=await readFile(path);response.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'}[extname(path)]??'application/octet-stream'});response.end(data);
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:'controlled-camera',groupId:'test',label:'Camera kiểm thử'}],
      addEventListener(){},removeEventListener(){},
      getUserMedia:async()=>{
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d');let count=0;
        const draw=()=>{ctx.fillStyle='#dae5f5';ctx.fillRect(0,0,640,480);ctx.fillStyle='#21344f';ctx.fillText('Camera kiểm thử '+count++,20,30);};
        draw();const stream=canvas.captureStream(15),timer=setInterval(draw,66);
        stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
      },
    }});
  });
  const origin='http://127.0.0.1:'+server.address().port;
  await page.goto(origin);
  const open=async()=>{await page.getByRole('button',{name:'Ngưỡng nhận diện',exact:true}).click();await page.getByRole('spinbutton',{name:'Cúi đầu — Thời gian xác nhận',exact:true}).waitFor();};
  const settings=()=>page.locator('.detection-settings');
  const field=name=>page.getByRole('spinbutton',{name,exact:true});
  const save=async()=>{await page.getByRole('button',{name:'Lưu ngưỡng',exact:true}).click();await settings().getByRole('status').filter({hasText:'Đã lưu'}).waitFor();};
  const close=()=>page.getByRole('button',{name:'Đóng ngưỡng nhận diện'}).click();
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('student-attention.observation-settings.v4')));
  await open();assert.equal(await settings().getByRole('checkbox').count(),11);
  assert.equal(await settings().locator('.threshold-row').count(),11);
  assert(await settings().locator('.threshold-editable').count()>20);
  assert(await settings().locator('.threshold-editable').first().evaluate(node=>getComputedStyle(node).color==='rgb(220, 38, 38)'));
  await field('Cúi đầu — Thời gian xác nhận').fill('0');await page.getByRole('button',{name:'Lưu ngưỡng',exact:true}).click();
  assert.match(await settings().getByRole('alert').textContent(),/nhập từ/);assert.equal(await stored(),null);
  await field('Cúi đầu — Thời gian xác nhận').fill('0.2');await field('Cúi đầu — Góc cúi tối thiểu').fill('50');await save();
  assert.equal((await stored()).thresholds.headDownMs,200);await close();
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();await page.getByRole('option',{name:/Camera kiểm thử/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-person-id="A"]'));
  assert.equal(await page.locator('.person-overlay').getByText('A · CẦN CHÚ Ý',{exact:true}).count(),0,'30° must not exceed a saved 50° threshold');
  await open();await field('Cúi đầu — Góc cúi tối thiểu').fill('10');await save();await close();
  await page.locator('.person-overlay').getByText('A · CẦN CHÚ Ý',{exact:true}).waitFor();
  assert(await page.locator('.person-overlay').getByText('Cúi đầu',{exact:true}).count());
  assert.equal(created.length,1,'Applying settings must preserve the session/person identity');assert.equal(updates.length,1);
  await open();await settings().getByRole('checkbox',{name:'Cúi đầu',exact:true}).uncheck();await save();await close();
  await page.waitForFunction(()=>!document.querySelector('[data-person-label="A"]')?.textContent.includes('CẦN CHÚ Ý'));
  assert.equal(created.length,1);assert.equal(updates.length,2);assert(await page.locator('[data-person-id="A"]').count());
  await page.reload();await open();assert.equal(await field('Cúi đầu — Góc cúi tối thiểu').inputValue(),'10');
  assert.equal(await settings().getByRole('checkbox',{name:'Cúi đầu',exact:true}).isChecked(),false);
  await page.screenshot({path:resolve(work,'desktop.png')});
  await page.getByRole('button',{name:'Mặc định',exact:true}).click();assert.equal(await field('Cúi đầu — Góc cúi tối thiểu').inputValue(),'18');
  assert.equal((await stored()).thresholds.headDownPitchDeg,10,'Reset is a draft until saved');await save();
  assert.equal((await stored()).thresholds.headDownPitchDeg,18);await close();
  for(const width of [1024,768,390]){
    await page.setViewportSize({width,height:844});
    const button=await page.getByRole('button',{name:'Ngưỡng nhận diện',exact:true}).boundingBox();
    assert(button&&button.x>=0&&button.x+button.width<=width,'Settings control must fit the toolbar');
    await open();const bounds=await settings().boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width);
    assert.equal(await settings().locator('.threshold-row').count(),11);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    if(width===390)await page.screenshot({path:resolve(work,'mobile.png')});
    await page.keyboard.press('Escape');assert.equal(await settings().count(),0);
  }
  assert.deepEqual(errors,[]);
  const report={passed:true,behaviors:11,detections,liveSettingsUpdates:updates.length,sessionsCreatedBeforeReload:1,
    checked:['range validation','save','live threshold change','disable and clear held alert','stable person ID','reload persistence','explicit reset save','desktop/tablet/mobile','Escape'],
    scope:'Production app and HTTP evaluator with controlled observations/canvas camera; no pretrained-model accuracy claim'};
  await writeFile(resolve(work,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
