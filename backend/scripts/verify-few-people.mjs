// Real models, public still fixtures shifted in RAM. No physical camera access.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
const root=new URL('../../',import.meta.url);
const engine=await createInferenceEngine(fileURLToPath(new URL('../models/classroom/',import.meta.url)));
const server=createApp({engine}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api';
async function api(path,options={}){
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(35000)});
  assert(response.ok,path+': '+response.status);
  return response.status===204?null:response.json();
}
const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
const report={checkedAt:new Date().toISOString(),note:'Real worker + HTTP; public fixture translated in memory. Measures inference, not physical webcam/display FPS.',cases:[]};
try{
  const original=await readFile(new URL('../test-fixtures/faces/two-frontal-profile.jpg',import.meta.url));
  const single=await sharp(original).composite([{input:await sharp({create:{width:640,height:720,channels:3,background:'#dcdcdc'}}).png().toBuffer(),left:640,top:0}]).jpeg({quality:84}).toBuffer();
  const blank=await sharp({create:{width:1280,height:720,channels:3,background:'#dcdcdc'}}).jpeg().toBuffer();
  for(const [expected,image] of [[1,single],[2,original]]){
    const images=[];
    for(const shift of [0,8,16,24,16,8])images.push(shift?await sharp(image).extract({left:0,top:0,width:1280-shift,height:720}).extend({left:shift,right:0,top:0,bottom:0,background:'#dcdcdc'}).jpeg({quality:84}).toBuffer():image);
    const {sessionId}=await api('/sessions',{method:'POST'});
    const detect=async jpeg=>{
      const started=performance.now();
      const response=await api('/sessions/'+sessionId+'/detect',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:jpeg});
      return {ms:performance.now()-started,count:response.tracks.filter(t=>t.status==='visible').length,metrics:{...engine.metrics}};
    };
    try{
      const startup=await detect(image);
      for(let i=0;i<15;i++){await detect(image);await delay(33);}
      const trace=[];const started=performance.now();
      while(performance.now()-started<6000){
        const at=performance.now();trace.push(await detect(images[trace.length%images.length]));
        await delay(Math.max(0,1000/30-(performance.now()-at)));
      }
      const elapsed=performance.now()-started;
      const reacquisitions=[];
      for(let attempt=0;attempt<3;attempt++){
        const hidden=performance.now();while(performance.now()-hidden<1200){await detect(blank);await delay(33);}
        const back=performance.now();let result;
        do {result=await detect(image);if(result.count===expected)break;await delay(16);}while(performance.now()-back<3000);
        reacquisitions.push({ms:performance.now()-back,count:result.count});
        for(let i=0;i<6;i++){await detect(image);await delay(33);}
      }
      const row={expected,startupMs:startup.ms,responses:trace.length,fps:trace.length*1000/elapsed,
        p50Ms:quantile(trace.map(t=>t.ms),.5),p95Ms:quantile(trace.map(t=>t.ms),.95),maxMs:Math.max(...trace.map(t=>t.ms)),
        fullCount:trace.filter(t=>t.count===expected).length,reacquisitions,trace};
      report.cases.push(row);
      console.log(JSON.stringify({...row,trace:undefined}));
    }finally{await api('/sessions/'+sessionId,{method:'DELETE'});}
  }
  await mkdir(new URL('.qa/',root),{recursive:true});
  await writeFile(new URL('.qa/'+(process.env.FEW_PEOPLE_REPORT||'few-people-performance.json'),root),JSON.stringify(report,null,2));
  for(const row of report.cases){assert(row.fullCount>=row.responses*.95,'faces remain present');assert(row.reacquisitions.every(r=>r.count===row.expected),'faces return after occlusion');}
}finally{await engine.close();await new Promise(resolve=>server.close(resolve));}
