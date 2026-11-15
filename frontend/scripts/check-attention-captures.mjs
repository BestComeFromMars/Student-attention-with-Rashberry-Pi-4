// Production frontend/session/HTTP evaluator with a prerecorded image as camera.
// No physical webcam, Pi commands or inference accuracy claim.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createApp} from '../../backend/dist/app.js';
import {Sessions} from '../../backend/dist/sessions.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),dist=resolve(root,'frontend/dist'),work=resolve(root,'.qa/attention-captures');
await mkdir(resolve(work,'.tmp'),{recursive:true});for(const key of ['TEMP','TMP','TMPDIR'])process.env[key]=resolve(work,'.tmp');
const imagePath=resolve(root,'.qa/class_3-stable/class_3_input_frames/000266.jpg');
const source=await readFile(imagePath);
let now=Date.now(),mode='warnings',calls=0;
const people=[{personId:7,geometryId:7,box:{x:.02,y:.64,width:.13,height:.23},faceBox:{x:.05,y:.68,width:.036,height:.072}},
  {personId:8,geometryId:8,box:{x:.79,y:.66,width:.13,height:.18},faceBox:{x:.86,y:.68,width:.035,height:.06}},
  {personId:9,box:{x:.13,y:.5,width:.075,height:.11}}];
const engine={ready:true,close:async()=>{},release:()=>{},detect:async()=>[],detectFrame:async()=>{
  calls++;now+=250;
  const enabled=mode==='warnings'||mode==='hidden';
  return {frameAt:now,objects:[],people:people.map((p,index)=>{
    const hidden=!p.faceBox||mode==='hidden';
    const faceBox=hidden?undefined:p.faceBox;
    return {...p,faceBox,personBox:p.box,boxKind:'person',trackingState:'face',faceVisibility:hidden?'unavailable':'visible',
      observation:{valid:!hidden,facePixels:90,mouthValid:!hidden,mouthSource:'face_landmarker',eyeAspectRatio:.3,yawOffset:0,
        yawDeg:0,pitchDeg:0,mouthOpenRatio:.05,observedAt:now,objectsAt:now,
        phoneHeld:enabled&&index===0,laptopInteraction:enabled&&index===1,bookInteraction:false,
        deskRest:{active:enabled&&index===2,confidence:enabled&&index===2?.7:0,personConfidence:.3,observedAt:now}}};
  })};
}};
const app=createApp({engine,sessions:new Sessions(()=>now)});
const server=createServer(async(request,response)=>{
  if(request.url.startsWith('/api/'))return app(request,response);
  if(request.url==='/__capture-source.jpg'){response.writeHead(200,{'Content-Type':'image/jpeg'});response.end(source);return;}
  try{const path=resolve(dist,'.'+(request.url==='/'?'/index.html':decodeURIComponent(request.url.split('?')[0]))),local=relative(dist,path);
    if(local.startsWith('..')||isAbsolute(local)){response.writeHead(403).end();return;}
    response.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'}[extname(path)]??'application/octet-stream'});response.end(await readFile(path));
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.__openedCamera=0;window.__stoppedCamera=0;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{enumerateDevices:async()=>[{kind:'videoinput',deviceId:'test-camera',label:'Camera ảnh thử',groupId:'test'}],
      addEventListener(){},removeEventListener(){},getUserMedia:async()=>{
        window.__openedCamera++;
        const canvas=document.createElement('canvas');canvas.width=1906;canvas.height=1080;
        const ctx=canvas.getContext('2d'),img=new Image();img.src='/__capture-source.jpg';await img.decode();
        const paint=()=>ctx.drawImage(img,0,0);paint();const stream=canvas.captureStream(15),timer=setInterval(paint,66);
        for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);window.__stoppedCamera++;stop();};}
        return stream;
      }}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  assert.equal(await page.getByRole('region',{name:'Sơ đồ lớp học'}).count(),0);
  await page.getByRole('region',{name:'Danh sách cần chú ý'}).waitFor();
  await page.getByRole('combobox',{name:'Chọn webcam'}).click();await page.getByRole('option',{name:/Camera ảnh thử/}).click();
  await page.getByRole('button',{name:'Bật camera',exact:true}).click();await page.getByRole('button',{name:'Bắt đầu nhận diện',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.attention-card').length===3);
  const panel=page.getByRole('region',{name:'Danh sách cần chú ý'});
  assert.equal(await panel.locator('img').count(),2);assert.equal(await panel.getByText('Chưa chụp được mặt').count(),1);
  assert(await panel.getByText('Có dấu hiệu gục đầu/thân trên').count());
  const photos=await panel.locator('img').evaluateAll(nodes=>nodes.map(img=>({width:img.naturalWidth,height:img.naturalHeight,src:img.src})));
  assert(photos.every(p=>p.width===160&&p.height===160&&p.src.startsWith('data:image/jpeg;base64,')));
  const pair=await page.evaluate(()=>{
    const card=document.querySelector('[data-capture-id="A"] img'),frame=document.querySelector('.analysis-frame');
    const thumb=document.createElement('canvas');thumb.width=thumb.height=160;thumb.getContext('2d').drawImage(card,0,0,160,160);
    const b={x:.05,y:.68,width:.036,height:.072},side=Math.max(b.width*frame.width,b.height*frame.height)*1.2;
    const expected=document.createElement('canvas');expected.width=expected.height=160;
    expected.getContext('2d').drawImage(frame,(b.x+b.width/2)*frame.width-side/2,(b.y+b.height/2)*frame.height-side/2,side,side,0,0,160,160);
    const a=thumb.getContext('2d').getImageData(0,0,160,160).data,c=expected.getContext('2d').getImageData(0,0,160,160).data;
    let difference=0;for(let i=0;i<a.length;i+=4)difference+=Math.abs(a[i]-c[i])+Math.abs(a[i+1]-c[i+1])+Math.abs(a[i+2]-c[i+2]);
    return difference/(160*160*3);
  });
  assert(pair<18,'Captured image must match the face crop of the paired frame, allowing JPEG compression');
  const first=await panel.locator('[data-capture-id="A"] img').getAttribute('src');
  await page.getByRole('button',{name:'Phóng to camera'}).click();assert(await panel.evaluate(node=>node.inert));
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.__openedCamera),1);
  await panel.getByRole('button',{name:'Đổi tên Học sinh A'}).click();await panel.getByRole('textbox',{name:'Tên học sinh A'}).fill('Minh Anh');
  await panel.getByRole('textbox',{name:'Tên học sinh A'}).press('Enter');await panel.getByRole('button',{name:'Đổi tên Minh Anh'}).waitFor();
  assert.equal(await panel.locator('[data-capture-id="A"] img').getAttribute('src'),first);
  await page.screenshot({path:resolve(work,'desktop.png')});
  await page.getByRole('button',{name:'Tạm dừng nhận diện',exact:true}).click();assert.equal(await panel.locator('.attention-card').count(),3);
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:resolve(work,'mobile.png')});
  await panel.getByRole('button',{name:'Xóa danh sách cần chú ý'}).click();assert.equal(await panel.locator('.attention-card').count(),0);
  assert.equal(await page.evaluate(()=>window.__stoppedCamera),0);
  mode='clear';await page.getByRole('button',{name:'Tiếp tục nhận diện',exact:true}).click();
  const afterClear=calls;await page.waitForFunction(()=>document.querySelectorAll('.person-frame').length===3);
  // Await actual responses rather than sleeping; held alerts expire on the source clock.
  while(calls-afterClear<25)await page.waitForResponse(response=>response.url().includes('/detect')&&response.ok());
  mode='warnings';await page.waitForFunction(()=>document.querySelectorAll('.attention-card').length===3);
  await page.getByRole('button',{name:'Tắt camera',exact:true}).click();assert.equal(await panel.locator('.attention-card').count(),0);
  assert.equal(await page.evaluate(()=>window.__stoppedCamera),1);
  assert.deepEqual(errors,[]);
  const report={passed:true,pairedCropMeanAbsolutePixelError:pair,portraits:2,missingFacePlaceholders:1,thumbnailSize:160,
    checks:['map removed','paired-image face crops','no body as face','name edit','camera expansion','pause retains records','clear list leaves camera on','new warnings recaptured','stop clears portraits','desktop/mobile'],
    scope:'Production UI/session and HTTP evaluation with prerecorded image + controlled measurements. No physical camera or Pi interaction; not model accuracy.'};
  await writeFile(resolve(work,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
