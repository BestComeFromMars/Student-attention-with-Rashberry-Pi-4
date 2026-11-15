// Browser permission/device simulation; never opens a physical webcam or Pi.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

const root=fileURLToPath(new URL('../../',import.meta.url));
let vite,browser,backendReady=false;
const errors=[],apiCalls=[];
try {
  vite=await createServer({root:resolve(root,'frontend'),cacheDir:resolve(root,'.qa/vite-device-discovery-cache'),
    logLevel:'error',server:{host:'127.0.0.1',port:0,open:false}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;apiCalls.push(path);
    return route.fulfill({status:path==='/api/health'&&!backendReady?503:200,contentType:'application/json',body:JSON.stringify(
      path==='/api/health'?{modelReady:backendReady,status:backendReady?'ok':'unavailable',detector:'classroom'}:{deviceOnline:false,state:'offline'})});
  });
  await page.addInitScript(()=>{
    window.__permission=false;window.__denied=false;window.__starts=0;window.__stops=0;window.__constraints=[];window.__enumerations=0;
    window.__devices=[{kind:'videoinput',deviceId:'integrated',label:'Integrated Webcam'},
      {kind:'videoinput',deviceId:'usb',label:'USB Camera'},
      {kind:'videoinput',deviceId:'virtual',label:'OBS Virtual Camera'}];
    const media=new EventTarget();
    media.enumerateDevices=async()=>{window.__enumerations++;return window.__permission?window.__devices:[{kind:'videoinput',deviceId:'',label:''}];};
    media.getUserMedia=async constraints=>{
      window.__constraints.push(constraints);
      if(window.__denied)throw new DOMException('Denied by fixture','NotAllowedError');
      if(constraints.audio!==false)throw new Error('Audio must not be requested');
      window.__permission=true;window.__starts++;
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const context=canvas.getContext('2d');context.fillStyle='#dce8ff';context.fillRect(0,0,640,360);
      const stream=canvas.captureStream(15);
      for(const track of stream.getTracks()){
        const stop=track.stop.bind(track);let stopped=false;
        track.stop=()=>{if(!stopped){stopped=true;window.__stops++;stop();}};
        Object.defineProperty(track,'label',{value:'USB Camera'});
        Object.defineProperty(track,'getSettings',{value:()=>({width:640,height:360,deviceId:'usb'})});
      }
      return stream;
    };
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:media});
  });
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port,{waitUntil:'networkidle'});
  const source=page.getByRole('combobox',{name:'Chọn webcam'});
  assert.equal(await page.evaluate(()=>window.__enumerations),1);
  assert(await page.getByRole('alert').count(),'offline backend must have an actionable error');
  backendReady=true;
  await page.waitForFunction(()=>!document.querySelector('.status-notification'));
  assert.equal(await page.locator('.status-notification--success').count(),0);
  const layouts=[];
  for(const [width,height] of [[1280,850],[1024,768],[768,1024],[700,900],[681,900],[390,844],[320,568]]){
    await page.setViewportSize({width,height});
    const layout=await source.evaluate(element=>{
      const name=element.querySelector('.source-value').getBoundingClientRect();
      const status=element.querySelector('.source-current-status').getBoundingClientRect();
      return {delta:Math.abs(name.y+name.height/2-status.y-status.height/2),overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert(layout.delta<2&& !layout.overflow,'camera name/status must share one row without page overflow');
    layouts.push({width,height,...layout});
  }
  await page.setViewportSize({width:1280,height:850});
  await source.click();
  assert.equal(await page.evaluate(()=>window.__enumerations),1,'opening the menu must not rescan');
  assert.equal(await page.getByRole('option').count(),2);
  assert.equal(await page.evaluate(()=>window.__starts),0,'opening the menu must not open a webcam');
  await page.getByRole('button',{name:'Làm mới danh sách',exact:true}).click();
  await page.getByRole('option',{name:/Integrated Webcam/}).waitFor();
  await page.getByRole('option',{name:/USB Camera/}).waitFor();
  await page.getByRole('option',{name:/OBS Virtual Camera/}).waitFor();
  assert.equal(await page.getByRole('option').count(),5);
  assert.match(await source.innerText(),/Raspberry Pi 4/,'discovery must preserve the selected source');
  assert.deepEqual(await page.evaluate(()=>[window.__starts,window.__stops]),[1,1]);
  assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null);
  assert(!apiCalls.some(path=>path.startsWith('/api/sessions')||path.includes('/camera/start')),'discovery must not start AI or Pi');
  await page.keyboard.press('Escape');await source.click();await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Làm mới danh sách'}).evaluate(button=>button===document.activeElement),true);
  await page.keyboard.press('Escape');await source.click();
  await page.getByRole('option',{name:/^USB Camera/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Tắt camera',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__constraints.at(-1).video.deviceId.exact),'usb');
  await source.click();await page.getByRole('button',{name:'Làm mới danh sách'}).click();
  await page.waitForFunction(()=>window.__starts===2&&window.__stops===1);
  assert.equal(await page.locator('video').evaluate(video=>video.srcObject.getVideoTracks()[0].readyState),'live');
  const beforeChange=await page.evaluate(()=>window.__enumerations);
  await page.evaluate(()=>{
    window.__devices.push({kind:'videoinput',deviceId:'usb2',label:'USB Camera 2'});
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await page.getByRole('status').filter({hasText:'Thiết bị camera đã thay đổi'}).waitFor();
  assert.equal(await page.getByRole('option',{name:/USB Camera 2/}).count(),0);
  assert.equal(await page.evaluate(()=>window.__enumerations),beforeChange,'hotplug must signal, not rescan');
  await page.getByRole('button',{name:'Làm mới danh sách'}).click();
  await page.getByRole('option',{name:/USB Camera 2/}).waitFor();
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  await source.click();
  await mkdir(resolve(root,'.qa'),{recursive:true});
  await page.screenshot({path:resolve(root,'.qa/camera-discovery-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  await page.screenshot({path:resolve(root,'.qa/camera-discovery-mobile.png')});
  await page.reload({waitUntil:'networkidle'});
  await page.evaluate(()=>{window.__denied=true;});
  await source.click();await page.getByRole('button',{name:'Làm mới danh sách',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Quyền camera chưa được cấp'}).waitFor();
  assert.match(await source.innerText(),/Raspberry Pi 4/);
  assert.equal(await page.getByRole('button',{name:'Làm mới danh sách',exact:true}).isEnabled(),true);
  assert.equal(await page.evaluate(()=>window.__starts),0);
  assert.deepEqual(errors,[]);
  const report={checkedAt:new Date().toISOString(),note:'Simulated browser device API; physical cameras and Pi are not opened.',
    permissionRevealsIntegratedUsbVirtual:true,probeReleased:true,selectionPreserved:true,exactUsbSelected:true,
    refreshPreservesActiveCamera:true,initialScanOnce:true,hotplugRequiresRefresh:true,keyboardRefreshReachable:true,
    offlineErrorOnly:true,recoverySilent:true,singleLineLayouts:layouts,permissionDenialExplained:true,mobileNoOverflow:true,errors};
  await writeFile(resolve(root,'.qa/camera-discovery.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();await vite?.close();}
