// Actual HTTP/session evaluation and SVG rendering; synthetic measurements and
// a public fixture image. This does not measure model accuracy or open a camera.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createVite} from 'vite';
import {chromium} from 'playwright-core';
import {createApp} from '../../backend/dist/app.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const candidateOnly=process.argv.includes('--candidate-only');
let mode='phone',phaseAt=Date.now(),server,vite,browser;
const errors=[],checked=[];
const faceBoxes=[{x:.1665,y:.349,width:.151,height:.366},{x:.6525,y:.314,width:.137,height:.424}];
const objectBoxes={phone:{x:.35,y:.64,width:.05,height:.15},book:{x:.62,y:.79,width:.24,height:.14},laptop:{x:.12,y:.72,width:.26,height:.2}};
const engine={ready:true,async detect(){
  const at=Date.now(),elapsed=at-phaseAt;
  if(mode==='lost')return [];
  return faceBoxes.map((box,index)=>{
    const kind=index===1?'book':['phone','stale','candidate','delayed'].includes(mode)?'phone':mode==='laptop'?'laptop':mode==='book'?'book':null;
    const observedAt=index===0&&mode==='stale'?at-6000:index===0&&mode==='delayed'?at-2500:at;
    const open=mode==='talking'&&Math.floor(elapsed/300)%2===1;
    const observation={valid:true,observedAt:at,objectsAt:observedAt,facePixels:150,
      eyeAspectRatio:mode==='eyes_closed'&&index===0?.08:.3,eyeBlinkLeft:0,eyeBlinkRight:0,
      yawOffset:0,yawDeg:0,pitchDeg:index===1||mode==='book'||mode==='head_down'?25:0,
      mouthOpenRatio:mode==='yawn'&&index===0?.65:open?.25:.04,jawOpen:mode==='yawn'&&index===0?.8:open?.3:.03,
      phoneHeld:mode==='candidate'&&index===0?null:kind==='phone',bookInteraction:kind==='book',laptopInteraction:kind==='laptop',
      objectRegions:kind?[{kind,box:index===1?objectBoxes.book:kind==='book'?{x:.13,y:.79,width:.24,height:.14}:objectBoxes[kind],confidence:.9,observedAt,
        interaction:!(mode==='candidate'&&index===0)}]:[]};
    return {geometryId:index+1,personId:index+1,boxKind:'face',trackingState:'face',box,observation};
  });
},release(){},async close(){}};
try{
  server=createServer(createApp({engine}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.BACKEND_URL='http://127.0.0.1:'+server.address().port;
  const jpeg=await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg'));
  vite=await createVite({root:resolve(root,'frontend'),logLevel:'error',cacheDir:resolve(root,'.qa/vite-object-focus-cache'),
    plugins:[{name:'object-focus-fixture',configureServer(dev){dev.middlewares.use('/__qa/faces.jpg',(_request,response)=>{
      response.setHeader('Content-Type','image/jpeg');response.end(jpeg);
    });}}],server:{host:'127.0.0.1',port:0}});
  await vite.listen();
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--disable-gpu','--renderer-process-limit=1']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const nativeFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await nativeFetch(...args);
      if(/\/detect$/.test(String(args[0]))&&response.ok)window.__objectTracks=(await response.clone().json()).tracks;
      return response;
    };
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
      const image=new Image();image.src='/__qa/faces.jpg';await image.decode();
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const context=canvas.getContext('2d');
      const paint=()=>{
        context.drawImage(image,0,0,1280,720);
        context.fillStyle='#334155';context.fillRect(448,461,64,108);
        context.fillStyle='#f8fafc';context.fillRect(794,569,307,101);
        context.fillStyle='#0f766e';context.font='16px sans-serif';context.fillText('BOOK FIXTURE',860,620);
      };
      paint();const stream=canvas.captureStream(15),timer=setInterval(paint,60);
      for(const track of stream.getTracks()){
        const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};
      }
      return stream;
    }});
  });
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port,{waitUntil:'networkidle'});
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();
  await page.getByRole('option',{name:/Webcam máy tính/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();
  await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.waitForFunction(()=>window.__objectTracks?.[0]?.signals?.find(signal=>signal.type==='phone')?.state==='confirmed');
  await page.waitForFunction(()=>window.__objectTracks?.[1]?.studyContext==='book'&&window.__objectTracks[1].attention==='focused');
  assert.equal(await page.locator('.face-frame').count(),2);
  assert.equal(await page.locator('[data-object-kind="phone"][data-owner-id="A"]').count(),1);
  assert.equal(await page.locator('[data-object-kind="book"][data-owner-id="B"]').count(),1);
  assert.equal(await page.locator('[data-object-kind="phone"][data-owner-id="B"]').count(),0);
  const rect=await page.locator('[data-object-kind="phone"] .object-frame').evaluate(node=>({x:node.x.baseVal.value,
    y:node.y.baseVal.value,width:node.width.baseVal.value,height:node.height.baseVal.value,
    viewportWidth:node.ownerSVGElement.width.baseVal.value,viewportHeight:node.ownerSVGElement.height.baseVal.value}));
  assert(Math.abs(rect.x/rect.viewportWidth-objectBoxes.phone.x)<.001);
  assert(Math.abs(rect.y/rect.viewportHeight-objectBoxes.phone.y)<.001);
  await mkdir(resolve(root,'.qa'),{recursive:true});
  await page.screenshot({path:resolve(root,'.qa/object-focus-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Phóng to camera'}).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.object-frame').count(),2);
  await page.screenshot({path:resolve(root,'.qa/object-focus-mobile-expanded.png')});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:960});
  for(const next of candidateOnly?[]:['laptop','eyes_closed','head_down','yawn','talking']){
    console.log('Checking signal:',next);
    mode=next;phaseAt=Date.now();
    await page.getByRole('button',{name:'Đặt lại phiên nhận diện'}).click();
    await page.waitForFunction(type=>window.__objectTracks?.[0]?.signals?.find(signal=>signal.type===type)?.state==='confirmed',next,{timeout:15000});
    checked.push(next);
    console.log('Confirmed:',next);
  }
  mode='candidate';
  await page.getByRole('button',{name:'Đặt lại phiên nhận diện'}).click();
  await page.waitForFunction(()=>window.__objectTracks?.[0]?.objects?.[0]?.interaction===false&&window.__objectTracks[0].attention==='uncertain');
  assert.equal(await page.locator('[data-object-kind="phone"][data-interaction="unconfirmed"] .object-frame').count(),1);
  assert.match(await page.locator('[data-object-kind="phone"] text').textContent(),/Điện thoại.*HS A.*Chưa rõ tương tác/);
  await page.screenshot({path:resolve(root,'.qa/object-focus-candidate.png')});
  mode='delayed';
  await page.waitForFunction(()=>window.__objectTracks?.[0]?.objects?.[0]?.delayed===true);
  assert.equal(await page.locator('[data-object-kind="phone"] .object-frame').count(),1);
  assert.match(await page.locator('[data-object-kind="phone"] text').textContent(),/Điện thoại/);
  await page.screenshot({path:resolve(root,'.qa/object-focus-delayed.png')});
  mode='stale';
  console.log('Checking stale objects');
  await page.waitForFunction(()=>window.__objectTracks?.[0]?.objects?.length===0);
  assert.equal(await page.locator('[data-object-kind="phone"]').count(),0,'stale rectangles must disappear even while a phone alert is held');
  mode='lost';
  console.log('Checking lost owners');
  await page.waitForFunction(()=>window.__objectTracks?.every(track=>track.status==='lost'));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.object-frame').count(),0);
  assert.deepEqual(errors,[]);
  const result={status:'passed',syntheticMeasurements:true,physicalCameraAccessed:false,modelAccuracyMeasured:false,
    ownerAssociation:true,simultaneousFaceAndObjectBoxes:true,bookPostureContext:true,sixSignals:['phone',...checked],
    staleObjectRemoval:true,lostObjectRemoval:true,desktopAndExpandedMobile:true,detectedPhoneWithoutHandVisible:true,delayedObjectVisible:true};
  await writeFile(resolve(root,candidateOnly?'.qa/object-candidate-verification.json':'.qa/object-focus-verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}catch(error){
  if(browser)for(const context of browser.contexts())for(const page of context.pages()){
    console.error('Browser state:',await page.locator('body').innerText({timeout:3000}).catch(()=>''));
    console.error('Tracks:',await page.evaluate(()=>window.__objectTracks).catch(()=>[]));
    await page.screenshot({path:resolve(root,'.qa/object-focus-failure.png')});
  }
  throw error;
}finally{
  await browser?.close();await vite?.close();
  server?.closeAllConnections();
  if(server)await new Promise(resolve=>server.close(resolve));
}
