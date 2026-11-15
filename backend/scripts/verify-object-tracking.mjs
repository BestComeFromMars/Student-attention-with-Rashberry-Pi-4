// Real YOLO + VitTrack + worker/session/API on the USB webcam upload route.
// Real public object pixels have controlled independent motion. No Pi/camera.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
import {iou} from '../dist/geometry.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=resolve(root,'.qa/object-motion');
const prepared=spawnSync(resolve(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
  [resolve(root,'backend/ai/prepare_object_motion.py'),directory],{encoding:'utf8',windowsHide:true});
assert.equal(prepared.status,0,prepared.stderr||String(prepared.error));
const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
const engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
const server=createApp({engine}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api';
let sessionId;
const trace=[];
const visibleFace=track=>track.status==='visible'&&track.faceVisibility!=='unavailable'&&
  Boolean(track.faceBox||track.boxKind==='face');
const api=async(path,options={})=>{
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(35000)});
  assert(response.ok,path+': '+response.status+' '+await response.clone().text());
  return response.status===204?null:response.json();
};
try{
  ({sessionId}=await api('/sessions',{method:'POST'}));
  const detect=jpeg=>api('/sessions/'+sessionId+'/detect',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:jpeg});
  const initialImage=await readFile(resolve(directory,manifest.frames[0].path));
  let initial;
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
    initial=await detect(initialImage);
    if(initial.tracks.some(visibleFace)&&['phone','book'].every(kind=>initial.objects?.some(object=>object.kind===kind)))break;
    await delay(100);
  }
  assert(initial.tracks.some(visibleFace),'real face was not detected');
  assert(['phone','book'].every(kind=>initial.objects?.some(object=>object.kind===kind)),JSON.stringify({initial,metrics:engine.metrics}));
  const ids=Object.fromEntries(initial.objects.map(object=>[object.kind,object.id]));
  const reference=initial.tracks.find(visibleFace),referenceBox=reference.faceBox??reference.box;
  for(const frame of manifest.frames){
    const result=await detect(await readFile(resolve(directory,frame.path)));
    const row={path:frame.path,dx:frame.dx,objects:result.objects,tracks:result.tracks.map(track=>({id:track.id,box:track.box,status:track.status})),errors:[]};
    trace.push(row);
    for(const kind of ['phone','book']){
      const object=result.objects.find(object=>object.kind===kind);
      assert(object,'missing '+kind+' at '+frame.path+': '+JSON.stringify({trace,metrics:engine.metrics}));
      assert.equal(object.id,ids[kind],'independent object ID changed');
      const gold=frame[kind],box=object.box;
      const centerError=Math.hypot((box.x+box.width/2-gold.x-gold.width/2)*640,(box.y+box.height/2-gold.y-gold.height/2)*480);
      const overlap=iou(box,gold);row.errors.push({kind,centerError,iou:overlap});
      assert(centerError<25&&overlap>.45,'object must follow its own pixels: '+JSON.stringify(row));
      assert.notDeepEqual(object.box,reference.box,'face and object cannot share a rectangle');
    }
    const face=result.tracks.find(track=>track.id===reference.id&&visibleFace(track));
    assert(face,'the fixed face must remain independently visible');
    const faceBox=face.faceBox??face.box;
    assert(Math.abs(faceBox.x+faceBox.width/2-referenceBox.x-referenceBox.width/2)*640<16,'phone motion moved the face box');
    await delay(100);
  }
  const objectsOnly=await readFile(resolve(directory,'objects-only.jpg'));
  let withoutFace;
  const faceDeadline=Date.now()+12000;
  do{
    withoutFace=await detect(objectsOnly);await delay(100);
  }while(Date.now()<faceDeadline&&withoutFace.tracks.some(visibleFace));
  assert(!withoutFace.tracks.some(visibleFace),'face removal was not detected');
  assert(withoutFace.objects.some(object=>object.kind==='phone'),'object must survive face loss');
  const empty=await readFile(resolve(directory,'empty.jpg'));
  let removed;
  const emptyDeadline=Date.now()+12000;
  do{removed=await detect(empty);await delay(100);}while(Date.now()<emptyDeadline&&removed.objects.length);
  assert.equal(removed.objects.length,0,'removed objects must not remain locked on the background');
  const report={status:'passed',actualModels:true,physicalUsbCamera:false,source:'USB/webcam JPEG upload API',piUsed:false,
    controlledRealObjectPixels:true,frames:trace.length,independentFaceAndObjectBoxes:true,stableObjectIds:true,
    objectsSurviveFaceLoss:true,removedObjectsCleared:true,trace,initial,withoutFace,
    capabilities:engine.capabilities};
  await writeFile(resolve(root,'.qa/usb-object-tracking.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,trace:undefined,initial:undefined,withoutFace:undefined}));
}finally{
  if(sessionId)await api('/sessions/'+sessionId,{method:'DELETE'}).catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await engine.close();
}
