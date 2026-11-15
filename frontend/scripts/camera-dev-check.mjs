import {access,mkdir,writeFile,unlink,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

const client=fileURLToPath(new URL('../',import.meta.url));
const fixture=resolve(client,'.qa','camera-dev-'+process.pid);
const report=resolve(client,'../.qa');
const candidates=process.env.CHROME_PATH?[process.env.CHROME_PATH]:[
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium',
];
let executablePath;
for(const path of candidates){try{await access(path);executablePath=path;break;}catch{}}
assert(executablePath,'Set CHROME_PATH to an installed Chrome/Edge executable');
let vite,browser,page;
let backendReady=false;
let piAvailable=false;
const errors=[];
await mkdir(fixture,{recursive:true});
await mkdir(report,{recursive:true});
await writeFile(resolve(fixture,'index.html'),'<div id="root"></div><script type="module" src="./entry.tsx"></script>');
await writeFile(resolve(fixture,'entry.tsx'),
  "import {StrictMode} from 'react';import {createRoot} from 'react-dom/client';import App from '../../src/App';import '../../src/styles.css';createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);");
try{
  vite=await createServer({root:client,cacheDir:resolve(client,'.vite-cache','qa-camera-'+process.pid),server:{port:0,host:'127.0.0.1',strictPort:true,open:false}});
  await vite.listen();
  browser=await chromium.launch({executablePath,headless:true,args:['--disable-gpu','--renderer-process-limit=1']});
  page=await browser.newPage({viewport:{width:1280,height:850}});
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/health',route=>route.fulfill({status:backendReady?200:503,contentType:'application/json',
    body:JSON.stringify({status:backendReady?'ok':'unavailable',modelReady:backendReady,detector:'classroom'})}));
  await page.route('**/api/pi/status',route=>route.fulfill({contentType:'application/json',
    body:JSON.stringify({deviceOnline:piAvailable,state:piAvailable?'off':'offline',error:null})}));
  await page.route('**/api/client/events',route=>route.fulfill({status:204,body:''}));
  // Replace the whole device API before App loads. No physical camera is accessed.
  await page.addInitScript(()=>{
    window.__cameraMode='normal';
    const record=key=>{
      const counts=JSON.parse(sessionStorage.getItem('qa-camera-counts')||'{"starts":0,"stops":0}');
      counts[key]++;
      sessionStorage.setItem('qa-camera-counts',JSON.stringify(counts));
    };
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:'qa-camera',label:'QA camera'}],
      addEventListener(){},removeEventListener(){},
      getUserMedia:async constraints=>{
        if(constraints.audio!==false)throw new Error('Unexpected audio access');
        const mode=window.__cameraMode;
        if(mode==='denied')throw new DOMException('Test denial','NotAllowedError');
        if(mode==='busy')throw new DOMException('Test busy device','NotReadableError');
        if(mode==='constraints'&&constraints.video?.width)throw new DOMException('Test old driver','OverconstrainedError');
        if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,250));
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
        const context=canvas.getContext('2d');
        let frame=0;
        const paint=()=>{context.fillStyle='#e8f0ff';context.fillRect(0,0,640,360);context.fillStyle='#2563eb';
          context.fillRect((frame++*5)%600,150,40,40);context.font='24px sans-serif';context.fillText('CAMERA TEST',210,90);};
        paint();
        const stream=canvas.captureStream(15),timer=setInterval(paint,60);
        record('starts');
        for(const track of stream.getTracks()){
          const stop=track.stop.bind(track);let stopped=false;
          track.stop=()=>{if(!stopped){stopped=true;clearInterval(timer);stop();record('stops');}};
        }
        return stream;
      },
    }});
  });
  const url='http://127.0.0.1:'+vite.httpServer.address().port+'/.qa/camera-dev-'+process.pid+'/index.html';
  await page.goto(url,{waitUntil:'networkidle'});
  const counts=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa-camera-counts')||'{"starts":0,"stops":0}'));
  const open=async()=>{
    await page.getByRole('button',{name:'Bật camera',exact:true}).click();
    await page.getByRole('button',{name:'Tắt camera',exact:true}).waitFor();
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video.videoWidth>0&&!video.paused;});
  };
  const close=async()=>{
    await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
    await page.getByRole('button',{name:'Bật camera',exact:true}).waitFor();
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null);
  };
  const source=page.getByRole('combobox',{name:'Chọn webcam'});
  assert.match(await source.innerText(),/Raspberry Pi 4/,'A new page must select Pi by default');
  assert(await source.locator('.source-current-status').isVisible(),'Readiness must be visible before opening the dropdown');
  const option=value=>page.getByRole('option',{name:value==='raspberry-pi'?/^Raspberry Pi 4/:/^Webcam máy tính/});
  const choose=async value=>{await source.click();await option(value).click();};
  const checkStatus=async(value,ready)=>{
    await source.click();
    await option(value).locator(ready?'.camera-status-ready':'.camera-status-missing').waitFor();
    await page.keyboard.press('Escape');
  };
  await source.click();
  assert.deepEqual(await page.locator('.source-option-label').allTextContents(),['Webcam máy tính','QA camera','Raspberry Pi 4']);
  await page.keyboard.press('Escape');
  for(const [width,height] of [[1440,960],[1024,768],[768,1024],[700,900],[681,900],[390,844],[320,568],[844,390],[568,320]]) {
    await page.setViewportSize({width,height});
    await delay(100);
    await choose('raspberry-pi');
    await checkStatus('raspberry-pi',false);
    assert(await source.locator('.source-current-status').isVisible());
    assert(await page.locator('.camera-expand-button span').isVisible(),'Expand caption must always be visible');
    const captions=await page.locator('.camera-controls>.control-button').evaluateAll(buttons=>buttons.map(button=>
      [...button.querySelectorAll('span')].some(span=>span.textContent.trim()&&span.getBoundingClientRect().height>0)));
    assert(captions.every(Boolean),'Each toolbar button must show a caption without hover/click');
    assert(await page.getByRole('button',{name:'Tắt Raspberry Pi',exact:true}).isVisible());
    assert(await page.getByRole('button',{name:'Tắt Raspberry Pi',exact:true}).isDisabled());
    const bounds=await page.locator('.video-viewport').boundingBox();
    assert(bounds.width>100&&bounds.height>80&&bounds.y>=0&&bounds.y+bounds.height<=height);
    const buttons=await page.locator('.camera-controls>.source-picker,.camera-controls>.control-button').evaluateAll(elements=>
      elements.map(element=>{const r=element.getBoundingClientRect();return {x:r.x,right:r.right};}).sort((a,b)=>a.x-b.x));
    assert(buttons.every(button=>button.x>=0&&button.right<=width),JSON.stringify({width,buttons}));
    for(let i=1;i<buttons.length;i++)assert(buttons[i].x>=buttons[i-1].right&&buttons[i].x-buttons[i-1].right<=24,
      'Toolbar controls must stay grouped without overlap: '+JSON.stringify({width,buttons}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight),false);
    if(width===390||width===1024)await page.screenshot({path:resolve(report,'hotspot-responsive-'+width+'.png')});
    await choose('');
    await checkStatus('',true);
  }
  await choose('raspberry-pi');
  piAvailable=true;
  await checkStatus('raspberry-pi',true);
  assert(await page.getByRole('button',{name:'Tắt Raspberry Pi',exact:true}).isEnabled());
  assert.equal((await counts()).starts,0,'Presence checks must never open a webcam');
  await choose('');
  await page.setViewportSize({width:1280,height:850});
  console.log('Viewport layout, dynamic camera dropdown, presence colors and visible Pi power control passed.');
  await open(); // Must work under StrictMode even with the backend unavailable.
  assert(await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).isDisabled());
  await close();
  console.log('PASS camera with backend offline.');
  backendReady=true;
  await page.waitForFunction(()=>!document.querySelector('.status-notification'));
  assert.equal(await page.locator('.status-notification--success').count(),0);
  console.log('PASS backend readiness transition.');
  for(let index=0;index<5;index++){await open();await close();}
  console.log('PASS repeated camera toggles.');
  for(const [mode,message] of [['denied','Quyền camera'],['busy','Camera đang bận']]){
    await page.evaluate(value=>window.__cameraMode=value,mode);
    await page.getByRole('button',{name:'Bật camera',exact:true}).click();
    await page.getByRole('alert').filter({hasText:message}).waitFor();
    await page.evaluate(()=>window.__cameraMode='normal');
    await open();await close();
  }
  await page.evaluate(()=>window.__cameraMode='constraints');
  await open();await close();
  await page.evaluate(()=>window.__cameraMode='slow');
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Hủy kết nối',exact:true}).click();
  await page.evaluate(()=>window.__cameraMode='normal');
  await open();await delay(400);let current=await counts();assert.equal(current.starts-current.stops,1);await close();
  await open();
  const navigation=page.waitForEvent('domcontentloaded');
  // Simulate a controller edit only in this test server, without modifying source files.
  vite.watcher.emit('change',resolve(client,'src/hooks/useObservation.ts'));
  await navigation;
  await page.getByRole('button',{name:'Bật camera',exact:true}).waitFor();
  await delay(100);current=await counts();assert.equal(current.starts,current.stops,'Reload must release the old stream');
  await choose(''); // The reloaded page defaults to Pi; this case exercises the computer webcam.
  await open();
  await page.screenshot({path:resolve(report,'camera-dev.png'),fullPage:true});
  await close();
  current=await counts();assert.equal(current.starts,current.stops,'Every granted stream must be stopped');
  assert.deepEqual(errors,[]);
  console.log('Chrome dev camera: StrictMode, backend offline, repeated on/off, permission/busy retry, constraints fallback, late cancellation and controller reload passed. Streams: '+current.starts+'/'+current.stops+'.');
}finally{
  if(page&&!page.isClosed())await page.evaluate(()=>window.dispatchEvent(new Event('pagehide'))).catch(()=>{});
  if(browser)await browser.close();
  if(vite)await vite.close();
  await unlink(resolve(fixture,'entry.tsx'));
  await unlink(resolve(fixture,'index.html'));
  await rmdir(fixture);
}
