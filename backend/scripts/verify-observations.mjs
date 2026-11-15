import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createInferenceEngine} from '../dist/inference.js';
import {createApp} from '../dist/app.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(root,'.qa/observation-upgrade');await mkdir(output,{recursive:true});
const report={startedAt:new Date().toISOString(),completed:false,passed:false,accuracyVerified:false,
  scope:'Real models over HTTP. One repeated public portrait and one clock-paced 10-second classroom clip. No physical camera, no behavior accuracy labels.',cases:[]};
let engine,server;
delete process.env.AI_CLASSROOM_ACTIONS;delete process.env.AI_ACTIONS_EXPERIMENTAL;
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)*p)]??0;};
try{
  const directory=resolve(root,'.qa/video-export-ui/class_6_input_frames');
  const metadata=JSON.parse(await readFile(resolve(directory,'metadata.json'),'utf8'));
  const portrait=await readFile(resolve(root,'backend/test-fixtures/portrait.jpg'));
  engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
  report.capabilities=engine.capabilities;
  server=createServer(createApp({engine}));await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const api='http://127.0.0.1:'+server.address().port+'/api';
  const cases=[{name:'single',duration:30000,minPeople:1,frame:async()=>portrait,source:'Repeated public portrait; fresh inference timestamps, not a motion benchmark'},
    {name:'classroom',duration:metadata.frames/metadata.fps*1000,minPeople:2,
      source:metadata.video+'; source FPS '+metadata.fps+'; one pass, no looping',
      frame:async elapsed=>readFile(resolve(directory,String(Math.min(metadata.frames,Math.floor(elapsed*metadata.fps/1000)+1)).padStart(6,'0')+'.jpg'))}];
  const only=process.argv.indexOf('--case');
  for(const test of cases.filter(test=>only<0||test.name===process.argv[only+1])){
    const created=await fetch(api+'/sessions',{method:'POST'});if(!created.ok)throw Error('Session creation failed');
    const {sessionId}=await created.json();const samples=[],failures=[];let personSamples=0,poseSamples=0,eligibleSamples=0,headReadySamples=0,postureReadySamples=0;
    let lastProgress=0,latest;const start=Date.now();
    try{
      while(Date.now()-start<test.duration){
        const elapsed=Date.now()-start,frame=await test.frame(elapsed),sent=Date.now();
        const response=await fetch(api+'/sessions/'+sessionId+'/detect',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:frame,signal:AbortSignal.timeout(35000)});
        const result=await response.json();if(!response.ok)throw Error(response.status+': '+JSON.stringify(result));
        const now=Date.now(),tracks=result.tracks.filter(t=>t.status==='visible');latest=result;
        const metrics=engine.metrics??{};
        for(const key of ['analysisError','geometryError','objectTrackingError'])if(metrics[key]&&!failures.some(f=>f.key===key&&f.error===metrics[key]))failures.push({key,error:metrics[key]});
        for(const track of tracks){
          personSamples++;const pose=track.observation?.bodyPose;
          if(pose&&now-pose.observedAt>=0&&now-pose.observedAt<=2000){
            poseSamples++;const known=i=>pose.keypoints[i]?.confidence>=.35;
            if(known(5)&&known(6)&&((known(11)&&known(12))||(known(7)&&known(8))))eligibleSamples++;
          }
          if(track.calibration?.headingReady)headReadySamples++;
          if(track.calibration?.postureReady)postureReadySamples++;
        }
        const row={elapsedMs:elapsed,latencyMs:now-sent,people:tracks.length,faces:tracks.filter(t=>t.faceVisibility==='visible'||t.boxKind==='face').length,
          privateMB:Number(metrics.privateMemoryMB)||0,poseLatencyMs:metrics.poseLatencyMs,
          poseDetections:metrics.poseDetections,poseMatches:metrics.poseMatches,
          poseBodyCandidates:metrics.poseBodyCandidates,poseBestIoU:metrics.poseBestIoU};samples.push(row);
        if(elapsed-lastProgress>10000||samples.length===1){console.log(test.name+': '+Math.round(elapsed/1000)+'s | people '+row.people+' | AI '+row.privateMB+' MB');lastProgress=elapsed;}
        await delay(Math.max(0,200-(Date.now()-sent)));
      }
    }finally{await fetch(api+'/sessions/'+sessionId,{method:'DELETE'});}
    const peak=Math.max(0,...samples.map(s=>s.privateMB)),p95=percentile(samples.map(s=>s.latencyMs),.95);
    const maxPeople=Math.max(0,...samples.map(s=>s.people));
    const row={name:test.name,source:test.source,durationSeconds:(Date.now()-start)/1000,requests:samples.length,maxPeople,
      p50LatencyMs:percentile(samples.map(s=>s.latencyMs),.5),p95LatencyMs:p95,peakPrivateMB:peak,
      poseCoveragePct:100*poseSamples/Math.max(1,personSamples),eligibleUpperBodyPct:100*eligibleSamples/Math.max(1,personSamples),
      headingReferenceCoveragePct:100*headReadySamples/Math.max(1,personSamples),postureReferenceCoveragePct:100*postureReadySamples/Math.max(1,personSamples),
      failures,passed:failures.length===0&&maxPeople>=test.minPeople&&poseSamples>0&&peak>0&&peak<=2048&&p95<=2500};
    report.cases.push(row);
    await writeFile(resolve(output,test.name+'-latest.json'),JSON.stringify(latest,null,2));
    await writeFile(resolve(output,test.name+'-timings.json'),JSON.stringify(samples,null,2));
    console.log(JSON.stringify(row));
  }
  report.completed=true;report.passed=report.cases.every(test=>test.passed)&&engine.capabilities?.attentionScoring===false;
  if(!report.passed)process.exitCode=1;
}catch(error){report.error=error.stack??String(error);process.exitCode=1;console.error(error.message);}
finally{
  if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
  await engine?.close();report.finishedAt=new Date().toISOString();
  await writeFile(resolve(output,'runtime.json'),JSON.stringify(report,null,2));
  console.log('Observation runtime report: '+resolve(output,'runtime.json'));
}
