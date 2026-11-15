// Actual production API, paced source video clock, one latest-frame request.
// This is a stability test on local CDED footage, not a SAV accuracy result.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const duration=Number(value('--seconds','900'))*1000;
const coreOnly=args.includes('--core-only');
const scb=args.includes('--scb');
if(scb){process.env.AI_CLASSROOM_ACTIONS='1';delete process.env.AI_ACTIONS_EXPERIMENTAL;}
else {delete process.env.AI_CLASSROOM_ACTIONS;if(coreOnly)delete process.env.AI_ACTIONS_EXPERIMENTAL;else process.env.AI_ACTIONS_EXPERIMENTAL='1';}
const reportName=scb?'stability-scb':coreOnly?'stability-core':'stability';
const source=resolve(root,value('--source','.qa/video-export-ui/class_6_input_frames'));
const output=resolve(root,'.qa/action-demo');await mkdir(output,{recursive:true});
const info=JSON.parse(await readFile(resolve(source,'metadata.json'),'utf8'));
let engine,server,sessionId,log;const failures=[],samples=[];
try{
  engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
  server=createServer(createApp({engine}));await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const api='http://127.0.0.1:'+server.address().port+'/api';
  const created=await fetch(api+'/sessions',{method:'POST'});sessionId=(await created.json()).sessionId;
  log=await open(resolve(output,reportName+'-frames.jsonl'),'w');
  const start=Date.now();let sequence=0,lastProgress=0;
  while(Date.now()-start<duration){
    const elapsed=Date.now()-start,frame=Math.floor(elapsed*info.fps/1000)%info.frames+1;
    const jpeg=await readFile(resolve(source,String(frame).padStart(6,'0')+'.jpg'));
    const sent=Date.now();
    const response=await fetch(api+'/sessions/'+sessionId+'/detect',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:jpeg,signal:AbortSignal.timeout(35000)});
    const data=await response.json();if(!response.ok)throw Error(response.status+': '+JSON.stringify(data));
    const metrics=engine.metrics??{};
    for(const key of ['analysisError','geometryError','objectTrackingError','actionsError'])if(metrics[key]){
      const existing=failures.find(f=>f.key===key&&f.error===metrics[key]);
      if(existing)existing.occurrences++;else failures.push({at:elapsed,key,error:metrics[key],occurrences:1});
    }
    const row={elapsedMs:elapsed,sourceFrame:frame,latencyMs:Date.now()-sent,people:data.tracks.length,
      faces:data.tracks.filter(t=>t.faceVisibility==='visible'||t.boxKind==='face').length,
      confirmedActions:data.tracks.flatMap(t=>t.actions??[]).filter(a=>a.state==='confirmed').length,metrics};
    samples.push(row);await log.write(JSON.stringify({...row,tracks:data.tracks,objects:data.objects})+'\n');sequence++;
    if(elapsed-lastProgress>=15000||sequence===1){console.log(`stability ${Math.round(elapsed/1000)}/${duration/1000}s | people ${row.people} | faces ${row.faces} | actions ${row.confirmedActions} | AI ${metrics.privateMemoryMB} MB`);lastProgress=elapsed;}
    await delay(Math.max(0,83-(Date.now()-sent)));
  }
  await fetch(api+'/sessions/'+sessionId,{method:'DELETE'});sessionId=null;
  const sorted=samples.map(s=>s.latencyMs).sort((a,b)=>a-b),peak=Math.max(...samples.map(s=>Number(s.metrics.privateMemoryMB)||0));
  const corePassed=failures.every(f=>f.key==='actionsError')&&peak<=2048;
  const fullDropoutFrames=samples.filter(s=>s.elapsedMs>3000&&s.people===0).length;
  const actionsConfirmedAtLeastOnce=samples.some(s=>s.confirmedActions>0);
  const report={completed:true,durationSeconds:(Date.now()-start)/1000,source:info.video,sourceFps:info.fps,sourceClockPaced:true,corePassed,
    inferenceFrames:samples.length,maxPeople:Math.max(...samples.map(s=>s.people)),maxConfirmedActions:Math.max(...samples.map(s=>s.confirmedActions)),
    peakPrivateMB:peak,p95LatencyMs:sorted[Math.floor((sorted.length-1)*.95)],failures,
    fullDropoutFrames,actionsConfirmedAtLeastOnce,
    passed:failures.length===0&&peak<=2048&&fullDropoutFrames===0&&(coreOnly||actionsConfirmedAtLeastOnce),accuracyVerified:false,capabilities:engine.capabilities};
  await writeFile(resolve(output,reportName+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
  await writeFile(resolve(output,reportName+'.json'),JSON.stringify({completed:false,passed:false,accuracyVerified:false,
    error:error.message,inferenceFrames:samples.length,failures},null,2));
  throw error;
}finally{
  await log?.close();if(server)await new Promise(done=>server.close(done));await engine?.close();
}
