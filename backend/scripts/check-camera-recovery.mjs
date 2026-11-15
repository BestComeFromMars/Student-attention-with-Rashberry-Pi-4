// Actual pretrained backend pipeline, one continuous session; no camera/Pi access.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createInferenceEngine} from '../dist/inference.js';
import {Sessions} from '../dist/sessions.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),work=resolve(root,'.qa/camera-recovery');
await mkdir(work,{recursive:true});
const image=await readFile(resolve(root,'backend/test-fixtures/faces/two-frontal-profile.jpg'));
const meta=await sharp(image).metadata(),width=meta.width,height=meta.height;
const gray={r:220,g:220,b:220};
const cover=await sharp({create:{width:Math.ceil(width/2),height,channels:3,background:gray}}).png().toBuffer();
const one=await sharp(image).composite([{input:cover,left:Math.floor(width/2),top:0}]).jpeg({quality:90}).toBuffer();
const blank=await sharp({create:{width,height,channels:3,background:gray}}).jpeg().toBuffer();
const moved=new Map();
const padded=await sharp(image).extend({left:80,right:80,top:60,bottom:60,background:gray}).png().toBuffer();
for(const [name,dx,dy]of [['left',-60,0],['right',60,0],['up',0,-40],['down',0,40]]){
  const frames=[];
  for(let n=0;n<=6;n++)frames.push(await sharp(padded)
    .extract({left:80-Math.round(dx*n/6),top:60-Math.round(dy*n/6),width,height}).jpeg({quality:90}).toBuffer());
  moved.set(name,frames);
}
const engine=await createInferenceEngine(resolve(root,'backend/models/classroom'));
const sessions=new Sessions(),id=sessions.create(),phases=[],metrics=[];
async function run(name,duration,source,expected){
  const start=performance.now(),samples=[];let last,step=0;
  while(performance.now()-start<duration||samples.length<4){
    const jpeg=typeof source==='function'?source(step++):Array.isArray(source)?source[Math.min(source.length-1,step++)]:source;
    const before=performance.now(),tracks=await sessions.detect(id,jpeg,engine);
    const current=tracks.filter(t=>t.status==='visible');
    const faces=current.filter(t=>t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face'));
    samples.push({ms:Math.round(performance.now()-start),latencyMs:Math.round(performance.now()-before),faces:faces.length,bodies:current.filter(t=>t.personBox).length,
      ids:faces.map(t=>t.id),personIds:faces.map(t=>t.personId??null),geometryIds:faces.map(t=>t.geometryId)});
    for(const key of ['analysisError','geometryError','objectTrackingError','bodyError','poseError'])assert(!engine.metrics?.[key],`${name}: ${key}: ${engine.metrics?.[key]}`);
    metrics.push({...engine.metrics});last={tracks,objects:sessions.objects(id)};
    await delay(50);
  }
  const tail=samples.slice(-4),lastFaces=tail.map(s=>s.faces);
  const result={name,frames:samples.length,elapsedMs:Math.round(performance.now()-start),expectedFaces:expected,
    maximumFaces:Math.max(...samples.map(s=>s.faces)),maximumBodies:Math.max(...samples.map(s=>s.bodies)),lastFaces,
    tailIds:tail.map(s=>s.ids),samples};
  phases.push(result);await writeFile(resolve(work,'report.json'),JSON.stringify({complete:false,phases},null,2));
  await writeFile(resolve(work,name+'.json'),JSON.stringify(last));console.log(JSON.stringify({...result,samples:undefined}));
  assert(lastFaces.every(count=>count===expected),`${name}: last four frames must contain ${expected} visible faces`);
}
try{
  await run('one-person',5000,one,1);
  await run('second-person-enters',5000,image,2);
  const hd=await sharp(image).resize({width:1920}).jpeg({quality:90}).toBuffer();
  await run('adaptive-resolution',5000,index=>index%2?hd:image,2);
  const adaptive=phases.at(-1).samples.filter(sample=>sample.personIds.every(id=>id!==null));
  assert(adaptive.length>=4,'Both people must have body IDs during adaptive resolution');
  assert.equal(new Set(adaptive.map(sample=>[...sample.personIds].sort().join(','))).size,1,'720p/1080p switches must preserve body IDs');
  for(const direction of ['left','right','up','down'])await run('camera-'+direction,2500,moved.get(direction),2);
  await run('empty-scene',3500,blank,0);
  await run('two-people-return',5000,image,2);
  await assert.rejects(engine.detectFrame(Buffer.from('invalid JPEG'),{sessionId:id}));
  await run('continues-after-bad-frame',2500,image,2);
  sessions.delete(id,engine);
  const freshId=sessions.create();const fresh=await sessions.detect(freshId,image,engine);sessions.delete(freshId,engine);
  const freshFaces=fresh.filter(t=>t.status==='visible'&&t.faceVisibility!=='unavailable'&&(t.faceBox||t.boxKind==='face')).length;
  assert.equal(freshFaces,2,'A session started after stop must detect both people again');
  const durations=phases.flatMap(p=>p.samples.map(s=>s.latencyMs)).sort((a,b)=>a-b);
  const report={complete:true,phases,invalidFrameRejected:true,continuedAfterInvalidFrame:true,newSessionAfterStop:true,
    newSessionFaceCount:freshFaces,
    p95ResponseMs:durations[Math.floor(durations.length*.95)],workerPrivateMemoryMaxMB:Math.max(...metrics.map(m=>m.privateMemoryMB??0)),
    scope:'Actual backend models and session evaluator, wall-clock streaming of prerecorded fixtures with translations in four directions. No physical camera, Pi, arbitrary-angle or biometric identity guarantee.'};
  await writeFile(resolve(work,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,phases:phases.map(({name,frames,lastFaces})=>({name,frames,lastFaces}))}));
}finally{sessions.delete(id,engine);await engine.close();}
