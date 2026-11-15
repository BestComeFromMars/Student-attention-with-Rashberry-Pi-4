// Real webcam upload/capture code, real worker models and independent boxes.
// getUserMedia supplies controlled public pixels, not the physical USB device.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer as createVite} from 'vite';
import {chromium} from 'playwright-core';
import {createInferenceEngine} from '../../backend/dist/inference.js';
import {createApp} from '../../backend/dist/app.js';

const root=fileURLToPath(new URL('../../',import.meta.url)),directory=resolve(root,'.qa/object-motion');
const prepared=spawnSync(resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
  [resolve(root,'backend/ai/prepare_object_motion.py'),directory],{encoding:'utf8',windowsHide:true});
assert.equal(prepared.status,0,prepared.stderr||String(prepared.error));
const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
let engine,server,vite,browser;
const errors=[],inferencePaths=[],trace=[];
try{
  engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
  server=createApp({engine}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  process.env.BACKEND_URL='http://127.0.0.1:'+server.address().port;
  const frames=new Map();
  for(const path of [...manifest.frames.map(frame=>frame.path),'objects-only.jpg'])frames.set(path,await readFile(resolve(directory,path)));
  vite=await createVite({root:resolve(root,'frontend'),logLevel:'error',cacheDir:resolve(root,'.qa/vite-usb-object-cache'),
    plugins:[{name:'usb-pixel-fixture',configureServer(dev){dev.middlewares.use('/__qa/frame/',(request,response)=>{
      const bytes=frames.get(request.url?.split('?')[0].replace(/^\//,''));
      if(!bytes){response.writeHead(404).end();return;}
      response.setHeader('Content-Type','image/jpeg');response.end(bytes);
    });}}],server:{host:'127.0.0.1',port:0}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--disable-gpu','--renderer-process-limit=1']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\/detect(?:\/pi)?$/.test(request.url()))inferencePaths.push(new URL(request.url()).pathname);});
  await page.addInitScript(()=>{
    const originalFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(/\/detect$/.test(String(args[0]))&&response.ok)window.__usbResult=await response.clone().json();
      return response;
    };
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:'usb-fixture',label:'USB camera fixture'}],
      addEventListener(){},removeEventListener(){},
      getUserMedia:async constraints=>{
        if(constraints.audio!==false)throw Error('Unexpected audio');
        if(constraints.video?.deviceId?.exact!=='usb-fixture')throw Error('The test must select the USB webcam');
        const initial=new Image();initial.src='/__qa/frame/000.jpg';await initial.decode();
        window.__usbImage=initial;window.__usbIndex=0;
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const context=canvas.getContext('2d');
        const paint=()=>{
          context.drawImage(window.__usbImage,0,0,640,480);
          context.fillStyle=`rgb(${10+window.__usbIndex*10},230,20)`;context.fillRect(0,0,16,16);
        };
        paint();const stream=canvas.captureStream(15),timer=setInterval(paint,60);
        for(const track of stream.getTracks()){
          const settings=track.getSettings.bind(track);
          track.getSettings=()=>({...settings(),deviceId:'usb-fixture',width:640,height:480});
          const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};
        }
        return stream;
      },
    }});
  });
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port,{waitUntil:'networkidle'});
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:/USB camera fixture/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.waitForFunction(()=>window.__usbResult?.tracks.some(track=>track.status==='visible')&&
    ['phone','book'].every(kind=>window.__usbResult.objects?.some(object=>object.kind===kind)),null,{timeout:30000});
  await page.locator('.object-overlay [data-object-kind="phone"] .object-frame').waitFor();
  assert.equal(await page.locator('.face-overlay .object-frame').count(),0);
  assert.equal(await page.locator('.object-overlay .face-frame').count(),0);
  const initialIds=await page.evaluate(()=>Object.fromEntries(window.__usbResult.objects.map(object=>[object.kind,object.id])));
  for(const index of [0,4,8,12,8,4,0]){
    const frame=manifest.frames[index];
    await page.evaluate(async({path,index})=>{
      const image=new Image();image.src='/__qa/frame/'+path;await image.decode();window.__usbImage=image;window.__usbIndex=index;
    },{path:frame.path,index});
    // Inspect the analyzed canvas marker, not whichever raw video frame is
    // currently playing while HTTP inference is in flight.
    await page.waitForFunction(index=>{
      const canvas=document.querySelector('.analysis-frame');
      if(!canvas||!canvas.width)return false;
      const pixel=canvas.getContext('2d').getImageData(8,8,1,1).data;
      return Math.abs(pixel[0]-(10+index*10))<5&&pixel[1]>200;
    },index,{timeout:12000});
    const boxes=await page.locator('.object-overlay [data-object-id]').evaluateAll(nodes=>nodes.map(node=>{
      const rect=node.querySelector('.object-frame'),svg=rect.ownerSVGElement;
      return {id:node.dataset.objectId,kind:node.dataset.objectKind,x:rect.x.baseVal.value/svg.width.baseVal.value,
        y:rect.y.baseVal.value/svg.height.baseVal.value,width:rect.width.baseVal.value/svg.width.baseVal.value,
        height:rect.height.baseVal.value/svg.height.baseVal.value};
    }));
    const errors=[];
    for(const kind of ['phone','book']){
      const box=boxes.find(box=>box.kind===kind),gold=frame[kind];assert(box);
      assert.equal(box.id,initialIds[kind]);
      const error=Math.hypot((box.x+box.width/2-gold.x-gold.width/2)*640,(box.y+box.height/2-gold.y-gold.height/2)*480);
      assert(error<28,JSON.stringify({index,kind,error,boxes}));errors.push({kind,error});
    }
    assert(await page.locator('.face-frame').count(),'the face has its own visible rectangle');
    trace.push({index,boxes,errors});
    if(index===12)await page.screenshot({path:resolve(root,'.qa/usb-object-tracking-browser.png')});
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Phóng to camera'}).click();
  await page.waitForTimeout(150);
  assert(await page.locator('.face-frame').count());
  assert.equal(await page.locator('.object-frame').count(),2);
  await page.screenshot({path:resolve(root,'.qa/usb-object-tracking-mobile.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();
  assert.equal(await page.locator('.face-frame,.object-frame').count(),0);
  assert.equal(await page.locator('video').evaluate(video=>video.paused),false);
  await page.getByRole('button',{name:'Tiếp tục nhận diện',exact:true}).click();
  await page.locator('.object-frame').first().waitFor({timeout:15000});
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();
  assert.equal(await page.locator('.face-frame,.object-frame').count(),0);
  assert(inferencePaths.length>0&&inferencePaths.every(path=>!path.endsWith('/pi')));
  assert.deepEqual(errors,[]);
  const report={status:'passed',actualModels:true,physicalUsbCamera:false,source:'getUserMedia controlled pixels -> webcam JPEG upload -> real worker -> separate SVG layers',
    piInferenceUsed:false,pairedFrameMarkerChecked:true,independentObjectIds:true,independentBoxes:true,pauseResumeAndStop:true,mobileExpansion:true,trace};
  await writeFile(resolve(root,'.qa/usb-object-tracking-browser.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,trace:undefined}));
}catch(error){
  if(browser)for(const context of browser.contexts())for(const page of context.pages()){
    console.error(await page.locator('body').innerText({timeout:3000}).catch(()=>''));
    await page.screenshot({path:resolve(root,'.qa/usb-object-tracking-browser-failure.png'),timeout:5000}).catch(()=>{});
  }
  throw error;
}finally{
  await browser?.close();await vite?.close();
  server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await engine?.close();
}
