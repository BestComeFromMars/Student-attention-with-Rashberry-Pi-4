// Real models and both camera APIs; public fixture translated in RAM.
// This is controlled motion, not a physical-camera accuracy measurement.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
import {PiSource} from '../dist/pi-source.js';
import {iou} from '../dist/geometry.js';

// Approximate face ROIs marked on the public source image, independently of
// the tracker. Transform these annotations, not an earlier model prediction.
const referenceFaces=[{x:213/1280,y:249/720,width:193/1280,height:287/720},
  {x:830/1280,y:246/720,width:185/1280,height:283/720}];

const engine=await createInferenceEngine(fileURLToPath(new URL('../models/classroom/',import.meta.url)));
const pi=new PiSource();
const server=createApp({engine,pi}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api';
async function api(path,options={}) {
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(35000)});
  assert(response.ok,path+': '+response.status);
  return response.status===204 ? null : response.json();
}
const report={note:'Real worker + upload/Pi routes, translated public fixture; Pi disconnected.',sources:[]};
try {
  const original=await readFile(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url));
  const images=new Map([[0,original]]);
  for(const shift of [48,96,144]) images.set(shift,await sharp(original)
    .extract({left:0,top:0,width:1280-shift,height:720})
    .extend({left:shift,right:0,top:0,bottom:0,background:'#dcdcdc'}).jpeg({quality:90}).toBuffer());
  const scaleSteps=[1.06,1.12,1.2,1.28,1.2,1.12,1.06,1,.94,.88,.82,.88,.94,1];
  const zoomImages=new Map();
  for(const scale of new Set(scaleSteps)) {
    const width=Math.round(1280*scale),height=Math.round(720*scale);
    let zoom=sharp(original).resize(width,height);
    if(scale>=1) zoom=zoom.extract({left:Math.floor((width-1280)/2),top:Math.floor((height-720)/2),width:1280,height:720});
    else zoom=zoom.extend({left:Math.floor((1280-width)/2),right:Math.ceil((1280-width)/2),
      top:Math.floor((720-height)/2),bottom:Math.ceil((720-height)/2),background:'#dcdcdc'});
    zoomImages.set(scale,await zoom.jpeg({quality:90}).toBuffer());
  }
  for(const source of ['upload','pi-route']) {
    const {sessionId}=await api('/sessions',{method:'POST'});
    const trace=[];
    const detect=async image=>{
      if(source==='pi-route') await pi.update(image);
      return api('/sessions/'+sessionId+'/detect'+(source==='pi-route'?'/pi':''),{
        method:'POST',...(source==='upload'?{headers:{'Content-Type':'image/jpeg'},body:image}:{}),
      });
    };
    try {
      let initial;
      for(let i=0;i<8;i++){initial=(await detect(original)).tracks;await delay(120);}
      assert.equal(initial.length,2);
      for(const shift of [48,96,144,96,48,0,48,96,144,96,48,0]) {
        const started=performance.now();
        const {tracks}=await detect(images.get(shift));
        const row={shift,ms:performance.now()-started,centerErrorsPx:[],tracks:tracks.map(t=>({id:t.id,box:t.box,state:t.trackingState}))};
        trace.push(row);
        for(const before of initial){
          const current=tracks.find(track=>track.id===before.id);
          assert(current,'same ID must remain available during controlled fast movement: '+JSON.stringify(trace));
          const expected=before.box.x+before.box.width/2+shift/1280;
          const error=Math.abs(current.box.x+current.box.width/2-expected)*1280;
          row.centerErrorsPx.push(error);
          assert(error<65,'face center must follow the translated image: '+JSON.stringify({error,trace}));
        }
        assert.equal(tracks.length,2,'no duplicate tracks');
        assert(!engine.metrics?.geometryError);
        await delay(100);
      }
      const zoomTrace=[];
      for(const scale of scaleSteps) {
        const started=performance.now();
        const {tracks}=await detect(zoomImages.get(scale));
        const row={scale,ms:performance.now()-started,errors:[]};
        zoomTrace.push(row);
        assert.equal(tracks.length,2,'zoom must not create duplicate tracks');
        for(const [index,before] of initial.entries()) {
          const current=tracks.find(track=>track.id===before.id);
          assert(current,'near/far motion must keep the same ID');
          const expectedWidth=before.box.width*scale,expectedHeight=before.box.height*scale;
          const widthError=Math.abs(current.box.width/expectedWidth-1);
          const heightError=Math.abs(current.box.height/expectedHeight-1);
          const gold=referenceFaces[index];
          const expected={x:.5+(gold.x-.5)*scale,y:.5+(gold.y-.5)*scale,width:gold.width*scale,height:gold.height*scale};
          const overlap=iou(current.box,expected);
          row.errors.push({id:current.id,widthError,heightError,iou:overlap});
          assert(overlap>.6,'near/far box must overlap the independently transformed face ROI: '+JSON.stringify(zoomTrace));
        }
        await delay(100);
      }
      report.sources.push({source,trace,zoomTrace});
    } finally {await api('/sessions/'+sessionId,{method:'DELETE'});}
  }
  await mkdir(new URL('../../.qa/',import.meta.url),{recursive:true});
  await writeFile(new URL('../../.qa/tracking-motion.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,sources:report.sources.map(s=>({source:s.source,frames:s.trace.length}))}));
} finally {await engine.close();await new Promise(resolve=>server.close(resolve));}
