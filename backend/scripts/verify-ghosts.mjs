// A public face moves abruptly over textured background, then exits. No webcam.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
import {PiSource} from '../dist/pi-source.js';
const engine=await createInferenceEngine(fileURLToPath(new URL('../models/classroom/',import.meta.url)));
const pi=new PiSource(),server=createApp({engine,pi}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api';
async function api(path,options={}){
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(35000)});
  assert(response.ok,path+': '+response.status);
  return response.status===204?null:response.json();
}
const report={note:'Public fixture composited in RAM; abrupt motion and exit, textured background; no physical camera.',sources:[]};
try {
  const original=await readFile(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url));
  const portrait=await sharp(original).extract({left:160,top:180,width:360,height:480}).png().toBuffer();
  const pixels=Buffer.alloc(1280*720*3);
  for(let y=0;y<720;y++)for(let x=0;x<1280;x++){
    const at=(y*1280+x)*3,value=(x%47<3 || y%53<3)?110:200;
    pixels[at]=value;pixels[at+1]=value+10;pixels[at+2]=value+20;
  }
  const background=await sharp(pixels,{raw:{width:1280,height:720,channels:3}}).png().toBuffer();
  const initial=await sharp(background).composite([{input:portrait,left:100,top:120}]).jpeg({quality:90}).toBuffer();
  const moved=await sharp(background).composite([{input:portrait,left:550,top:120}]).jpeg({quality:90}).toBuffer();
  const blank=await sharp(background).jpeg().toBuffer();
  for(const source of ['upload','pi-route']) {
    const {sessionId}=await api('/sessions',{method:'POST'});
    const trace=[];
    const detect=async image=>{
      if(source==='pi-route')await pi.update(image);
      return api('/sessions/'+sessionId+'/detect'+(source==='pi-route'?'/pi':''),{
        method:'POST',...(source==='upload'?{headers:{'Content-Type':'image/jpeg'},body:image}:{}),
      });
    };
    try {
      let tracks;
      for(let i=0;i<8;i++){({tracks}=await detect(initial));await delay(100);}
      assert.equal(tracks.filter(t=>t.status==='visible').length,1,'one person initially');
      for(const [phase,image] of [['moved',moved],['exit',blank]]) {
        const started=performance.now();let stable=0;
        while(performance.now()-started<4500){
          ({tracks}=await detect(image));
          const visible=tracks.filter(t=>t.status==='visible');
          const frames=tracks.filter(t=>t.trackingState!=='predicted');
          const elapsed=performance.now()-started;
          trace.push({phase,elapsedMs:Math.round(elapsed),tracks:tracks.map(t=>({id:t.id,state:t.trackingState,status:t.status,box:t.box}))});
          const good=phase==='moved'?visible.length===1 && frames.length===1 && visible[0].box.x>.4:visible.length===0 && frames.length===0;
          stable=good?stable+1:0;
          if(elapsed>2000 && stable>=4)break;
          await delay(100);
        }
        assert(stable>=4,'old ROI must not remain a camera face after '+phase+': '+JSON.stringify(trace));
      }
      report.sources.push({source,trace});
    } finally {await api('/sessions/'+sessionId,{method:'DELETE'});}
  }
  await mkdir(new URL('../../.qa/',import.meta.url),{recursive:true});
  await writeFile(new URL('../../.qa/ghost-verification.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,sources:report.sources.map(s=>s.source)}));
} finally {await engine.close();await new Promise(resolve=>server.close(resolve));}
